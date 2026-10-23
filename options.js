const SETTINGS_KEY = "settings";

const form = document.querySelector("#settings-form");
const domainsInput = document.querySelector("#domains");
const commitWithinInput = document.querySelector("#commit-within");
const commitWithinUnitInput = document.querySelector("#commit-within-unit");
const rewardDurationInput = document.querySelector("#reward-duration");
const rewardDurationUnitInput = document.querySelector("#reward-duration-unit");
const blockOpenTabsInput = document.querySelector("#block-open-tabs");
const badgeWarnInput = document.querySelector("#badge-warn");
const badgeUrgentInput = document.querySelector("#badge-urgent");
const badgeEnabledInput = document.querySelector("#badge-enabled");
const bannerEnabledInput = document.querySelector("#banner-enabled");
const bannerPositionInput = document.querySelector("#banner-position");
const status = document.querySelector("#status");

function parseDomains(value) {
  const domains = value.split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);

  for (const domain of domains) {
    if (domain.includes("://") || domain.includes("/") || domain.includes(":")) {
      throw new Error(`Enter domains only, without a scheme or path: ${domain}`);
    }

    let hostname;
    try {
      hostname = new URL(`http://${domain}`).hostname;
    } catch {
      throw new Error(`That doesn't look like a valid domain: ${domain}`);
    }

    if (hostname !== domain || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(domain)) {
      throw new Error(`That doesn't look like a valid domain: ${domain}`);
    }
  }

  return [...new Set(domains)];
}

function domainOrigins(domains) {
  return domains.flatMap((domain) => [
    `http://${domain}/*`,
    `https://${domain}/*`,
    `http://*.${domain}/*`,
    `https://*.${domain}/*`
  ]);
}

function showStatus(message, isError = false) {
  status.textContent = message;
  status.dataset.error = String(isError);
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  const settings = stored[SETTINGS_KEY];
  if (!settings) return;

  domainsInput.value = (settings.domains ?? []).join(", ");
  // Older versions stored a single window in rewardLimit/rewardUnit.
  commitWithinInput.value = settings.commitWithin ?? settings.rewardLimit ?? 30;
  commitWithinUnitInput.value = settings.commitWithinUnit ?? settings.rewardUnit ?? "minutes";
  rewardDurationInput.value = settings.rewardDuration ?? settings.rewardLimit ?? 30;
  rewardDurationUnitInput.value = settings.rewardDurationUnit ?? settings.rewardUnit ?? "minutes";
  badgeWarnInput.value = settings.badgeWarnMinutes ?? 5;
  badgeUrgentInput.value = settings.badgeUrgentMinutes ?? 1;
  badgeEnabledInput.checked = settings.badgeEnabled !== false;
  bannerEnabledInput.checked = settings.bannerEnabled !== false;
  bannerPositionInput.value = settings.bannerPosition === "top" ? "top" : "bottom";
  bannerPositionInput.disabled = !bannerEnabledInput.checked;
  blockOpenTabsInput.checked = settings.blockOpenTabs !== false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showStatus("");

  try {
    const domains = parseDomains(domainsInput.value);
    const commitWithin = Number(commitWithinInput.value);
    const commitWithinUnit = commitWithinUnitInput.value;
    const rewardDuration = Number(rewardDurationInput.value);
    const rewardDurationUnit = rewardDurationUnitInput.value;
    const badgeWarnMinutes = Number(badgeWarnInput.value);
    const badgeUrgentMinutes = Number(badgeUrgentInput.value);
    const badgeEnabled = badgeEnabledInput.checked;
    const bannerEnabled = bannerEnabledInput.checked;
    const bannerPosition = bannerPositionInput.value === "top" ? "top" : "bottom";
    const blockOpenTabs = blockOpenTabsInput.checked;

    if (!Number.isFinite(commitWithin) || commitWithin < 1) {
      throw new Error("The commit window must be at least 1 minute.");
    }
    if (!Number.isFinite(rewardDuration) || rewardDuration < 1) {
      throw new Error("The reward duration must be at least 1 minute.");
    }

    if (!Number.isInteger(badgeWarnMinutes) || !Number.isInteger(badgeUrgentMinutes)
        || badgeUrgentMinutes < 1) {
      throw new Error("Warning thresholds must be whole numbers of at least 1 minute.");
    }
    if (badgeUrgentMinutes >= badgeWarnMinutes) {
      throw new Error("The red warning time must be lower than the yellow warning time.");
    }

    await chrome.storage.sync.set({
      [SETTINGS_KEY]: {
        domains, blockOpenTabs, badgeWarnMinutes, badgeUrgentMinutes,
        badgeEnabled, bannerEnabled, bannerPosition,
        commitWithin, commitWithinUnit, rewardDuration, rewardDurationUnit
      }
    });

    const origins = domainOrigins(domains);
    if (origins.length && !(await chrome.permissions.request({ origins }))) {
      throw new Error(
        "Settings were saved, but site access was not granted. Blocking won't work until you grant access."
      );
    }

    showStatus("Settings saved.");
  } catch (error) {
    showStatus(error.message, true);
  }
});

bannerEnabledInput.addEventListener("change", () => {
  bannerPositionInput.disabled = !bannerEnabledInput.checked;
});

const authText = document.querySelector("#auth-text");
const authCode = document.querySelector("#auth-code");
const authButton = document.querySelector("#auth-button");
const authOpenButton = document.querySelector("#auth-open-button");
const authCancelButton = document.querySelector("#auth-cancel-button");

async function renderAuth() {
  const stored = await chrome.storage.local.get(["githubAuth", "githubDeviceFlow"]);
  const flow = stored.githubDeviceFlow;
  authButton.disabled = false;
  authOpenButton.disabled = false;
  authCancelButton.disabled = false;
  if (stored.githubAuth?.token) {
    authCode.hidden = true;
    authOpenButton.hidden = true;
    authCancelButton.hidden = true;
    authButton.hidden = false;
    authText.textContent = stored.githubAuth.username
      ? "Signed in with GitHub."
      : "Please sign out and sign in again to connect your GitHub account.";
    authButton.textContent = "Sign out";
    authButton.dataset.action = "signOut";
  } else if (flow && !flow.error) {
    authText.textContent = "Use this code to authorize Earn Your Dopamine on GitHub.";
    authCode.textContent = flow.userCode;
    authCode.hidden = false;
    authOpenButton.hidden = false;
    authCancelButton.hidden = false;
    authButton.hidden = true;
  } else {
    authText.textContent = flow?.error ?? "Not signed in.";
    authCode.hidden = true;
    authOpenButton.hidden = true;
    authCancelButton.hidden = true;
    authButton.hidden = false;
    authButton.textContent = "Sign in with GitHub";
    authButton.dataset.action = "startSignIn";
  }
}

authButton.addEventListener("click", async () => {
  authButton.disabled = true;
  const action = authButton.dataset.action;
  try {
    const result = await chrome.runtime.sendMessage({ type: action });
    if (result?.error) showStatus(result.error, true);
  } catch (error) {
    showStatus(`GitHub sign-in failed: ${error.message}`, true);
  } finally {
    await renderAuth();
  }
});

authOpenButton.addEventListener("click", async () => {
  authOpenButton.disabled = true;
  try {
    const stored = await chrome.storage.local.get("githubDeviceFlow");
    const flow = stored.githubDeviceFlow;
    if (!flow?.userCode || !flow?.verificationUri || flow.error) {
      throw new Error("The sign-in code is no longer available. Start sign-in again.");
    }
    await navigator.clipboard.writeText(flow.userCode);
    window.open(flow.verificationUri, "_blank", "noopener");
    showStatus("Code copied. GitHub is opening.");
  } catch (error) {
    showStatus(`Couldn't copy the sign-in code: ${error.message}`, true);
  } finally {
    authOpenButton.disabled = false;
  }
});

authCancelButton.addEventListener("click", async () => {
  authCancelButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "cancelSignIn" });
    if (result?.error) showStatus(result.error, true);
  } catch (error) {
    showStatus(`Couldn't cancel sign-in: ${error.message}`, true);
  } finally {
    await renderAuth();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.githubAuth || changes.githubDeviceFlow)) renderAuth();
});

renderAuth();

loadSettings().catch((error) => {
  showStatus(`Couldn't load settings: ${error.message}`, true);
});
