const SETTINGS_KEY = "settings";
const CACHE_KEY = "githubActivityCache";
const REFRESH_ALARM = "refresh-github-activity";
const REFRESH_INTERVAL_MINUTES = 5;
const REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MINUTES * 60 * 1000;

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

async function fetchLatestPush(username) {
  const response = await fetch(
    `https://api.github.com/users/${encodeURIComponent(username)}/events/public`,
    { headers: { Accept: "application/vnd.github+json" } }
  );

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

  const events = await response.json();
  if (!Array.isArray(events)) {
    throw new Error("GitHub returned an unexpected events response.");
  }

  const latestPush = events.find((event) =>
    event?.type === "PushEvent" && typeof event.created_at === "string"
  );
  const timestamp = latestPush ? Date.parse(latestPush.created_at) : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function getActivityCache() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  return stored[CACHE_KEY] ?? null;
}

async function refreshActivity(settings, { force = false } = {}) {
  const previousCache = await getActivityCache();
  const now = Date.now();

  if (!force && previousCache?.username === settings.username
      && Number.isFinite(previousCache.lastCheckedAt)
      && now - previousCache.lastCheckedAt < REFRESH_INTERVAL_MS) {
    return previousCache;
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

async function checkEligibility(settings) {
  const cache = await refreshActivity(settings);
  const allowed = hasRecentPush(cache, settings);
  return { allowed, error: allowed ? null : cache.lastError };
}

function blockedPageUrl({ site, error }) {
  const url = new URL(chrome.runtime.getURL("blocked.html"));
  if (site) url.searchParams.set("site", site);
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
        url: blockedPageUrl({ site: destination.hostname, error: result.error })
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

function configureRefreshAlarm() {
  chrome.alarms.create(REFRESH_ALARM, {
    delayInMinutes: REFRESH_INTERVAL_MINUTES,
    periodInMinutes: REFRESH_INTERVAL_MINUTES
  });
}

chrome.runtime.onInstalled.addListener(configureRefreshAlarm);
chrome.runtime.onStartup.addListener(configureRefreshAlarm);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) {
    runScheduledRefresh().catch((error) => {
      console.error("Could not run scheduled GitHub activity check:", error);
    });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes[SETTINGS_KEY]) return;
  configureRefreshAlarm();
});
