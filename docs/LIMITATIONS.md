# Limits and privacy

Greasemonkey 4+ uses asynchronous `GM.*` storage APIs, which this script does not currently support.

The script stores uploaded images in userscript manager storage and does not send them to a separate service. Page scripts may still inspect images shown on that page, including uploaded images. Avoid confidential images on untrusted sites. A replacement image hosted elsewhere is requested from that host when the page displays it.

The management panel uses a closed shadow root and is detached when no control is visible. It inserts no panel node or pseudo-rule stylesheet on unrelated pages while the floating button is off. A page that intercepts DOM methods before the userscript runs may still observe the panel while it is open.

Website content security policies may block replacements. Canvas content and cross-origin iframes are unsupported. Overlap warnings are approximate for some CSS selectors and mixed time zones. The script scans page elements to detect CSS background matches; a broad rule on a large or frequently changing page can be costly.

## Right-click command behavior

Userscript managers do not tell a script which element was right-clicked. The script remembers the image or CSS background under the most recent right-click and forgets it when the command uses it, after a left click, a right-click elsewhere, navigation, hiding the page, or two minutes, and when the element is removed or shows a different image. It records the target when the right button is pressed and again on the context-menu event, rechecks it every half second while one is remembered, and removes the command once the target is forgotten.

Menu updates reach the manager asynchronously. A manager can show the command briefly after the target expires, and Tampermonkey's entry in the page's context menu may not reflect the right-click that opened that same menu. If the command runs without a valid target, it starts the picker instead. Managers without `GM_unregisterMenuCommand` always list the command.

Right-clicks inside frames are not remembered, nor are right-clicks on pages that stop both the button press and the context-menu event before they reach the script. Websites that replace the browser's context menu also hide Tampermonkey's entries there; use the toolbar menu instead.
