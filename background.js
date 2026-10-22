const SETTINGS_KEY = "settings";
const CACHE_KEY = "githubActivityCache";
const REFRESH_ALARM = "refresh-github-activity";
const ENFORCE_ALARM = "enforce-open-tabs";
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

function rewardWindowMs(settings) {
  const multiplier = settings.rewardUnit === "hours" ? 60 * 60 * 1000 : 60 * 1000;
  return Number(settings.rewardLimit) * multiplier;
}

function hasRecentPush(cache, settings, now = Date.now()) {
  return Number.isFinite(cache?.latestPushAt)
    && now - cache.latestPushAt >= 0
    && now - cache.latestPushAt <= rewardWindowMs(settings);
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
      : hasRecentPush(previousCache, settings, now) ? REFRESH_INTERVAL_MS
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

async function checkEligibility(settings, options) {
  const cache = await refreshActivity(settings, options);
  const allowed = hasRecentPush(cache, settings);
  return { allowed, error: allowed ? null : cache.lastError };
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

// Runs inside the page (isolated world). Covers the page with a message instead
// of navigating away, so the site's session and in-flight requests are untouched.
function toggleBlockOverlay(show) {
  const ID = "earn-your-dopamine-overlay";
  const existing = document.getElementById(ID);
  if (!show) {
    existing?.remove();
    document.documentElement.style.removeProperty("overflow");
    return;
  }
  if (existing) return;

  const overlay = document.createElement("div");
  overlay.id = ID;
  overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;"
    + "flex-direction:column;align-items:center;justify-content:center;gap:16px;"
    + "background:#102018;color:#f4f7f5;font-family:-apple-system,BlinkMacSystemFont,sans-serif;"
    + "text-align:center;padding:24px";

  const title = document.createElement("h1");
  title.textContent = "No commits detected.";
  title.style.cssText = "margin:0;font-size:clamp(36px,8vw,64px);color:#f4f7f5";
  const text = document.createElement("p");
  text.textContent = "Go push some code, then come back for your reward.";
  text.style.cssText = "margin:0;font-size:19px;color:#bfccc3";
  const note = document.createElement("p");
  note.style.cssText = "margin:0;font-size:14px;color:#ffb4a9";
  const button = document.createElement("button");
  button.textContent = "I pushed \u2014 check again";
  button.style.cssText = "padding:13px 20px;border:0;border-radius:8px;background:#a4e7bb;"
    + "color:#102018;font:700 16px sans-serif;cursor:pointer";
  button.addEventListener("click", async () => {
    button.disabled = true;
    note.textContent = "";
    try {
      const result = await chrome.runtime.sendMessage({ type: "recheck" });
      if (result?.allowed) {
        overlay.remove();
        document.documentElement.style.removeProperty("overflow");
        return;
      }
      note.textContent = result?.error
        ? `We couldn't verify your GitHub activity: ${result.error}`
        : "Still no recent push found. GitHub can take a minute to show new activity.";
    } finally {
      button.disabled = false;
    }
  });

  overlay.append(title, text, note, button);
  document.documentElement.append(overlay);
  document.documentElement.style.overflow = "hidden";
}

async function setOverlay(tabId, show) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: toggleBlockOverlay,
      args: [show]
    });
  } catch (error) {
    console.error(`Could not update overlay on tab ${tabId}:`, error);
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
  await Promise.all(blockedTabs.map((tab) => setOverlay(tab.id, !result.allowed)));
}

function configureRefreshAlarm() {
  chrome.alarms.create(REFRESH_ALARM, {
    delayInMinutes: REFRESH_INTERVAL_MINUTES,
    periodInMinutes: REFRESH_INTERVAL_MINUTES
  });
  chrome.alarms.create(ENFORCE_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(configureRefreshAlarm);
chrome.runtime.onStartup.addListener(configureRefreshAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) {
    runScheduledRefresh().catch((error) => {
      console.error("Could not run scheduled GitHub activity check:", error);
    });
  }
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
