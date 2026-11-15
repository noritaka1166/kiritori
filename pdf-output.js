import { canvasBlob, sliceCanvas } from "./canvas-utils.js";

export function makePdf(canvas, partHeight = canvas?.height, pages = null) {
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
