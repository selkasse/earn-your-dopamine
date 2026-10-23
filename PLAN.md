# UX Fix for Device Flow & UI Cleanup

The current Device Flow implementation is confusing because the extension automatically opens the new GitHub tab, which causes the user to lose sight of the `user_code` they need to enter. Furthermore, Chrome kills the extension popup when focus is lost.

We need to change the order of operations so the user sees the code _before_ the new tab opens.

**Instructions:**

1. **Stop Auto-Opening the Tab:** When the user initiates the sign-in and you receive the `user_code` and `verification_uri` from GitHub, DO NOT automatically open a new tab.
2. **Display Code First:** Update the UI to show the `user_code` prominently.
3. **Copy & Continue Button:** Add a button below the code that says "Copy Code & Open GitHub".
4. **Action on Click:** When the user clicks this new button:
   - Programmatically copy the `user_code` to the user's clipboard using the Clipboard API (`navigator.clipboard.writeText`).
   - THEN open the `verification_uri` in a new tab (`window.open`).
5. **Enforce Mandatory Auth (Cleanup):** I can still see the manual "GitHub username" input box and the old rate limit helper text in the UI. Please completely remove the manual username input box and the subtext about "Optional. Signing in raises...". Users should only see the OAuth flow.
6. Test this new sequence, ensure the clipboard copy works, and continue the autonomous loop.
