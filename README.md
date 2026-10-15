# No-BS Image Swapper

A userscript for replacing images on websites by resource URL or CSS selector. Rules can use hosted images or images stored by Tampermonkey or Violentmonkey. Rules persist across browser sessions.

Credit: [f3rufus's Image Replacer for Firefox](https://addons.mozilla.org/en-GB/firefox/addon/image-replacer-f3rufus/) helped inform the comparison and ideas for this project, especially its direct image context-menu workflow and page-specific rule list. Its [v1.0.2 source is GPL-3.0 licensed](https://addons.mozilla.org/en-GB/firefox/addon/image-replacer-f3rufus/versions/); this userscript does not incorporate its code. See [related tools](docs/RELATED-TOOLS.md).

## Install and update

Install [ImageSwap.user.js](ImageSwap.user.js) in Tampermonkey or Violentmonkey, then reload the pages where it should run. If you already use *Image Swap*, edit that installed script and replace its contents with the new file instead of installing a second copy. The userscript keeps the v1.1.0–v1.4.0 install identity and storage keys; its panel displays *No-BS Image Swapper*, and its floating launcher reads *NBSIS*. Back up and verify saved rules before upgrading directly from version 1.0.0, which had a different script name.

The script runs on HTTP and HTTPS pages. Open *Manage image replacements* from the userscript manager menu to configure it. The floating launcher is hidden by default and can be enabled with *Toggle floating button*.

## Use

Select *Add manual rule* or *Pick from page* in the panel, or run *Pick an image* from the userscript manager menu, then click an image or CSS background. To start from an image you have already found, right-click it, then run *New rule from right-clicked image*, which the script lists first, and only while it remembers a right-clicked image or CSS background. Right-clicking still opens the browser's or website's usual context menu. Tampermonkey can list its menu commands in that context menu as well as in its toolbar menu; Violentmonkey lists them in its toolbar popup menu. Set a website hostname and replacement source. Match the original image by URL or CSS selector. A rule can use an image URL or an uploaded image. Save the rule to apply it. Expand a saved rule to see its website and replacement, then edit, reorder, duplicate, disable, or delete it with the icon buttons; earlier rules take priority. Hover over or focus the website name to see the full matching URL or selector.

The editor shows *Appearance* immediately after the replacement source. The live thumbnail shows the complete replacement image at its own aspect ratio; *View page preview* shows how fit and sizing affect the website. *Advanced options* contains fit, rule setting reuse, and scheduling. Click outside the panel to close it, or select *Cancel* or press *Esc* to discard an unsaved preview.

Select *Stored images* to upload or delete local images. Supported formats are PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, and SVG. Each file may be up to 10 MiB; the combined limit is 48 MiB before data URL encoding overhead. These are the script's own caps, not measured limits; browser storage limits may be lower.

When picking an inline image whose `data:` URL exceeds 2,048 characters, the editor suggests a CSS selector. This avoids copying the full image data into each saved rule. Check that the suggested selector still points to the intended image if the page layout changes.

## Limits and privacy

The script stores uploads in userscript manager storage and does not send them to a separate service. The management panel uses a closed shadow root and is detached when no control is visible; no panel node or pseudo-rule stylesheet is inserted on unrelated pages while the floating button is off. A page that intercepts DOM methods before the userscript runs may still observe the panel while it is open. Page scripts may also inspect images shown on that page, including uploaded images. Avoid confidential images on untrusted sites. Website content security policies may block replacements. Canvas content and cross-origin iframes are unsupported.

Userscript managers do not tell a script which element was right-clicked. The script remembers the image or CSS background under the most recent right-click on the page and forgets it once the command uses it, after a left click, a right-click elsewhere, navigation, hiding the page, or two minutes, and when the element is removed or shows a different image. The script records the target when the right button is pressed and again on the context-menu event, rechecks it every half second while one is remembered, and removes the command once the target is forgotten. Menu updates reach the manager asynchronously: a manager can show the command briefly after the target expired, and Tampermonkey's entry in the page's context menu may not reflect the right-click that opened that same menu. If the command runs without a valid target, it starts the picker instead. Managers without `GM_unregisterMenuCommand` always list the command. Right-clicks inside frames are not remembered, nor are right-clicks on pages that stop both the button press and the context-menu event before they reach the script. Websites that replace the browser's context menu also hide Tampermonkey's entries there; use the toolbar menu instead.

Overlap warnings are approximate for some CSS selectors and mixed time zones. The script currently scans page elements to detect CSS background matches; a broad rule on a large or frequently changing page can be costly. See [related tools](docs/RELATED-TOOLS.md) for a source-based comparison with other image replacers.

Run the Node tests with *node --test tests/\*.test.js*. Run the browser fixture with *node tests/run-browser-ui.js*, with `CHROME_PATH` set to a Chromium or Chrome executable; it checks windows 1000 and 500 pixels wide and frames from 450 down to 300 pixels wide. On Windows, the [headless Edge UI check](tests/run-browser-ui.ps1) runs one window size. The fixture uses simulated userscript storage APIs; installed manager acceptance is separate.
