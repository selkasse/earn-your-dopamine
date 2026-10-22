const SETTINGS_KEY = "settings";
const CACHE_KEY = "githubActivityCache";
const REWARD_KEY = "rewardState";
const REFRESH_ALARM = "refresh-github-activity";
const ENFORCE_ALARM = "enforce-open-tabs";
const BADGE_ALARM = "update-badge";
const BADGE_YELLOW = "#f5b301";
const BADGE_RED = "#d93025";
const DEFAULT_WARN_MINUTES = 5;
const DEFAULT_URGENT_MINUTES = 1;
const REFRESH_INTERVAL_MINUTES = 5;
const REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MINUTES * 60 * 1000;
// While blocked, re-check quickly so a fresh push is noticed (60/hr API limit).
const BLOCKED_RECHECK_MS = 60 * 1000;
const FORCE_RECHECK_MIN_MS = 10 * 1000;

const navigationChecks = new Map();
const activityRefreshes = new Map();
let nextNavigationCheckId = 0;

async function getSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return stored[SETTINGS_KEY] ?? null;
}

function matchesBlockedDomain(hostname, domains) {
  const host = hostname.toLowerCase();
  return domains.some((domain) => {
    const normalized = domain.toLowerCase();
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

const UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000 };

function durationMs(value, unit, fallbackMinutes) {
  const amount = Number(value);
  return (Number.isFinite(amount) && amount > 0 ? amount : fallbackMinutes)
    * (UNIT_MS[unit] ?? UNIT_MS.minutes);
}

// "Last commit within" setting. Falls back to the legacy single-window setting.
function commitWithinMs(settings) {
  return durationMs(
    settings.commitWithin ?? settings.rewardLimit,
    settings.commitWithinUnit ?? settings.rewardUnit,
    30
  );
}

// "Reward lasts for" setting. Falls back to the legacy single-window setting.
function rewardDurationMs(settings) {
  return durationMs(
    settings.rewardDuration ?? settings.rewardLimit,
    settings.rewardDurationUnit ?? settings.rewardUnit,
    30
  );
}

function hasRecentPush(cache, settings, now = Date.now()) {
  return Number.isFinite(cache?.latestPushAt)
    && now - cache.latestPushAt >= 0
    && now - cache.latestPushAt <= commitWithinMs(settings);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

// Shows remaining reward minutes: hidden when there's plenty of time, yellow
// once <= the warning threshold, red once <= the urgent threshold.
async function updateBadge() {
  const settings = await getSettings();
  const reward = await getRewardState();
  const now = Date.now();

  if (!settings || !rewardActive(reward, settings, now)) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  const minutesLeft = Math.max(1, Math.ceil((reward.expiresAt - now) / UNIT_MS.minutes));
  const urgent = positiveNumber(settings.badgeUrgentMinutes, DEFAULT_URGENT_MINUTES);
  const warn = Math.max(positiveNumber(settings.badgeWarnMinutes, DEFAULT_WARN_MINUTES), urgent);

  if (minutesLeft > warn) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({
    color: minutesLeft <= urgent ? BADGE_RED : BADGE_YELLOW
  });
  await chrome.action.setBadgeText({ text: String(minutesLeft) });
}

function refreshBadge() {
  updateBadge().catch((error) => console.error("Could not update badge:", error));
}

async function getRewardState() {
  const stored = await chrome.storage.local.get(REWARD_KEY);
  return stored[REWARD_KEY] ?? null;
}

function rewardActive(reward, settings, now = Date.now()) {
  return reward?.username === settings.username
    && Number.isFinite(reward.expiresAt)
    && now < reward.expiresAt;
}

async function githubGet(path) {
  // GitHub sends max-age=300; bypass the browser cache so re-checks see new pushes.
  const response = await fetch(`https://api.github.com${path}`, {
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json" }
  });

  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      const resetAt = response.headers.get("x-ratelimit-reset");
      const resetMessage = resetAt
        ? ` Try again after ${new Date(Number(resetAt) * 1000).toLocaleTimeString()}.`
        : "";
      throw new Error(`GitHub API rate limit reached.${resetMessage}`);
    }
    if (response.status === 404) {
      throw new Error("GitHub username was not found.");
    }
    throw new Error(`GitHub API returned HTTP ${response.status}.`);
  }

  return response.json();
}

// Returns the newest push time (ms) from two sources: the events feed (the
// plan's source, but delayed by minutes) and the most recently pushed repo's
// pushed_at, which GitHub updates almost immediately.
async function fetchLatestPush(username) {
  const user = encodeURIComponent(username);
  const events = await githubGet(`/users/${user}/events/public`);
  if (!Array.isArray(events)) {
    throw new Error("GitHub returned an unexpected events response.");
  }

  const latestPush = events.find((event) =>
    event?.type === "PushEvent" && typeof event.created_at === "string"
  );
  const times = [latestPush ? Date.parse(latestPush.created_at) : NaN];

  try {
    const repos = await githubGet(`/users/${user}/repos?sort=pushed&per_page=1`);
    if (Array.isArray(repos) && repos[0]?.pushed_at) {
      times.push(Date.parse(repos[0].pushed_at));
    }
  } catch (error) {
    console.warn("Could not read repository push times:", error);
  }

  const valid = times.filter(Number.isFinite);
  return valid.length ? Math.max(...valid) : null;
}

async function getActivityCache() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  return stored[CACHE_KEY] ?? null;
}

async function refreshActivity(settings, { force = false } = {}) {
  const previousCache = await getActivityCache();
  const now = Date.now();

  if (previousCache?.username === settings.username
      && Number.isFinite(previousCache.lastCheckedAt)) {
    const age = now - previousCache.lastCheckedAt;
    const cooldown = force ? FORCE_RECHECK_MIN_MS
      : previousCache.lastError ? REFRESH_INTERVAL_MS
      : BLOCKED_RECHECK_MS;
    if (age < cooldown) return previousCache;
  }

  const inFlightRefresh = activityRefreshes.get(settings.username);
  if (inFlightRefresh) return inFlightRefresh;

  const refresh = (async () => {
    try {
      const latestPushAt = await fetchLatestPush(settings.username);
      const cache = {
        username: settings.username,
        latestPushAt,
        lastCheckedAt: now,
        lastError: null
      };
      await chrome.storage.local.set({ [CACHE_KEY]: cache });
      return cache;
    } catch (error) {
      const cache = {
        username: settings.username,
        latestPushAt: previousCache?.username === settings.username
          ? previousCache.latestPushAt
          : null,
        lastCheckedAt: now,
        lastError: error.message
      };
      await chrome.storage.local.set({ [CACHE_KEY]: cache });
      throw error;
    }
  })();
  activityRefreshes.set(settings.username, refresh);

  try {
    return await refresh;
  } finally {
    if (activityRefreshes.get(settings.username) === refresh) {
      activityRefreshes.delete(settings.username);
    }
  }
}

// An active reward needs no API call. Otherwise a push within the "last commit
// within" window earns a new reward, but each push can be redeemed only once.
async function checkEligibility(settings, options) {
  const reward = await getRewardState();
  if (rewardActive(reward, settings)) return { allowed: true, error: null };

  const cache = await refreshActivity(settings, options);
  const alreadyRedeemed = reward?.username === settings.username
    && Number.isFinite(reward.redeemedPushAt)
    && cache.latestPushAt <= reward.redeemedPushAt;

  if (hasRecentPush(cache, settings) && !alreadyRedeemed) {
    await chrome.storage.local.set({
      [REWARD_KEY]: {
        username: settings.username,
        expiresAt: Date.now() + rewardDurationMs(settings),
        redeemedPushAt: cache.latestPushAt
      }
    });
    refreshBadge();
    return { allowed: true, error: null };
  }
  return {
    allowed: false,
    error: cache.lastError,
    latestPushAt: cache.latestPushAt,
    alreadyRedeemed,
    commitWithinMs: commitWithinMs(settings)
  };
}

function blockedPageUrl({ site, target, error }) {
  const url = new URL(chrome.runtime.getURL("blocked.html"));
  if (site) url.searchParams.set("site", site);
  if (target) url.searchParams.set("target", target);
  if (error) url.searchParams.set("error", error);
  return url.href;
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;

  const requestId = ++nextNavigationCheckId;
  navigationChecks.set(details.tabId, requestId);

  let destination;
  try {
    destination = new URL(details.url);
  } catch (error) {
    navigationChecks.delete(details.tabId);
    console.error("Could not parse navigation URL:", error);
    return;
  }

  getSettings().then(async (settings) => {
    if (navigationChecks.get(details.tabId) !== requestId) return;
    if (!settings?.username || !Array.isArray(settings.domains)
        || !matchesBlockedDomain(destination.hostname, settings.domains)) {
      navigationChecks.delete(details.tabId);
      return;
    }

    let result;
    try {
      result = await checkEligibility(settings);
    } catch (error) {
      console.error("Could not check GitHub activity:", error);
      result = { allowed: false, error: error.message };
    }

    if (navigationChecks.get(details.tabId) !== requestId) return;
    navigationChecks.delete(details.tabId);
    if (result.allowed) return;

    try {
      await chrome.tabs.update(details.tabId, {
        url: blockedPageUrl({ site: destination.hostname, target: details.url, error: result.error })
      });
    } catch (error) {
      console.error(`Could not redirect tab ${details.tabId}:`, error);
    }
  }).catch((error) => {
    console.error("Could not load extension settings:", error);
  });
});

async function runScheduledRefresh() {
  const settings = await getSettings();
  if (!settings?.username) return;
  if (rewardActive(await getRewardState(), settings)) return;

  try {
    await refreshActivity(settings);
  } catch (error) {
    console.error("Scheduled GitHub activity check failed:", error);
  }
}

// Enabled unless the user explicitly turned it off in the options page.
function blockOpenTabsEnabled(settings) {
  return settings?.blockOpenTabs !== false;
}

// Runs inside the page (isolated world). Covers the page with the same blocked
// screen (markup and CSS come from blocked.html/blocked.css) instead of
// navigating away, so the site's session and in-flight requests are untouched.
// It lives in a shadow root so the site's styles can't affect it.
function toggleBlockOverlay(show, { markup, css, site } = {}) {
  const ID = "earn-your-dopamine-overlay";
  const existing = document.getElementById(ID);
  const hide = () => {
    document.getElementById(ID)?.remove();
    document.documentElement.style.removeProperty("overflow");
  };
  if (!show) return hide();
  if (existing) return;

  const host = document.createElement("div");
  host.id = ID;
  const root = host.attachShadow({ mode: "open" });

  // Constructed stylesheets aren't blocked by a page's CSP, unlike <style>.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    ":host{all:initial;position:fixed;inset:0;z-index:2147483647;display:block;overflow:auto}\n"
    + css.replace(":root", ":host").replace(/(^|\n)body \{/, "$1.page {")
  );
  root.adoptedStyleSheets = [sheet];

  const page = document.createElement("div");
  page.className = "page";
  page.innerHTML = markup;
  root.append(page);

  const context = root.querySelector("#context");
  const note = root.querySelector("#error");
  const button = root.querySelector("#recheck");
  const link = root.querySelector("a");
  if (site) context.textContent = `${site} is taking a break.`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";

  button.addEventListener("click", async () => {
    button.disabled = true;
    note.textContent = "Checking\u2026";
    try {
      const result = await chrome.runtime.sendMessage({ type: "recheck" });
      if (result?.allowed) return hide();
      const time = new Date().toLocaleTimeString();
      const withinMinutes = Math.round((result?.commitWithinMs ?? 0) / 60000);
      if (result?.error) {
        note.textContent = `We couldn't verify your GitHub activity: ${result.error}`;
      } else if (!Number.isFinite(result?.latestPushAt)) {
        note.textContent = `Checked at ${time}: no pushes found on your public GitHub activity.`;
      } else {
        const minutesAgo = Math.max(0, Math.round((Date.now() - result.latestPushAt) / 60000));
        note.textContent = result.alreadyRedeemed && minutesAgo <= withinMinutes
          ? `Checked at ${time}: your last push (${minutesAgo} min ago) already earned a reward. Push again for another.`
          : `Checked at ${time}: your last push was ${minutesAgo} min ago, outside your ${withinMinutes} min window. GitHub can take a minute to show new pushes.`;
      }
    } catch (error) {
      note.textContent = `Something went wrong: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });

  document.documentElement.append(host);
  document.documentElement.style.overflow = "hidden";
}

async function loadBlockedScreen() {
  const [html, css] = await Promise.all([
    fetch(chrome.runtime.getURL("blocked.html")).then((response) => response.text()),
    fetch(chrome.runtime.getURL("blocked.css")).then((response) => response.text())
  ]);
  return { markup: html.match(/<main>[\s\S]*<\/main>/)[0], css };
}

async function setOverlay(tab, show) {
  try {
    const screen = show ? await loadBlockedScreen() : {};
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: toggleBlockOverlay,
      args: [show, { ...screen, site: new URL(tab.url).hostname }]
    });
  } catch (error) {
    console.error(`Could not update overlay on tab ${tab.id}:`, error);
  }
}

// Blocks already-open tabs on blocked domains once the reward window has
// expired, so the user doesn't have to refresh first.
async function enforceOpenTabs() {
  const settings = await getSettings();
  if (!settings?.username || !Array.isArray(settings.domains)
      || !settings.domains.length || !blockOpenTabsEnabled(settings)) {
    return;
  }

  const tabs = await chrome.tabs.query({});
  const blockedTabs = tabs.filter((tab) => {
    try {
      return tab.id !== undefined && tab.url
        && /^https?:$/.test(new URL(tab.url).protocol)
        && matchesBlockedDomain(new URL(tab.url).hostname, settings.domains);
    } catch {
      return false;
    }
  });
  if (!blockedTabs.length) return;

  let result;
  try {
    result = await checkEligibility(settings);
  } catch (error) {
    console.error("Could not check GitHub activity for open tabs:", error);
    // Don't kick the user out of open tabs just because the API check failed.
    return;
  }

  // Lift any overlay once a push is found; otherwise cover the open tabs.
  await Promise.all(blockedTabs.map((tab) => setOverlay(tab, !result.allowed)));
}

function configureRefreshAlarm() {
  chrome.alarms.create(REFRESH_ALARM, {
    delayInMinutes: REFRESH_INTERVAL_MINUTES,
    periodInMinutes: REFRESH_INTERVAL_MINUTES
  });
  chrome.alarms.create(ENFORCE_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  chrome.alarms.create(BADGE_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  refreshBadge();
}

chrome.runtime.onInstalled.addListener(configureRefreshAlarm);
chrome.runtime.onStartup.addListener(configureRefreshAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) {
    runScheduledRefresh().catch((error) => {
      console.error("Could not run scheduled GitHub activity check:", error);
    });
  }
  if (alarm.name === BADGE_ALARM) refreshBadge();
  if (alarm.name === ENFORCE_ALARM) {
    enforceOpenTabs().catch((error) => {
      console.error("Could not enforce blocking on open tabs:", error);
    });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes[SETTINGS_KEY]) return;
  configureRefreshAlarm();
});

// The blocked page asks for a fresh check after the user pushes code.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "recheck") return;

  getSettings().then(async (settings) => {
    if (!settings?.username) return { allowed: false, error: "No GitHub username is configured." };
    try {
      return await checkEligibility(settings, { force: true });
    } catch (error) {
      return { allowed: false, error: error.message };
    }
  }).then(sendResponse);
  return true;
});
