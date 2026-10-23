const SETTINGS_KEY = "settings";
const CACHE_KEY = "githubActivityCache";
const REWARD_KEY = "rewardState";
const REFRESH_ALARM = "refresh-github-activity";
const ENFORCE_ALARM = "enforce-open-tabs";
const BADGE_ALARM = "update-badge";
const REWARD_END_ALARM = "reward-ended";
// The events feed and a repo's pushed_at stamp the same push a few seconds
// apart; keep this small so a genuinely new push is recognized right away.
const SAME_PUSH_TOLERANCE_MS = 15 * 1000;
const BADGE_YELLOW = "#f5b301";
const BADGE_RED = "#d93025";
const DEFAULT_WARN_MINUTES = 5;
const DEFAULT_URGENT_MINUTES = 1;
const REFRESH_INTERVAL_MINUTES = 5;
const REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MINUTES * 60 * 1000;
// While blocked, re-check quickly so a fresh push is noticed.
const BLOCKED_RECHECK_MS = 60 * 1000;
const FORCE_RECHECK_MIN_MS = 10 * 1000;
const GITHUB_CLIENT_ID = "Ov23liZxjhzp9mZG4Sk7";
const AUTH_KEY = "githubAuth";
const DEVICE_FLOW_KEY = "githubDeviceFlow";
const RATE_LIMIT_KEY = "githubRateLimit";
const ETAG_KEY = "githubEtags";
const DEVICE_POLL_ALARM = "device-flow-poll";
const MAX_ETAG_ENTRIES = 20;

const navigationChecks = new Map();
const activityRefreshes = new Map();
let nextNavigationCheckId = 0;

async function getSettings() {
  const [settings, auth] = await Promise.all([
    chrome.storage.sync.get(SETTINGS_KEY),
    chrome.storage.local.get(AUTH_KEY),
  ]);
  if (!settings[SETTINGS_KEY]) return null;
  return {
    ...settings[SETTINGS_KEY],
    username: auth[AUTH_KEY]?.username ?? null,
  };
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
  return (
    (Number.isFinite(amount) && amount > 0 ? amount : fallbackMinutes) *
    (UNIT_MS[unit] ?? UNIT_MS.minutes)
  );
}

// "Last commit within" setting. Falls back to the legacy single-window setting.
function commitWithinMs(settings) {
  return durationMs(
    settings.commitWithin ?? settings.rewardLimit,
    settings.commitWithinUnit ?? settings.rewardUnit,
    30,
  );
}

// "Reward lasts for" setting. Falls back to the legacy single-window setting.
function rewardDurationMs(settings) {
  return durationMs(
    settings.rewardDuration ?? settings.rewardLimit,
    settings.rewardDurationUnit ?? settings.rewardUnit,
    30,
  );
}

function hasRecentPush(cache, settings, now = Date.now()) {
  return (
    Number.isFinite(cache?.latestPushAt) &&
    now - cache.latestPushAt >= 0 &&
    now - cache.latestPushAt <= commitWithinMs(settings)
  );
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isBlockedTab(tab, settings) {
  try {
    return (
      tab.id !== undefined &&
      Boolean(tab.url) &&
      /^https?:$/.test(new URL(tab.url).protocol) &&
      matchesBlockedDomain(new URL(tab.url).hostname, settings.domains)
    );
  } catch {
    return false;
  }
}

// Runs inside the page (isolated world). Draws a banner at the top of the page
// while the reward is within the warning threshold: yellow, then red. It keeps
// itself up to date from expiresAt, so it stays accurate between alarm ticks.
function renderRewardBanner(state) {
  const ID = "earn-your-dopamine-banner";
  clearInterval(window.__earnYourDopamineTimer);
  document.getElementById(ID)?.remove();
  if (!state) return;

  const host = document.createElement("div");
  host.id = ID;
  const root = host.attachShadow({ mode: "open" });
  const bar = document.createElement("div");
  bar.setAttribute("role", "status");
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(
    ".bar{all:initial;position:fixed;left:0;right:0;z-index:2147483646;" +
      "box-sizing:border-box;padding:8px 16px;text-align:center;" +
      "font:600 14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}" +
      ".top{top:0;box-shadow:0 2px 8px rgb(0 0 0 / 25%)}" +
      ".bottom{bottom:0;box-shadow:0 -2px 8px rgb(0 0 0 / 25%)}" +
      ".yellow{background:#f5b301;color:#2b2100}" +
      ".red{background:#d93025;color:#fff}",
  );
  root.adoptedStyleSheets = [sheet];
  root.append(bar);

  const tick = () => {
    const minutesLeft = Math.ceil((state.expiresAt - Date.now()) / 60000);
    if (minutesLeft <= 0) {
      clearInterval(window.__earnYourDopamineTimer);
      host.remove();
      return;
    }
    if (minutesLeft > state.warn) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "";
    bar.className = `bar ${state.position} ${minutesLeft <= state.urgent ? "red" : "yellow"}`;
    bar.textContent =
      `Earn Your Dopamine: ${minutesLeft} min of reward time left. ` +
      "Push some code to earn more.";
  };
  tick();
  document.documentElement.append(host);
  window.__earnYourDopamineTimer = setInterval(tick, 1000);
}

// Adds, updates or removes the banner on every blocked-site tab (or one tab).
async function updateBanners(onlyTab) {
  const settings = await getSettings();
  if (!settings || !Array.isArray(settings.domains)) return;

  const reward = await getRewardState();
  const active = rewardActive(reward, settings);
  const urgent = positiveNumber(
    settings.badgeUrgentMinutes,
    DEFAULT_URGENT_MINUTES,
  );
  // Both warnings are on by default; the banner sits at the bottom by default.
  const state =
    active && settings.bannerEnabled !== false
      ? {
          position: settings.bannerPosition === "top" ? "top" : "bottom",
          expiresAt: reward.expiresAt,
          urgent,
          warn: Math.max(
            positiveNumber(settings.badgeWarnMinutes, DEFAULT_WARN_MINUTES),
            urgent,
          ),
        }
      : null;

  const tabs = onlyTab ? [onlyTab] : await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => isBlockedTab(tab, settings))
      .map(async (tab) => {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: renderRewardBanner,
            args: [state],
          });
        } catch (error) {
          console.error(`Could not update banner on tab ${tab.id}:`, error);
        }
      }),
  );
}

// Shows remaining reward minutes: hidden when there's plenty of time, yellow
// once <= the warning threshold, red once <= the urgent threshold.
async function updateBadge() {
  const settings = await getSettings();
  const reward = await getRewardState();
  const now = Date.now();

  if (
    !settings ||
    !rewardActive(reward, settings, now) ||
    settings.badgeEnabled === false
  ) {
    await chrome.alarms.clear(BADGE_ALARM);
    await chrome.action.setBadgeText({ text: "" });
    return;
  }

  const minutesLeft = Math.max(
    1,
    Math.ceil((reward.expiresAt - now) / UNIT_MS.minutes),
  );
  // Wake exactly when the displayed minute changes so the badge matches the
  // banner, which derives its count from the same expiry time.
  chrome.alarms.create(BADGE_ALARM, {
    when: reward.expiresAt - (minutesLeft - 1) * UNIT_MS.minutes + 500,
  });
  const urgent = positiveNumber(
    settings.badgeUrgentMinutes,
    DEFAULT_URGENT_MINUTES,
  );
  const warn = Math.max(
    positiveNumber(settings.badgeWarnMinutes, DEFAULT_WARN_MINUTES),
    urgent,
  );

  if (minutesLeft > warn) {
    await chrome.action.setBadgeText({ text: "" });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({
    color: minutesLeft <= urgent ? BADGE_RED : BADGE_YELLOW,
  });
  await chrome.action.setBadgeText({ text: String(minutesLeft) });
}

// Fires right when the reward runs out so open tabs are blocked immediately.
async function scheduleRewardEnd() {
  const reward = await getRewardState();
  if (Number.isFinite(reward?.expiresAt) && reward.expiresAt > Date.now()) {
    chrome.alarms.create(REWARD_END_ALARM, { when: reward.expiresAt + 1000 });
  }
}

function refreshBadge() {
  updateBadge().catch((error) =>
    console.error("Could not update badge:", error),
  );
  updateBanners().catch((error) =>
    console.error("Could not update banners:", error),
  );
}

async function getRewardState() {
  const stored = await chrome.storage.local.get(REWARD_KEY);
  return stored[REWARD_KEY] ?? null;
}

function rewardActive(reward, settings, now = Date.now()) {
  return (
    reward?.username === settings.username &&
    Number.isFinite(reward.expiresAt) &&
    now < reward.expiresAt
  );
}

async function getAuthToken() {
  const stored = await chrome.storage.local.get(AUTH_KEY);
  return stored[AUTH_KEY]?.token ?? null;
}

function formatResetTime(untilMs) {
  return new Date(untilMs).toLocaleTimeString();
}

function rateLimitError(untilMs) {
  return new Error(
    `GitHub API rate limit reached. Try again after ${formatResetTime(untilMs)}.`,
  );
}

async function githubGet(path, { retryUnauthenticated = true } = {}) {
  const token = await getAuthToken();
  const authed = Boolean(token);

  // Don't spend requests that GitHub will reject until the limit resets.
  const stored = await chrome.storage.local.get([RATE_LIMIT_KEY, ETAG_KEY]);
  const limit = stored[RATE_LIMIT_KEY];
  if (limit && limit.authed === authed && Date.now() < limit.until) {
    throw rateLimitError(limit.until);
  }

  // Conditional requests that return 304 don't count against the rate limit.
  const etags = stored[ETAG_KEY] ?? {};
  const cached = etags[`${authed}:${path}`];
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cached) headers["If-None-Match"] = cached.etag;

  // GitHub sends max-age=300; bypass the browser cache so re-checks see new pushes.
  const response = await fetch(`https://api.github.com${path}`, {
    cache: "no-store",
    headers,
  });

  if (response.status === 304 && cached) return cached.body;

  if (!response.ok) {
    if (response.status === 401 && token) {
      // Revoked or invalid token: drop it and fall back to anonymous access.
      await chrome.storage.local.remove(AUTH_KEY);
      if (retryUnauthenticated)
        return githubGet(path, { retryUnauthenticated: false });
    }
    const limited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after")));
    if (limited) {
      const resetAt = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      const retryAfter = Number(response.headers.get("retry-after")) * 1000;
      const until =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Date.now() + retryAfter
          : Number.isFinite(resetAt) && resetAt > Date.now()
            ? resetAt
            : Date.now() + 60 * 1000;
      await chrome.storage.local.set({ [RATE_LIMIT_KEY]: { until, authed } });
      throw rateLimitError(until);
    }
    if (response.status === 403) {
      throw new Error("GitHub denied the request (HTTP 403).");
    }
    if (response.status === 404) {
      throw new Error("GitHub username was not found.");
    }
    throw new Error(`GitHub API returned HTTP ${response.status}.`);
  }

  await chrome.storage.local.remove(RATE_LIMIT_KEY);
  const body = await response.json();
  const etag = response.headers.get("etag");
  if (etag) {
    etags[`${authed}:${path}`] = { etag, body };
    const keys = Object.keys(etags);
    for (const key of keys.slice(
      0,
      Math.max(0, keys.length - MAX_ETAG_ENTRIES),
    ))
      delete etags[key];
    await chrome.storage.local.set({ [ETAG_KEY]: etags });
  }
  return body;
}

async function githubForm(url, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
  return response.json();
}

// OAuth device flow: no client secret is needed, so it's safe in an extension.
async function startDeviceFlow() {
  const data = await githubForm("https://github.com/login/device/code", {
    client_id: GITHUB_CLIENT_ID,
    scope: "read:user",
  });
  if (!data.device_code) {
    throw new Error(
      data.error_description || "Could not start GitHub sign-in.",
    );
  }
  await chrome.storage.local.set({
    [DEVICE_FLOW_KEY]: {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresAt: Date.now() + data.expires_in * 1000,
      interval: Math.max(5, Number(data.interval) || 5),
      error: null,
    },
  });
  scheduleDevicePoll();
  return { userCode: data.user_code, verificationUri: data.verification_uri };
}

let devicePollTimer = null;

// setTimeout gives prompt polling; the alarm revives it if the worker is suspended.
async function scheduleDevicePoll() {
  clearTimeout(devicePollTimer);
  const stored = await chrome.storage.local.get(DEVICE_FLOW_KEY);
  const flow = stored[DEVICE_FLOW_KEY];
  if (!flow || flow.error) return;
  devicePollTimer = setTimeout(() => {
    pollDeviceFlow().catch((error) =>
      console.error("Device flow poll failed:", error),
    );
  }, flow.interval * 1000);
  chrome.alarms.create(DEVICE_POLL_ALARM, { delayInMinutes: 0.5 });
}

async function pollDeviceFlow() {
  const stored = await chrome.storage.local.get(DEVICE_FLOW_KEY);
  const flow = stored[DEVICE_FLOW_KEY];
  if (!flow || flow.error) return;

  const fail = async (message) => {
    await chrome.storage.local.set({
      [DEVICE_FLOW_KEY]: { ...flow, error: message },
    });
    chrome.alarms.clear(DEVICE_POLL_ALARM);
  };
  if (Date.now() >= flow.expiresAt)
    return fail("The sign-in code expired. Please try again.");

  let data;
  try {
    data = await githubForm("https://github.com/login/oauth/access_token", {
      client_id: GITHUB_CLIENT_ID,
      device_code: flow.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  } catch (error) {
    return scheduleDevicePoll();
  }

  if (data.access_token) {
    let account;
    try {
      const response = await fetch("https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${data.access_token}`,
        },
      });
      if (!response.ok) {
        throw new Error(`GitHub returned HTTP ${response.status} while loading your account.`);
      }
      account = await response.json();
      if (typeof account.login !== "string" || !account.login) {
        throw new Error("GitHub did not return an account username.");
      }
    } catch (error) {
      return fail(`Couldn't load your GitHub account: ${error.message}`);
    }
    await chrome.storage.local.set({
      [AUTH_KEY]: { token: data.access_token, username: account.login },
    });
    await chrome.storage.local.remove([DEVICE_FLOW_KEY, RATE_LIMIT_KEY]);
    chrome.alarms.clear(DEVICE_POLL_ALARM);
    return;
  }
  if (data.error === "slow_down") {
    await chrome.storage.local.set({
      [DEVICE_FLOW_KEY]: {
        ...flow,
        interval: Number(data.interval) || flow.interval + 5,
      },
    });
    return scheduleDevicePoll();
  }
  if (data.error === "authorization_pending") return scheduleDevicePoll();
  if (data.error === "access_denied") return fail("Sign-in was cancelled.");
  if (data.error === "expired_token")
    return fail("The sign-in code expired. Please try again.");
  return fail(data.error_description || "GitHub sign-in failed.");
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

  const latestPush = events.find(
    (event) =>
      event?.type === "PushEvent" && typeof event.created_at === "string",
  );
  const times = [latestPush ? Date.parse(latestPush.created_at) : NaN];

  try {
    const repos = await githubGet(
      `/users/${user}/repos?sort=pushed&per_page=1`,
    );
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

  if (
    previousCache?.username === settings.username &&
    Number.isFinite(previousCache.lastCheckedAt)
  ) {
    const age = now - previousCache.lastCheckedAt;
    const cooldown = force
      ? FORCE_RECHECK_MIN_MS
      : previousCache.lastError
        ? REFRESH_INTERVAL_MS
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
        lastError: null,
      };
      await chrome.storage.local.set({ [CACHE_KEY]: cache });
      return cache;
    } catch (error) {
      const cache = {
        username: settings.username,
        latestPushAt:
          previousCache?.username === settings.username
            ? previousCache.latestPushAt
            : null,
        lastCheckedAt: now,
        lastError: error.message,
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
  if (!settings?.username) {
    return {
      allowed: false,
      error: "Sign in with GitHub in the extension settings to check your activity.",
    };
  }

  const reward = await getRewardState();
  if (rewardActive(reward, settings)) return { allowed: true, error: null };

  const cache = await refreshActivity(settings, options);
  const alreadyRedeemed =
    reward?.username === settings.username &&
    Number.isFinite(reward.redeemedPushAt) &&
    Number.isFinite(cache?.latestPushAt) &&
    cache.latestPushAt <= reward.redeemedPushAt + SAME_PUSH_TOLERANCE_MS;

  if (hasRecentPush(cache, settings) && !alreadyRedeemed) {
    await chrome.storage.local.set({
      [REWARD_KEY]: {
        username: settings.username,
        expiresAt: Date.now() + rewardDurationMs(settings),
        redeemedPushAt: cache.latestPushAt,
      },
    });
    scheduleRewardEnd();
    refreshBadge();
    return { allowed: true, error: null };
  }
  return {
    allowed: false,
    error: cache.lastError,
    latestPushAt: cache.latestPushAt,
    alreadyRedeemed,
    commitWithinMs: commitWithinMs(settings),
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

  getSettings()
    .then(async (settings) => {
      if (navigationChecks.get(details.tabId) !== requestId) return;
      if (
        !settings ||
        !Array.isArray(settings.domains) ||
        !matchesBlockedDomain(destination.hostname, settings.domains)
      ) {
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
          url: blockedPageUrl({
            site: destination.hostname,
            target: details.url,
            error: result.error,
          }),
        });
      } catch (error) {
        console.error(`Could not redirect tab ${details.tabId}:`, error);
      }
    })
    .catch((error) => {
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
    ":host{all:initial;position:fixed;inset:0;z-index:2147483647;display:block;overflow:auto}\n" +
      css.replace(":root", ":host").replace(/(^|\n)body \{/, "$1.page {"),
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
      const runtime = globalThis.chrome?.runtime;
      if (typeof runtime?.sendMessage !== "function") {
        console.error("Chrome runtime API is unavailable.");
        note.textContent =
          "The extension connection is unavailable. Refresh this page and try again.";
        return;
      }

      // The service worker may be waking up, which can yield an empty reply.
      let result = await runtime.sendMessage({ type: "recheck" });
      if (!result)
        result = await runtime.sendMessage({ type: "recheck" });
      if (!result)
        throw new Error("No response from the extension. Try again.");
      if (result.allowed) return hide();
      const time = new Date().toLocaleTimeString();
      const withinMinutes = Math.round((result?.commitWithinMs ?? 0) / 60000);
      if (result?.error) {
        note.textContent = `We couldn't verify your GitHub activity: ${result.error}`;
      } else if (!Number.isFinite(result?.latestPushAt)) {
        note.textContent = `Checked at ${time}: no pushes found on your public GitHub activity.`;
      } else {
        const minutesAgo = Math.max(
          0,
          Math.round((Date.now() - result.latestPushAt) / 60000),
        );
        note.textContent =
          result.alreadyRedeemed && minutesAgo <= withinMinutes
            ? `Checked at ${time}: your last push (${minutesAgo} min ago) already earned a reward. Push again for another.`
            : `Checked at ${time}: your last push was ${minutesAgo} min ago, outside your ${withinMinutes} min window. GitHub can take a minute to show new pushes.`;
      }
    } catch (error) {
      note.textContent = `Something went wrong: ${error?.message || "please reload the page."}`;
    } finally {
      button.disabled = false;
    }
  });

  document.documentElement.append(host);
  document.documentElement.style.overflow = "hidden";
}

async function loadBlockedScreen() {
  const [html, css] = await Promise.all([
    fetch(chrome.runtime.getURL("blocked.html")).then((response) =>
      response.text(),
    ),
    fetch(chrome.runtime.getURL("blocked.css")).then((response) =>
      response.text(),
    ),
  ]);
  return { markup: html.match(/<main>[\s\S]*<\/main>/)[0], css };
}

async function setOverlay(tab, show) {
  try {
    const screen = show ? await loadBlockedScreen() : {};
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: toggleBlockOverlay,
      args: [show, { ...screen, site: new URL(tab.url).hostname }],
    });
  } catch (error) {
    console.error(`Could not update overlay on tab ${tab.id}:`, error);
  }
}

// Blocks already-open tabs on blocked domains once the reward window has
// expired, so the user doesn't have to refresh first.
async function enforceOpenTabs() {
  const settings = await getSettings();
  if (
    !settings ||
    !Array.isArray(settings.domains) ||
    !settings.domains.length ||
    !blockOpenTabsEnabled(settings)
  ) {
    return;
  }

  const tabs = await chrome.tabs.query({});
  const blockedTabs = tabs.filter((tab) => isBlockedTab(tab, settings));
  if (!blockedTabs.length) return;

  let result;
  try {
    result = await checkEligibility(settings);
  } catch (error) {
    // Like navigation, an unverifiable reward counts as not earned.
    console.error("Could not check GitHub activity for open tabs:", error);
    result = { allowed: false };
  }

  // Lift any overlay once a push is found; otherwise cover the open tabs.
  await Promise.all(blockedTabs.map((tab) => setOverlay(tab, !result.allowed)));
}

function configureRefreshAlarm() {
  chrome.alarms.create(REFRESH_ALARM, {
    delayInMinutes: REFRESH_INTERVAL_MINUTES,
    periodInMinutes: REFRESH_INTERVAL_MINUTES,
  });
  chrome.alarms.create(ENFORCE_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: 1,
  });
  scheduleRewardEnd();
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
  if (alarm.name === DEVICE_POLL_ALARM) {
    pollDeviceFlow().catch((error) =>
      console.error("Device flow poll failed:", error),
    );
  }
  if (alarm.name === ENFORCE_ALARM || alarm.name === REWARD_END_ALARM) {
    if (alarm.name === REWARD_END_ALARM) refreshBadge();
    enforceOpenTabs().catch((error) => {
      console.error("Could not enforce blocking on open tabs:", error);
    });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes[SETTINGS_KEY]) return;
  configureRefreshAlarm();
});

// Pages loaded during a reward get the banner too.
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  chrome.tabs
    .get(details.tabId)
    .then((tab) => updateBanners(tab))
    .catch((error) =>
      console.error("Could not add banner to new page:", error),
    );
});

// The blocked page asks for a fresh check after the user pushes code.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "startSignIn") {
    startDeviceFlow()
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ error: error?.message || String(error) }),
      );
    return true;
  }
  if (message?.type === "cancelSignIn") {
    clearTimeout(devicePollTimer);
    chrome.alarms.clear(DEVICE_POLL_ALARM);
    chrome.storage.local.remove(DEVICE_FLOW_KEY).then(() => sendResponse({}));
    return true;
  }
  if (message?.type === "signOut") {
    chrome.storage.local
      .remove([AUTH_KEY, RATE_LIMIT_KEY, ETAG_KEY])
      .then(() => sendResponse({}));
    return true;
  }
  if (message?.type !== "recheck") return;

  (async () => {
    try {
      const settings = await getSettings();
      if (!settings) return { allowed: false, error: "Extension settings are not available." };
      if (!settings.username) {
        return {
          allowed: false,
          error: "Sign in with GitHub in the extension settings to check your activity.",
        };
      }
      return await checkEligibility(settings, { force: true });
    } catch (error) {
      return { allowed: false, error: error?.message || String(error) };
    }
  })().then(sendResponse);
  return true;
});
