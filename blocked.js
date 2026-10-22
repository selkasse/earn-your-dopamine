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

recheck.addEventListener("click", async () => {
  recheck.disabled = true;
  document.querySelector("#error").textContent = "";
  try {
    const result = await chrome.runtime.sendMessage({ type: "recheck" });
    if (result?.allowed && target) {
      window.location.href = target;
      return;
    }
    document.querySelector("#error").textContent = result?.error
      ? `We couldn't verify your GitHub activity: ${result.error}`
      : "Still no recent push found. GitHub can take a minute to show new activity.";
  } finally {
    recheck.disabled = false;
  }
});
