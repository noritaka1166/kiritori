# KiriTori

KiriTori is a local Chrome screenshot extension. Captures and image processing stay in your browser; page content is not uploaded.

The interface follows Chrome's display language: English, Japanese, Simplified Chinese, or Traditional Chinese. Other languages fall back to English. Restart Chrome after changing its display language if necessary.

## Install

1. Open `chrome://extensions` and enable Developer mode.
2. Select **Load unpacked** and choose this folder.
3. Open KiriTori from the Chrome toolbar.

Capture the visible area, a selected region, a vertically scrolling page, or a scrollable area inside a page such as a table. For a scrollable area, select it on the page; KiriTori scrolls that area and stitches its visible width from top to bottom, then restores its original scroll position. Sticky headers inside the area appear only in the first frame to avoid repeating them. The whole area must fit in the viewport when selected. Horizontal overflow and scroll areas inside frames are not captured. Choose PNG, JPEG, or PDF; save under Downloads or copy to the clipboard. PDF is save-only.

The popup provides local editor drafts. Choose no saving or retention for 1, 7, or 30 days (default 7). Drafts contain the original image and edits; restore or delete individual drafts, or delete all drafts from the popup. Drafts remain after output until their expiry or deletion. Expired drafts are removed the next time KiriTori opens. Retention changes apply to subsequently opened editors.

The popup offers optional ad hiding, manual selection of elements to hide, and a preview editor. In the editor, choose **Text** and click the image to type. Use **Select and adjust** to move annotations; drag the white handle to resize text and the blue handle to rotate it. Confirm text with Enter before adjusting its handles. For pixelation, set the block size from 2 to 160 pixels before drawing; smaller values produce finer blocks. Pixelation may not fully conceal text, so review the result before sharing.

In a fresh capture preview, **Retake** captures the original tab again with the same settings. Re-select any region or manually hidden elements. The original tab must still be on the same page. A saved editing draft is retained; retaking is unavailable from a restored draft.

Choose a basic color or use the color picker for text and arrows. Save up to 12 custom colors locally for later use; remove a saved color with the adjacent × button. Select an existing annotation before choosing a color to change it.

Use **Fill** and drag over an area to cover it with an opaque rectangle in the selected color. Use **Marker** to highlight with a translucent color; the content remains visible. Before sharing, check that every sensitive part is covered.

Choose **Number marker** and click the image to place sequential numbered circles. Choose their color and size, then use Select and adjust to move, recolor, resize or delete them. The next number follows the highest existing number.

Drag to draw a **Rectangle**, **Ellipse**, or **Line** using the selected color and size. Use **Select and adjust** to move, recolor, or delete a shape; drag the white handle to resize a rectangle or ellipse, or drag either end of a line. Undo and redo are available via buttons or Cmd+Z / Cmd+Shift+Z on Mac and Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y on Windows. Reset can also be undone.

Choose an additional post-scroll wait: Fast (200 ms), Normal (600 ms), Slow (1500 ms), or a custom value from 0 to 10000 ms. The wait applies to page and scrollable-area capture, including context menu and shortcut capture. Scroll settling and Chrome capture limits can make the actual interval longer.

Enable **Save settings for this site** to store capture options locally per hostname. They are used when reopening the popup and for shortcuts; context menu choices override only the capture mode. Uncheck to remove the site settings and return to the shared defaults. Subdomains are separate.

Use the page context menu or the keyboard shortcut configured at `chrome://extensions/shortcuts` to capture with saved settings. The popup displays progress, cancellation, and up to ten recent capture failures.

For full-page or scrollable-area PNG, JPEG, and PDF output, you can split the edited image by screen height. PNG and JPEG produce numbered files; PDF produces multiple pages. Set the capture limit from 1 to 200 screens (default 80); reaching it outputs the portion captured. The limits of 80 million pixels and 32,000 pixels on either side still apply, including when split output is selected. Some browser-internal pages and Chrome Web Store pages cannot be captured.
