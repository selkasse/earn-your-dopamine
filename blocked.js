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
