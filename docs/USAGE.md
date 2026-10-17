# Using No-BS Image Swapper

## Create and manage rules

Open *Manage image replacements* from the userscript manager menu. Select *Add manual rule* or *Pick from page*, or run *Pick an image* from the manager menu and click an image or CSS background. Set the website hostname and a replacement image URL or stored image. Match the original by resource URL or CSS selector, then save the rule.

Right-click an image to use the first manager command: *Edit rule from right-clicked image* for an active replacement, or *New rule from right-clicked image* for an unmodified image. Right-clicking still opens the browser's or website's usual context menu. Tampermonkey may list its commands there as well as in its toolbar menu; Violentmonkey lists them in its toolbar popup.

Expand a saved rule to see its website and replacement. Use the icon buttons to edit, reorder, duplicate, disable, or delete it; earlier rules take priority. Hover over or focus the website name to see the full matching URL or selector.

## Preview and appearance

The editor shows one scaled sample below the replacement source. When the rule matches an element on the page, the sample uses its box dimensions and website styling captured before NBSIS applies the rule. Otherwise, it uses an illustrative box. The page itself remains the reference for exact website styling. *Page preview* applies the draft on the current page; *Hide NBSIS interface* lets you inspect it without the panel.

*Advanced options* contains *Appearance* and *Conditions*. Fit, alignment, size, rotation, mirroring, blend, and opacity appear where applicable. Replacement backgrounds start centered. Stretch disables alignment. Known CSS background targets dim image-only size, opacity, rotation, and mirror controls without clearing their values. Date limits use *dd/mm/yyyy* text fields with calendar buttons; stored dates remain ISO format. *Reuse settings* follows Advanced options.

The lightbulb beside Close toggles Light and Dark themes. Shift+click toggles Automatic mode; turning it off fixes the currently visible theme. Automatic mode shows a small A. Click outside the panel to close it, or select *Cancel* or press *Esc* to discard an unsaved preview.

## Stored and inline images

Select *Stored images* to upload or delete local images. Supported formats are PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, and SVG. Each file may be up to 10 MiB; the combined limit is 48 MiB before data URL encoding overhead. These are the script's own caps; browser storage limits may be lower.

When picking an inline image whose `data:` URL exceeds 2,048 characters, the editor suggests a CSS selector rather than copying the full image data into each saved rule. Check that the selector still points to the intended image if the page layout changes.

## Enable and disable

*NBSIS enabled* and the floating power button change the running script immediately. Tampermonkey's script switch instead controls injection on page load and does not undo changes on an open page. Reload the page after changing that switch, or enable Tampermonkey's *Auto reload pages* setting to reload affected tabs when a script is turned on or off.

The floating launcher is hidden by default. Enable it with *Toggle floating button* in the userscript manager menu.
