# KiriTori

KiriTori is a local Chrome screenshot extension. Captures and image processing stay in your browser; page content is not uploaded.

The interface follows Chrome's display language: English, Japanese, Simplified Chinese, or Traditional Chinese. Other languages fall back to English. Restart Chrome after changing its display language if necessary.

## Install

1. Open `chrome://extensions` and enable Developer mode.
2. Select **Load unpacked** and choose this folder.
3. Open KiriTori from the Chrome toolbar.

Capture the visible area, a selected region, or a vertically scrolling page. Choose PNG, JPEG, PDF, or Markdown; save under Downloads or copy to the clipboard. PDF is save-only. Markdown contains the capture image and page metadata, not OCR text.

The popup offers optional ad hiding, manual selection of elements to hide, and a preview editor. In the editor, choose **Text** and click the image to type. Use **Select and adjust** to move annotations; drag the white handle to resize text and the blue handle to rotate it. Confirm text with Enter before adjusting its handles. Pixelation may not fully conceal text, so review the result before sharing.

Choose a basic color or use the color picker for text and arrows. Save up to 12 custom colors locally for later use; remove a saved color with the adjacent × button. Select an existing annotation before choosing a color to change it.

Use **Fill** and drag over an area to cover it with an opaque rectangle in the selected color. Use **Marker** to highlight with a translucent color; the content remains visible. Before sharing, check that every sensitive part is covered. Markdown also includes the page title and URL.

Drag to draw a **Rectangle**, **Ellipse**, or **Line** using the selected color and size. Use **Select and adjust** to move, recolor, or delete a shape; drag the white handle to resize a rectangle or ellipse, or drag either end of a line. Undo and redo are available via buttons or Cmd+Z / Cmd+Shift+Z on Mac and Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y on Windows. Reset can also be undone.

Use the page context menu or the keyboard shortcut configured at `chrome://extensions/shortcuts` to capture with saved settings. The popup displays progress, cancellation, and up to ten recent capture failures.

For full-page PNG, JPEG, and PDF output, you can split the edited image by screen height. PNG and JPEG produce numbered files; PDF produces multiple pages. Full-page capture is limited to 80 screens, 80 million pixels, and 32,000 pixels on either side, including when split output is selected. Some browser-internal pages and Chrome Web Store pages cannot be captured.
