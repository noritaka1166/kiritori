let captureState;
const liveObjectUrls = new Set();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  if (message.type === "begin") {
    try {
      captureState = { meta: message.meta, options: message.options, canvas: null, context: null, scale: Number.isFinite(message.scale) && message.scale > 0 ? message.scale : 1, coveredBottom: 0 };
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  }

  if (message.type === "discard") {
    captureState = null;
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "add-frame") {
    addFrame(message.image, message.scrollY, message.pageHeight, message.currentPageHeight, message.crop)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "trim-to-captured") {
    try {
      if (!captureState?.canvas || !captureState.coveredBottom) throw new Error("撮影画像がありません。");
      const old = captureState.canvas;
      const height = Math.min(old.height, Math.max(1, Math.ceil(captureState.coveredBottom * captureState.scale)));
      const canvas = document.createElement("canvas");
      canvas.width = old.width; canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("画像処理用Canvasを作成できませんでした。");
      context.drawImage(old, 0, 0);
      captureState.canvas = canvas; captureState.context = context;
      sendResponse({ ok: true });
    } catch (error) { sendResponse({ ok: false, error: error.message }); }
    return false;
  }

  if (message.type === "preview") {
    (async () => {
      if (!captureState?.canvas) throw new Error("プレビューする画像がありません。");
      const { canvas, pageHeightPixels } = captureState;
      return { url: makeObjectUrl(await canvasBlob(canvas, "image/png")), width: canvas.width, height: canvas.height, pageHeight: pageHeightPixels || 0 };
    })().then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "replace-image") {
    replaceImage(message.url).then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "finish") {
    finishCapture()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "copy") {
    copyToClipboard(message.clipboard)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: `クリップボードへのコピーに失敗しました: ${error.message}` }));
    return true;
  }

  if (message.type === "release") {
    for (const url of message.urls || []) {
      if (liveObjectUrls.delete(url)) URL.revokeObjectURL(url);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
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
  const { meta, options } = captureState;
  const framePageHeight = Number.isFinite(pageHeight) ? pageHeight : meta.pageHeight;
  if (meta.mode === "pagination" && captureState.canvas) {
    if (bitmap.width !== captureState.canvas.width || bitmap.height !== captureState.pageHeightPixels) { bitmap.close(); throw new Error("ページの表示サイズが変わりました。ウィンドウを元のサイズに戻して再撮影してください。"); }
    const top = captureState.canvas.height;
    expandFullPageCanvas(getSafeFullPageHeight(bitmap.width, top + bitmap.height));
    captureState.context.drawImage(bitmap, 0, top);
    bitmap.close();
    return;
  }
  if (meta.mode === "full") {
    const measuredPageHeight = Number.isFinite(currentPageHeight) ? currentPageHeight : framePageHeight;
    meta.pageHeight = Math.max(meta.pageHeight, measuredPageHeight);
  } else if (meta.mode === "scroll-area") {
    const measuredScrollHeight = Number.isFinite(currentPageHeight) ? currentPageHeight : framePageHeight;
    meta.scrollArea.scrollHeight = Math.max(meta.scrollArea.scrollHeight, measuredScrollHeight);
  }

  if (!captureState.canvas) {
    captureState.scale = bitmap.width / meta.viewportWidth;
    if (meta.mode === "full") {
      const width = bitmap.width;
      const height = getSafeFullPageHeight(width, meta.pageHeight * captureState.scale);
      captureState.canvas = document.createElement("canvas");
      captureState.canvas.width = width;
      captureState.canvas.height = height;
    } else if (meta.mode === "scroll-area") {
      const width = Math.max(1, Math.round(meta.scrollArea.clientWidth * captureState.scale));
      const height = getSafeFullPageHeight(width, meta.scrollArea.scrollHeight * captureState.scale);
      captureState.canvas = document.createElement("canvas");
      captureState.canvas.width = width;
      captureState.canvas.height = height;
    } else if (meta.mode === "region") {
      const region = meta.region;
      captureState.canvas = document.createElement("canvas");
      captureState.canvas.width = Math.max(1, Math.round(region.width * captureState.scale));
      captureState.canvas.height = Math.max(1, Math.round(region.height * captureState.scale));
    } else {
      captureState.canvas = document.createElement("canvas");
      captureState.canvas.width = bitmap.width;
      captureState.canvas.height = bitmap.height;
    }
    if (meta.mode === "pagination") captureState.pageHeightPixels = bitmap.height;
    captureState.context = captureState.canvas.getContext("2d", { alpha: false });
    if (!captureState.context) {
      bitmap.close();
      throw new Error("画像処理用Canvasを作成できませんでした。");
    }
  }

  if (meta.mode === "full" || meta.mode === "scroll-area") {
    const contentHeight = meta.mode === "full" ? meta.pageHeight : meta.scrollArea.scrollHeight;
    const viewportHeight = meta.mode === "full" ? bitmap.height / captureState.scale : meta.scrollArea.clientHeight;
    const requiredHeight = Math.max(contentHeight, scrollY + viewportHeight) * captureState.scale;
    expandFullPageCanvas(getSafeFullPageHeight(captureState.canvas.width, requiredHeight));
  }

  const context = captureState.context;
  if (meta.mode === "full") {
    const scale = captureState.scale;
    const viewportHeight = bitmap.height / scale;
    const drawTop = Math.max(captureState.coveredBottom, scrollY);
    const sourceTop = Math.max(0, (drawTop - scrollY) * scale);
    const bottom = Math.min(framePageHeight, scrollY + viewportHeight);
    const drawHeight = Math.max(0, (bottom - drawTop) * scale);
    if (drawHeight > 0) {
      context.drawImage(bitmap, 0, sourceTop, bitmap.width, drawHeight, 0, drawTop * scale, bitmap.width, drawHeight);
      captureState.coveredBottom = Math.max(captureState.coveredBottom, bottom);
    }
  } else if (meta.mode === "scroll-area") {
    const area = meta.scrollArea;
    const frameCrop = crop || area.rect;
    const scale = captureState.scale;
    const sx = Math.round(frameCrop.x * scale);
    const sy = Math.round(frameCrop.y * scale);
    const sw = Math.min(bitmap.width - sx, Math.round(frameCrop.width * scale));
    const drawTop = Math.max(captureState.coveredBottom, scrollY);
    const sourceTop = Math.max(0, (drawTop - scrollY) * scale);
    const bottom = Math.min(framePageHeight, scrollY + area.clientHeight);
    const drawHeight = Math.max(0, (bottom - drawTop) * scale);
    if (sw > 0 && drawHeight > 0) {
      context.drawImage(bitmap, sx, sy + sourceTop, sw, drawHeight, 0, drawTop * scale, captureState.canvas.width, drawHeight);
      captureState.coveredBottom = Math.max(captureState.coveredBottom, bottom);
    }
  } else if (meta.mode === "region") {
    const region = meta.region;
    const scale = captureState.scale;
    const sx = Math.max(0, Math.round(region.x * scale));
    const sy = Math.max(0, Math.round(region.y * scale));
    const sw = Math.min(bitmap.width - sx, Math.round(region.width * scale));
    const sh = Math.min(bitmap.height - sy, Math.round(region.height * scale));
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, captureState.canvas.width, captureState.canvas.height);
  } else {
    context.drawImage(bitmap, 0, 0);
  }
  bitmap.close();
}

function getSafeFullPageHeight(width, requestedHeight) {
  const height = Math.ceil(requestedHeight);
  if (width * height > 80_000_000 || Math.max(width, height) > 32_000) {
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
  if (!captureState?.canvas) throw new Error("撮影画像がありません。");
  const { canvas, meta, options, scale } = captureState;
  const split = meta.mode === "pagination" || (options.splitOutput === true && ["full", "scroll-area"].includes(meta.mode) && options.destination !== "copy");
  const viewportHeight = meta.mode === "scroll-area" ? meta.scrollArea.clientHeight : meta.viewportHeight;
  const partHeight = meta.mode === "pagination" ? (captureState.pageHeightPixels || Math.round(viewportHeight * scale)) : split ? Math.max(1, Math.round(viewportHeight * scale)) : canvas.height;
  const partCount = split ? Math.ceil(canvas.height / partHeight) : 1;
  const needsCopy = options.destination === "copy" || options.destination === "both";
  const needsSave = options.destination !== "copy";
  const needsFullPng = needsCopy || (needsSave && (options.format === "png" && !split));
  const pngBlob = needsFullPng ? await canvasBlob(canvas, "image/png") : null;
  const clipboard = !needsCopy || options.format === "pdf" ? null : { kind: "image", dataUrl: await blobToDataUrl(pngBlob) };
  const files = [];
  const addFile = (suffix, blob) => files.push({ suffix, url: makeObjectUrl(blob) });
  try {
    if (needsSave && (options.format === "png" || options.format === "jpeg")) {
      const type = options.format === "png" ? "image/png" : "image/jpeg";
      const extension = options.format === "png" ? ".png" : ".jpg";
      for (let index = 0; index < partCount; index += 1) {
        const part = split ? sliceCanvas(canvas, index * partHeight, partHeight) : canvas;
        try {
          const blob = !split && pngBlob && options.format === "png" ? pngBlob : await canvasBlob(part, type, 0.92);
          const number = split ? `_${String(index + 1).padStart(3, "0")}` : "";
          addFile(`${number}${extension}`, blob);
        } finally {
          if (part !== canvas) { part.width = 0; part.height = 0; }
        }
      }
    } else if (needsSave && options.format === "pdf") {
      addFile(".pdf", await makePdf(canvas, partHeight));
    }
  } catch (error) {
    for (const file of files) {
      if (liveObjectUrls.delete(file.url)) URL.revokeObjectURL(file.url);
    }
    throw error;
  }

  captureState = null;
  return { files, clipboard };
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

async function makePdf(canvas, partHeight = canvas.height) {
  const pageCount = Math.ceil(canvas.height / partHeight);
  const encoder = new TextEncoder();
  const chunks = [];
  let offset = 0;
  const offsets = [0];
  const append = (value) => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    chunks.push(bytes);
    offset += bytes.length;
  };

  append("%PDF-1.4\n%LocalCapture\n");
  offsets.push(offset);
  append("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets.push(offset);
  const kids = Array.from({ length: pageCount }, (_, index) => `${3 + index * 3} 0 R`).join(" ");
  append(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\nendobj\n`);
  for (let index = 0; index < pageCount; index += 1) {
    const part = pageCount > 1 ? sliceCanvas(canvas, index * partHeight, partHeight) : canvas;
    try {
      const jpeg = await canvasBlob(part, "image/jpeg", 0.94);
      const imageBytes = new Uint8Array(await jpeg.arrayBuffer());
      const pointScale = Math.min(0.75, 14_400 / Math.max(part.width, part.height));
      const pageWidth = part.width * pointScale;
      const pageHeight = part.height * pointScale;
      const pageId = 3 + index * 3;
      const content = `q\n${pageWidth.toFixed(2)} 0 0 ${pageHeight.toFixed(2)} 0 0 cm\n/Im0 Do\nQ\n`;
      offsets.push(offset);
      append(`${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] /Resources << /XObject << /Im0 ${pageId + 1} 0 R >> >> /Contents ${pageId + 2} 0 R >>\nendobj\n`);
      offsets.push(offset);
      append(`${pageId + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${part.width} /Height ${part.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${imageBytes.length} >>\nstream\n`);
      append(imageBytes);
      append("\nendstream\nendobj\n");
      const contentBytes = encoder.encode(content);
      offsets.push(offset);
      append(`${pageId + 2} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
      append(contentBytes);
      append("endstream\nendobj\n");
    } finally {
      if (part !== canvas) { part.width = 0; part.height = 0; }
    }
  }

  const xrefOffset = offset;
  const objectCount = 2 + pageCount * 3;
  append(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= objectCount; id += 1) append(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  append(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return new Blob([concatenate(chunks)], { type: "application/pdf" });
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
