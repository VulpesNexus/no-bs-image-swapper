# Installed Tampermonkey check

`run-tampermonkey-browser.js` needs Node 24+, [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/), and an unpacked Tampermonkey extension. Set `CHROME_PATH` to the Chrome for Testing executable and `TM_EXTENSION_PATH` to the extension directory, then run `node tests/run-tampermonkey-browser.js` through a Windows launcher verified to keep its outer process hidden. The runner starts Chrome with `--headless=new`, `shell:false`, and `windowsHide:true`.

The test uses a throwaway browser profile and a loopback page. It installs the local userscript through Tampermonkey, opens the panel with its manager command, checks the lightbulb's click and Shift+click theme behavior, enables the floating button, reloads the page, and checks that the setting persisted. It removes the profile afterward. It does not touch the user's installed script or normal browser profile.

On this Windows host, a user-owned Chrome for Testing extraction initially failed with `Sandbox cannot access executable ... Access is denied`. Giving **only the extracted test browser directory** inherited read/execute access for Windows `ALL APPLICATION PACKAGES` (`S-1-15-2-1`) and `ALL RESTRICTED APPLICATION PACKAGES` (`S-1-15-2-2`) fixed that failure. Keep Chrome's sandbox enabled. The separate hidden-desktop job caused Chrome's network and GPU services to crash; the verified hidden outer launcher plus Chrome's headless mode passed.

On 2026-10-18, Chrome for Testing 155.0.8059.84 with Tampermonkey 5.5.1 passed the install, manager-menu, panel, theme-toggle, and setting-persistence checks. The test does not cover an existing browser profile, Violentmonkey, or every replacement rule.
