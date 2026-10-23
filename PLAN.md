# Bug Fix: Uncaught TypeError in blocked.html

The blocked page (`blocked.html`) is occasionally throwing the following error when the user clicks the "I pushed — check again" button:
`Something went wrong: Cannot read properties of undefined (reading 'sendMessage')`

This indicates that `chrome.runtime` is undefined in the context where the script is executing.

**Instructions:**

1. **Check Script Context:** Ensure that the JavaScript file linked to `blocked.html` (e.g., `blocked.js`) is running in the correct extension context and has access to the `chrome.*` APIs.
2. **Fallback / Defensive Coding:** Wrap the `sendMessage` call in a defensive check. If `chrome.runtime` is undefined, the script should fail gracefully, log a clear error to the console, and ideally suggest the user refresh the page.
   ```javascript
   if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
     // Handle the error gracefully
     console.error("Chrome runtime API is unavailable.");
     // Update the UI error text
     return;
   }
   ```
