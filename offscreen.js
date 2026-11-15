let captureState;
let paginationBundle;
const liveObjectUrls = new Set();

function sendAsyncResponse(
  promise,
  sendResponse,
  responseForResult = (result) => ({ ok: true, result }),
  responseForError = (error) => ({ ok: false, error: error.message })
) {
  promise.then(
    (result) => sendResponse(responseForResult(result)),
    (error) => sendResponse(responseForError(error))
  );
  return true;
}

function handleBeginPaginationBundle(message, sendResponse) {
  paginationBundle = { meta: message.meta, options: message.options, pages: [], pixelCount: 0 };
  captureState = paginationBundle;
  sendResponse({ ok: true });
  return false;
}

function handleBeginPaginationPage(message, sendResponse) {
  if (!paginationBundle || captureState !== paginationBundle) {
    sendResponse({ ok: false, error: "画像処理の準備ができていません。" });
    return false;
  }
  captureState = { meta: message.meta, options: paginationBundle.options, canvas: null, context: null, scale: 1, coveredBottom: 0 };
  sendResponse({ ok: true });
  return false;
}

function handleEndPaginationPage(_message, sendResponse) {
  if (!paginationBundle || !captureState?.canvas || captureState === paginationBundle) {
    sendResponse({ ok: false, error: "撮影画像がありません。" });
    return false;
  }
  paginationBundle.pages.push(captureState.canvas);
  paginationBundle.pixelCount += captureState.canvas.width * captureState.canvas.height;
  captureState = paginationBundle;
  sendResponse({ ok: true });
  return false;
}

function handleAbortPaginationPage(_message, sendResponse) {
  if (paginationBundle) captureState = paginationBundle;
  sendResponse({ ok: true });
  return false;
}

function handleBeginCapture(message, sendResponse) {
  paginationBundle = null;
  captureState = { meta: message.meta, options: message.options, canvas: null, context: null, scale: Number.isFinite(message.scale) && message.scale > 0 ? message.scale : 1, coveredBottom: 0 };
  sendResponse({ ok: true });
  return false;
}

function handleDiscard(_message, sendResponse) {
  captureState = null;
  paginationBundle = null;
  sendResponse({ ok: true });
  return false;
}

function handleAddFrame(message, sendResponse) {
  return sendAsyncResponse(
    addFrame(message.image, message.scrollY, message.pageHeight, message.currentPageHeight, message.crop),
    sendResponse,
    () => ({ ok: true })
  );
}

function handleTrimToCaptured(_message, sendResponse) {
  try {
    if (!captureState?.canvas || !captureState.coveredBottom) throw new Error("撮影画像がありません。");
    const old = captureState.canvas;
    const height = Math.min(old.height, Math.max(1, Math.ceil(captureState.coveredBottom * captureState.scale)));
    const canvas = document.createElement("canvas");
    canvas.width = old.width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("画像処理用Canvasを作成できませんでした。");
    context.drawImage(old, 0, 0);
    captureState.canvas = canvas;
    captureState.context = context;
    sendResponse({ ok: true });
  } catch (error) {
    sendResponse({ ok: false, error: error.message });
  }
  return false;
}

async function createPreviewResult() {
  if (captureState === paginationBundle && paginationBundle?.pages.length) {
    const pages = [];
    try {
      await createPaginationPreviews(paginationBundle.pages, pages);
      return { url: pages[0].url, pages };
    } catch (error) {
      for (const page of pages) {
        if (liveObjectUrls.delete(page.url)) URL.revokeObjectURL(page.url);
      }
      throw error;
    }
  }
  if (!captureState?.canvas) throw new Error("プレビューする画像がありません。");
  const { canvas, pageHeightPixels } = captureState;
  return { url: makeObjectUrl(await canvasBlob(canvas, "image/png")), width: canvas.width, height: canvas.height, pageHeight: pageHeightPixels || 0 };
}

async function createPaginationPreviews(sourcePages, previews, index = 0) {
  if (index >= sourcePages.length) return;
  const page = sourcePages[index];
  const blob = await canvasBlob(page, "image/png");
  const url = makeObjectUrl(blob);
  previews.push({ url, width: page.width, height: page.height });
  return createPaginationPreviews(sourcePages, previews, index + 1);
}

function handlePreview(_message, sendResponse) {
  return sendAsyncResponse(createPreviewResult(), sendResponse);
}

function handleReplaceImage(message, sendResponse) {
  return sendAsyncResponse(replaceImage(message.url), sendResponse, () => ({ ok: true }));
}

function handleFinish(_message, sendResponse) {
  return sendAsyncResponse(finishCapture(), sendResponse);
}

function handleCopy(message, sendResponse) {
  return sendAsyncResponse(
    copyToClipboard(message.clipboard),
    sendResponse,
    () => ({ ok: true }),
    (error) => ({ ok: false, error: `クリップボードへのコピーに失敗しました: ${error.message}` })
  );
}

function handleRelease(message, sendResponse) {
  for (const url of message.urls || []) {
    if (liveObjectUrls.delete(url)) URL.revokeObjectURL(url);
  }
  sendResponse({ ok: true });
  return false;
}

const offscreenMessageHandlers = {
  "begin-pagination-bundle": handleBeginPaginationBundle,
  "begin-pagination-page": handleBeginPaginationPage,
  "end-pagination-page": handleEndPaginationPage,
  "abort-pagination-page": handleAbortPaginationPage,
  begin: handleBeginCapture,
  discard: handleDiscard,
  "add-frame": handleAddFrame,
  "trim-to-captured": handleTrimToCaptured,
  preview: handlePreview,
  "replace-image": handleReplaceImage,
  finish: handleFinish,
  copy: handleCopy,
  release: handleRelease
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;
  const handler = Object.hasOwn(offscreenMessageHandlers, message.type) ? offscreenMessageHandlers[message.type] : null;
  return handler ? handler(message, sendResponse) : false;
});

async function replaceImage(url) {
  if (!captureState) throw new Error("編集対象がありません。");
  const response = await fetch(url);
  if (!response.ok) throw new Error("編集画像を読み取れませんでした。");
  const bitmap = await createImageBitmap(await response.blob());
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 80_000_000 || Math.max(bitmap.width, bitmap.height) > 32_000) {
      throw new Error("編集画像が大きすぎます。");
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("編集画像を作成できませんでした。");
    context.drawImage(bitmap, 0, 0);
    captureState.canvas = canvas;
    captureState.context = context;
  } finally {
    bitmap.close();
  }
}

async function addFrame(dataUrl, scrollY, pageHeight, currentPageHeight, crop) {
  if (!captureState) throw new Error("画像処理の準備ができていません。");
  const response = await fetch(dataUrl);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const { meta } = captureState;
    const framePageHeight = Number.isFinite(pageHeight) ? pageHeight : meta.pageHeight;
    if (meta.mode === "pagination" && captureState.canvas) {
      appendPaginationFrame(bitmap);
      return;
    }
    updateCaptureMeasurements(meta, currentPageHeight, framePageHeight);
    if (!captureState.canvas) initializeCaptureCanvas(bitmap, meta);
    expandCaptureCanvasForFrame(bitmap, scrollY, meta);
    drawCaptureFrame(bitmap, scrollY, framePageHeight, crop, meta);
  } finally {
    bitmap.close();
  }
}

function appendPaginationFrame(bitmap) {
  if (bitmap.width !== captureState.canvas.width || bitmap.height !== captureState.pageHeightPixels) {
    throw new Error("ページの表示サイズが変わりました。ウィンドウを元のサイズに戻して再撮影してください。");
  }
  const top = captureState.canvas.height;
  expandFullPageCanvas(getSafeFullPageHeight(bitmap.width, top + bitmap.height));
  captureState.context.drawImage(bitmap, 0, top);
}

function updateCaptureMeasurements(meta, currentPageHeight, framePageHeight) {
  const measuredHeight = Number.isFinite(currentPageHeight) ? currentPageHeight : framePageHeight;
  if (meta.mode === "full") meta.pageHeight = Math.max(meta.pageHeight, measuredHeight);
  if (meta.mode === "scroll-area") meta.scrollArea.scrollHeight = Math.max(meta.scrollArea.scrollHeight, measuredHeight);
}

function initializeCaptureCanvas(bitmap, meta) {
  captureState.scale = bitmap.width / meta.viewportWidth;
  const dimensions = getInitialCanvasDimensions(bitmap, meta, captureState.scale);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  captureState.canvas = canvas;
  if (meta.mode === "pagination") captureState.pageHeightPixels = bitmap.height;
  captureState.context = canvas.getContext("2d", { alpha: false });
  if (!captureState.context) throw new Error("画像処理用Canvasを作成できませんでした。");
}

function getInitialCanvasDimensions(bitmap, meta, scale) {
  switch (meta.mode) {
    case "full":
      return { width: bitmap.width, height: getSafeFullPageHeight(bitmap.width, meta.pageHeight * scale) };
    case "scroll-area": {
      const width = Math.max(1, Math.round(meta.scrollArea.clientWidth * scale));
      return { width, height: getSafeFullPageHeight(width, meta.scrollArea.scrollHeight * scale) };
    }
    case "region":
      return { width: Math.max(1, Math.round(meta.region.width * scale)), height: Math.max(1, Math.round(meta.region.height * scale)) };
    default:
      return { width: bitmap.width, height: bitmap.height };
  }
}

function expandCaptureCanvasForFrame(bitmap, scrollY, meta) {
  if (meta.mode !== "full" && meta.mode !== "scroll-area") return;
  const contentHeight = meta.mode === "full" ? meta.pageHeight : meta.scrollArea.scrollHeight;
  const viewportHeight = meta.mode === "full" ? bitmap.height / captureState.scale : meta.scrollArea.clientHeight;
  const requiredHeight = Math.max(contentHeight, scrollY + viewportHeight) * captureState.scale;
  expandFullPageCanvas(getSafeFullPageHeight(captureState.canvas.width, requiredHeight));
}

function drawCaptureFrame(bitmap, scrollY, framePageHeight, crop, meta) {
  if (meta.mode === "full") {
    drawFullPageFrame(bitmap, scrollY, framePageHeight);
  } else if (meta.mode === "scroll-area") {
    drawScrollAreaFrame(bitmap, scrollY, framePageHeight, crop);
  } else if (meta.mode === "region") {
    drawRegionFrame(bitmap, meta.region);
  } else {
    captureState.context.drawImage(bitmap, 0, 0);
  }
}

function drawFullPageFrame(bitmap, scrollY, framePageHeight) {
  const scale = captureState.scale;
  const viewportHeight = bitmap.height / scale;
  const drawTop = Math.max(captureState.coveredBottom, scrollY);
  const sourceTop = Math.max(0, (drawTop - scrollY) * scale);
  const bottom = Math.min(framePageHeight, scrollY + viewportHeight);
  const drawHeight = Math.max(0, (bottom - drawTop) * scale);
  if (drawHeight <= 0) return;
  captureState.context.drawImage(bitmap, 0, sourceTop, bitmap.width, drawHeight, 0, drawTop * scale, bitmap.width, drawHeight);
  captureState.coveredBottom = Math.max(captureState.coveredBottom, bottom);
}

function drawScrollAreaFrame(bitmap, scrollY, framePageHeight, crop) {
  const area = captureState.meta.scrollArea;
  const frameCrop = crop || area.rect;
  const scale = captureState.scale;
  const sx = Math.round(frameCrop.x * scale);
  const sy = Math.round(frameCrop.y * scale);
  const sw = Math.min(bitmap.width - sx, Math.round(frameCrop.width * scale));
  const drawTop = Math.max(captureState.coveredBottom, scrollY);
  const sourceTop = Math.max(0, (drawTop - scrollY) * scale);
  const bottom = Math.min(framePageHeight, scrollY + area.clientHeight);
  const drawHeight = Math.max(0, (bottom - drawTop) * scale);
  if (sw <= 0 || drawHeight <= 0) return;
  captureState.context.drawImage(bitmap, sx, sy + sourceTop, sw, drawHeight, 0, drawTop * scale, captureState.canvas.width, drawHeight);
  captureState.coveredBottom = Math.max(captureState.coveredBottom, bottom);
}

function drawRegionFrame(bitmap, region) {
  const scale = captureState.scale;
  const sx = Math.max(0, Math.round(region.x * scale));
  const sy = Math.max(0, Math.round(region.y * scale));
  const sw = Math.min(bitmap.width - sx, Math.round(region.width * scale));
  const sh = Math.min(bitmap.height - sy, Math.round(region.height * scale));
  captureState.context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, captureState.canvas.width, captureState.canvas.height);
}

function getSafeFullPageHeight(width, requestedHeight) {
  const height = Math.ceil(requestedHeight);
  if (width * height + (paginationBundle?.pixelCount || 0) > 80_000_000 || Math.max(width, height) > 32_000) {
    throw new Error("ページ画像が大きすぎます。表示範囲または選択範囲で撮影してください。");
  }
  return height;
}

function expandFullPageCanvas(requiredHeight) {
  if (requiredHeight <= captureState.canvas.height) return;
  const previous = captureState.canvas;
  const expanded = document.createElement("canvas");
  expanded.width = previous.width;
  expanded.height = requiredHeight;
  const context = expanded.getContext("2d", { alpha: false });
  if (!context) throw new Error("画像処理用Canvasを拡張できませんでした。");
  context.drawImage(previous, 0, 0);
  captureState.canvas = expanded;
  captureState.context = context;
}

async function finishCapture() {
  if (captureState === paginationBundle && paginationBundle?.pages.length) return finishPaginationBundle();
  return finishRegularCapture();
}

async function finishPaginationBundle() {
  const { pages, options } = paginationBundle;
  const files = [];
  const finish = () => {
    captureState = null;
    paginationBundle = null;
    return { files, clipboard: null };
  };
  const cleanup = (error) => {
    revokeFiles(files);
    throw error;
  };

  try {
    if (options.format === "pdf") {
      const blob = await makePdf(null, null, pages);
      files.push({ suffix: ".pdf", url: makeObjectUrl(blob) });
    } else {
      const type = options.format === "png" ? "image/png" : "image/jpeg";
      const extension = options.format === "png" ? ".png" : ".jpg";
      for (const [index, page] of pages.entries()) {
        const blob = await canvasBlob(page, type, .92);
        files.push({ suffix: `_${String(index + 1).padStart(3, "0")}${extension}`, url: makeObjectUrl(blob) });
      }
    }

    return finish();
  } catch (error) {
    return cleanup(error);
  }
}

async function finishRegularCapture() {
  if (!captureState?.canvas) throw new Error("撮影画像がありません。");
  const { canvas, meta, options, scale } = captureState;
  const split = shouldSplitCaptureOutput(meta, options);
  const viewportHeight = meta.mode === "scroll-area" ? meta.scrollArea.clientHeight : meta.viewportHeight;
  const partHeight = getOutputPartHeight(meta, split, viewportHeight, scale, canvas);
  const partCount = split ? Math.ceil(canvas.height / partHeight) : 1;
  const needsCopy = options.destination === "copy" || options.destination === "both";
  const needsSave = options.destination !== "copy";
  const needsFullPng = needsCopy || (needsSave && (options.format === "png" && !split));
  const pngBlob = needsFullPng ? await canvasBlob(canvas, "image/png") : null;
  const clipboard = !needsCopy || options.format === "pdf" ? null : { kind: "image", dataUrl: await blobToDataUrl(pngBlob) };
  const files = [];
  try {
    if (needsSave && (options.format === "png" || options.format === "jpeg")) {
      const type = options.format === "png" ? "image/png" : "image/jpeg";
      const extension = options.format === "png" ? ".png" : ".jpg";
      await createRasterFiles(canvas, partCount, partHeight, split, pngBlob, options.format, type, extension, files);
    } else if (needsSave && options.format === "pdf") {
      const blob = await makePdf(canvas, partHeight);
      files.push({ suffix: ".pdf", url: makeObjectUrl(blob) });
    }
  } catch (error) {
    revokeFiles(files);
    throw error;
  }

  captureState = null;
  return { files, clipboard };
}

function shouldSplitCaptureOutput(meta, options) {
  if (meta.mode === "pagination") return true;
  return options.splitOutput === true &&
    ["full", "scroll-area"].includes(meta.mode) &&
    options.destination !== "copy";
}

function getOutputPartHeight(meta, split, viewportHeight, scale, canvas) {
  if (meta.mode === "pagination") return captureState.pageHeightPixels || Math.round(viewportHeight * scale);
  if (split) return Math.max(1, Math.round(viewportHeight * scale));
  return canvas.height;
}

function createRasterFiles(canvas, partCount, partHeight, split, pngBlob, format, type, extension, files) {
  return Array.from({ length: partCount }, (_, index) => index).reduce((sequence, index) => sequence.then(() => {
    const part = split ? sliceCanvas(canvas, index * partHeight, partHeight) : canvas;
    const blobPromise = !split && pngBlob && format === "png" ? Promise.resolve(pngBlob) : canvasBlob(part, type, 0.92);
    return blobPromise.then((blob) => {
      const number = split ? `_${String(index + 1).padStart(3, "0")}` : "";
      files.push({ suffix: `${number}${extension}`, url: makeObjectUrl(blob) });
    }).finally(() => {
      if (part !== canvas) { part.width = 0; part.height = 0; }
    });
  }), Promise.resolve());
}

function revokeFiles(files) {
  for (const file of files) {
    if (liveObjectUrls.delete(file.url)) URL.revokeObjectURL(file.url);
  }
}

function sliceCanvas(canvas, top, height) {
  const part = document.createElement("canvas");
  part.width = canvas.width;
  part.height = Math.min(height, canvas.height - top);
  const context = part.getContext("2d", { alpha: false });
  if (!context) throw new Error("分割画像を作成できませんでした。");
  context.drawImage(canvas, 0, top, part.width, part.height, 0, 0, part.width, part.height);
  return part;
}

async function copyToClipboard(clipboard) {
  if (!clipboard) throw new Error("この形式はクリップボードにコピーできません。");
  const response = await fetch(clipboard.dataUrl);
  const blob = await response.blob();
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob })
  ]);
}

function makePdf(canvas, partHeight = canvas?.height, pages = null) {
  const pageCount = pages ? pages.length : Math.ceil(canvas.height / partHeight);
  const encoder = new TextEncoder();
  const chunks = [];
  const offsetState = { value: 0 };
  const offsets = [0];
  const append = (value) => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    chunks.push(bytes);
    offsetState.value += bytes.length;
  };

  append("%PDF-1.4\n%LocalCapture\n");
  offsets.push(offsetState.value);
  append("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets.push(offsetState.value);
  const kids = Array.from({ length: pageCount }, (_, index) => `${3 + index * 3} 0 R`).join(" ");
  append(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);
  return Array.from({ length: pageCount }, (_, index) => index).reduce((sequence, index) => sequence.then(() => {
    const part = getPdfPageCanvas(canvas, partHeight, pages, index, pageCount);
    return appendPdfPage(index, part, append, offsetState, offsets, encoder).finally(() => {
      if (!pages && part !== canvas) { part.width = 0; part.height = 0; }
    });
  }), Promise.resolve()).then(() => {
    const xrefOffset = offsetState.value;
    const objectCount = 2 + pageCount * 3;
    append(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
    for (let id = 1; id <= objectCount; id += 1) append(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
    append(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    return new Blob([concatenate(chunks)], { type: "application/pdf" });
  });
}

function getPdfPageCanvas(canvas, partHeight, pages, index, pageCount) {
  if (pages) return pages[index];
  if (pageCount > 1) return sliceCanvas(canvas, index * partHeight, partHeight);
  return canvas;
}

function appendPdfPage(index, part, append, offsetState, offsets, encoder) {
  return canvasBlob(part, "image/jpeg", 0.94)
    .then((jpeg) => jpeg.arrayBuffer())
    .then((buffer) => {
      const imageBytes = new Uint8Array(buffer);
      const pointScale = Math.min(0.75, 14_400 / Math.max(part.width, part.height));
      const pageWidth = part.width * pointScale;
      const pageHeight = part.height * pointScale;
      const pageId = 3 + index * 3;
      const content = `q\n${pageWidth.toFixed(2)} 0 0 ${pageHeight.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`;
      offsets.push(offsetState.value);
      append(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] /Resources << /XObject << /Im0 ${pageId + 1} 0 R >> >> /Contents ${pageId + 2} 0 R >>\nendobj\n`);
      offsets.push(offsetState.value);
      append(`${pageId + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${part.width} /Height ${part.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`);
      append(imageBytes);
      append("\nendstream\nendobj\n");
      const contentBytes = encoder.encode(content);
      offsets.push(offsetState.value);
      append(`${pageId + 2} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
      append(contentBytes);
      append("endstream\nendobj\n");
    });
}

function makeObjectUrl(blob) {
  const url = URL.createObjectURL(blob);
  liveObjectUrls.add(url);
  return url;
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("画像ファイルを作成できませんでした。")), type, quality);
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("画像を読み取れませんでした。"));
    reader.readAsDataURL(blob);
  });
}

function concatenate(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return output;
}
