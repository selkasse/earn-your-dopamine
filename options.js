const SETTINGS_KEY = "settings";

const form = document.querySelector("#settings-form");
const usernameInput = document.querySelector("#username");
const domainsInput = document.querySelector("#domains");
const rewardLimitInput = document.querySelector("#reward-limit");
const rewardUnitInput = document.querySelector("#reward-unit");
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

  usernameInput.value = settings.username ?? "";
  domainsInput.value = (settings.domains ?? []).join(", ");
  rewardLimitInput.value = settings.rewardLimit ?? 30;
  rewardUnitInput.value = settings.rewardUnit ?? "minutes";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showStatus("");

  try {
    const username = usernameInput.value.trim();
    const domains = parseDomains(domainsInput.value);
    const rewardLimit = Number(rewardLimitInput.value);
    const rewardUnit = rewardUnitInput.value;

    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) {
      throw new Error("Enter a valid GitHub username.");
    }
    if (!Number.isFinite(rewardLimit) || rewardLimit < 1) {
      throw new Error("The reward window must be at least 1 minute.");
    }

    await chrome.storage.sync.set({
      [SETTINGS_KEY]: { username, domains, rewardLimit, rewardUnit }
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

loadSettings().catch((error) => {
  showStatus(`Couldn't load settings: ${error.message}`, true);
});
