# No-BS Image Swapper

A userscript that replaces website images by resource URL or CSS selector. Rules can use hosted images or images stored by your userscript manager, and they persist across browser sessions. No-BS means useful controls without the feature restrictions or paywalls common to image replacement extensions.

## Install and update

Install [No-BS-Image-Swapper.user.js](No-BS-Image-Swapper.user.js) in a userscript manager that supports synchronous `GM_*` storage APIs, such as Tampermonkey or Violentmonkey, then reload the pages where it should run. Greasemonkey 4+ uses asynchronous `GM.*` storage APIs and is not currently supported.

The script's update and download URLs point to `No-BS-Image-Swapper.user.js` on this repository's `main` branch. Automatic updates become available once that URL is publicly reachable and the userscript manager's settings allow them. Increase `@version` for each release so managers detect it. Until the repository is available, update the installed copy manually.

The script runs on HTTP and HTTPS pages. Open *Manage image replacements* from the userscript manager menu to configure it. The floating launcher is hidden by default and can be enabled with *Toggle floating button*.

*NBSIS enabled* and the floating power button change the running script immediately. Disabling the script in Tampermonkey instead controls whether it is injected on page load; it does not undo changes in a page that is already open. Reload that page after changing Tampermonkey's switch, or enable Tampermonkey's *Auto reload pages* setting to reload affected tabs when a script is turned on or off.

## Use

Select *Add manual rule* or *Pick from page* in the panel, or run *Pick an image* from the userscript manager menu, then click an image or CSS background. Right-click an image to use the first menu command: *Edit rule from right-clicked image* for an active replacement, or *New rule from right-clicked image* for an unmodified image. The command appears while the script remembers a right-clicked image or CSS background. Right-clicking still opens the browser's or website's usual context menu. Tampermonkey can list its commands there as well as in its toolbar menu; Violentmonkey lists them in its toolbar popup. Set a website hostname and replacement source. Match the original image by URL or CSS selector. Save the rule to apply it. Expand a saved rule to see its website and replacement, then edit, reorder, duplicate, disable, or delete it with the icon buttons; earlier rules take priority. Hover over or focus the website name to see the full matching URL or selector.

The editor shows one scaled sample after the replacement source. When the rule matches an element on the page, the sample uses its box dimensions and the website's styling captured before NBSIS applies the rule; otherwise it uses an illustrative box. Fit, alignment, size, rotation, mirroring, blend, and opacity appear where applicable. The page itself remains the reference for exact website styling. *Page preview* applies the draft on the current page, and *Hide NBSIS interface* lets you inspect it without the panel. *Advanced options* contains *Appearance* and *Conditions*. Replacement backgrounds start centered. Stretch disables alignment, and known CSS background targets dim image-only size, opacity, rotation, and mirror controls without clearing their values. Date limits use *dd/mm/yyyy* text fields with calendar buttons; stored dates remain ISO format. *Reuse settings* follows Advanced options. The lightbulb beside Close toggles light and dark themes; Shift+click toggles Automatic mode; turning it off fixes the currently visible Light or Dark theme. Automatic mode shows a small A. Click outside the panel to close it, or select *Cancel* or press *Esc* to discard an unsaved preview.

Select *Stored images* to upload or delete local images. Supported formats are PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, and SVG. Each file may be up to 10 MiB; the combined limit is 48 MiB before data URL encoding overhead. These are the script's own caps, not measured limits; browser storage limits may be lower.

When picking an inline image whose `data:` URL exceeds 2,048 characters, the editor suggests a CSS selector. This avoids copying the full image data into each saved rule. Check that the suggested selector still points to the intended image if the page layout changes.

## Example: Wikipedia homepage

This example replaces the globe on the signed-out [Wikipedia homepage](https://www.wikipedia.org/) with the [Wikipedia 25 blue globe](https://commons.wikimedia.org/wiki/File:WP25_Wikipedia_Globe_-_blue.png). The replacement image is credited to Wikimedia Foundation staff and contractors under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The rule matches `.central-featured-logo` on `www.wikipedia.org` and fits the whole image in the original logo box.

| Before | Rule editor |
| --- | --- |
| <a href="docs/screenshots/wikipedia-demo/01-original-homepage.png"><img src="docs/screenshots/wikipedia-demo/01-original-homepage.png" width="400" alt="Signed-out Wikipedia homepage with its original globe"></a> | <a href="docs/screenshots/wikipedia-demo/02-rule-editor-live-preview.png"><img src="docs/screenshots/wikipedia-demo/02-rule-editor-live-preview.png" width="400" alt="NBSIS rule editor showing the replacement URL and live preview"></a> |

| Saved rule | After |
| --- | --- |
| <a href="docs/screenshots/wikipedia-demo/03-saved-rule.png"><img src="docs/screenshots/wikipedia-demo/03-saved-rule.png" width="400" alt="NBSIS panel showing one saved, active Wikipedia rule"></a> | <a href="docs/screenshots/wikipedia-demo/04-replaced-homepage.png"><img src="docs/screenshots/wikipedia-demo/04-replaced-homepage.png" width="400" alt="Signed-out Wikipedia homepage with the blue Wikipedia 25 globe"></a> |

These screenshots came from a disposable test browser with simulated userscript manager storage. They show the page and rule UI; no rule was saved in an installed browser.

## Limits and privacy

The script stores uploads in userscript manager storage and does not send them to a separate service. The management panel uses a closed shadow root and is detached when no control is visible; no panel node or pseudo-rule stylesheet is inserted on unrelated pages while the floating button is off. A page that intercepts DOM methods before the userscript runs may still observe the panel while it is open. Page scripts may also inspect images shown on that page, including uploaded images. Avoid confidential images on untrusted sites. Website content security policies may block replacements. Canvas content and cross-origin iframes are unsupported.

Userscript managers do not tell a script which element was right-clicked. The script remembers the image or CSS background under the most recent right-click on the page and forgets it once the command uses it, after a left click, a right-click elsewhere, navigation, hiding the page, or two minutes, and when the element is removed or shows a different image. The script records the target when the right button is pressed and again on the context-menu event, rechecks it every half second while one is remembered, and removes the command once the target is forgotten. Menu updates reach the manager asynchronously: a manager can show the command briefly after the target expired, and Tampermonkey's entry in the page's context menu may not reflect the right-click that opened that same menu. If the command runs without a valid target, it starts the picker instead. Managers without `GM_unregisterMenuCommand` always list the command. Right-clicks inside frames are not remembered, nor are right-clicks on pages that stop both the button press and the context-menu event before they reach the script. Websites that replace the browser's context menu also hide Tampermonkey's entries there; use the toolbar menu instead.

Overlap warnings are approximate for some CSS selectors and mixed time zones. The script currently scans page elements to detect CSS background matches; a broad rule on a large or frequently changing page can be costly. See [related tools](docs/RELATED-TOOLS.md) for a source-based comparison with other image replacers.

Run the Node tests with *node --test tests/\*.test.js*. Run the browser fixture with *node tests/run-browser-ui.js*, with `CHROME_PATH` set to a Chromium or Chrome executable; it checks windows 1000 and 500 pixels wide and frames from 450 down to 300 pixels wide. On Windows, the [headless Edge UI check](tests/run-browser-ui.ps1) runs one window size. The fixture uses simulated userscript storage APIs.

For installed Tampermonkey acceptance, set `CHROME_PATH` to Chrome for Testing and `TM_EXTENSION_PATH` to an unpacked Tampermonkey extension, then run *node tests/run-tampermonkey-browser.js*. It creates a disposable profile and local page, installs the script through Tampermonkey, opens the panel from Tampermonkey's menu, and checks that the floating-button setting survives a reload. See [manager test setup](tests/TAMPERMONKEY.md) for the Windows sandbox and hidden-launch details.

## Credits

[f3rufus's Image Replacer for Firefox](https://addons.mozilla.org/en-GB/firefox/addon/image-replacer-f3rufus/) helped inform the comparison and ideas for this project, especially its direct image context-menu workflow and page-specific rule list. Its [v1.0.2 source is GPL-3.0 licensed](https://addons.mozilla.org/en-GB/firefox/addon/image-replacer-f3rufus/versions/); this userscript does not incorporate its code. See also [related tools](docs/RELATED-TOOLS.md).
