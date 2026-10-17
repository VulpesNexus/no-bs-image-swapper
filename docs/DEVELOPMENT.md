# Development and checks

The userscript metadata points `@updateURL` and `@downloadURL` to `No-BS-Image-Swapper.user.js` on this repository's `main` branch. Increase `@version` for each release so installed managers can detect a new version. Automatic updates require the URL to be reachable by the manager.

Run the Node tests with *node --test tests/\*.test.js*. If a restricted environment blocks the runner's child processes with `spawn EPERM`, run each `.test.js` file directly with Node; they use `node:test` and still report their results. Run the browser fixture with *node tests/run-browser-ui.js* and `CHROME_PATH` set to a Chromium or Chrome executable. The fixture checks windows 1000 and 500 pixels wide and frames from 450 down to 300 pixels wide, using simulated userscript storage APIs. On Windows, the [headless Edge UI check](../tests/run-browser-ui.ps1) runs one window size.

For installed Tampermonkey acceptance, set `CHROME_PATH` to Chrome for Testing and `TM_EXTENSION_PATH` to an unpacked Tampermonkey extension, then run *node tests/run-tampermonkey-browser.js*. It uses a disposable profile and local page, installs the script through Tampermonkey, opens the panel from its menu, and checks that the floating-button setting survives a reload. See [manager test setup](../tests/TAMPERMONKEY.md) for environment-specific details.
