const params = new URLSearchParams(window.location.search);
const site = params.get("site");
const error = params.get("error");

if (site) {
  document.querySelector("#context").textContent = `${site} is taking a break.`;
}
if (error) {
  document.querySelector("#error").textContent =
    `We couldn't verify your GitHub activity: ${error}`;
}

const recheck = document.querySelector("#recheck");
const target = params.get("target");
const errorEl = document.querySelector("#error");

function describeNoPush(result) {
  const time = new Date().toLocaleTimeString();
  const withinMinutes = Math.round((result.commitWithinMs ?? 0) / 60000);
  if (!Number.isFinite(result.latestPushAt)) {
    return `Checked at ${time}: no pushes found on your public GitHub activity.`;
  }
  const minutesAgo = Math.max(0, Math.round((Date.now() - result.latestPushAt) / 60000));
  if (result.alreadyRedeemed && minutesAgo <= withinMinutes) {
    return `Checked at ${time}: your last push (${minutesAgo} min ago) already earned a reward. Push again for another.`;
  }
  return `Checked at ${time}: your last push was ${minutesAgo} min ago, outside your ${withinMinutes} min window. GitHub can take a minute to show new pushes.`;
}

recheck.addEventListener("click", async () => {
  recheck.disabled = true;
  errorEl.textContent = "Checking\u2026";
  try {
    const runtime = globalThis.chrome?.runtime;
    if (typeof runtime?.sendMessage !== "function") {
      console.error("Chrome runtime API is unavailable.");
      errorEl.textContent =
        "The extension connection is unavailable. Refresh this page and try again.";
      return;
    }

    // The service worker may be waking up, which can yield an empty reply.
    let result = await runtime.sendMessage({ type: "recheck" });
    if (!result) result = await runtime.sendMessage({ type: "recheck" });
    if (!result) throw new Error("No response from the extension. Try again.");
    if (result.allowed) {
      if (target) {
        window.location.href = target;
      } else {
        errorEl.textContent = "Reward earned! You can reopen the site now.";
      }
      return;
    }
    errorEl.textContent = result?.error
      ? `We couldn't verify your GitHub activity: ${result.error}`
      : describeNoPush(result ?? {});
  } catch (error) {
    errorEl.textContent = `Something went wrong: ${error?.message || "please reload the page."}`;
  } finally {
    recheck.disabled = false;
  }
});
