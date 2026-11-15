export function sliceCanvas(canvas, top, height) {
  const part = document.createElement("canvas");
  part.width = canvas.width;
  part.height = Math.min(height, canvas.height - top);
  const context = part.getContext("2d", { alpha: false });
  if (!context) throw new Error("分割画像を作成できませんでした。");
  context.drawImage(canvas, 0, top, part.width, part.height, 0, 0, part.width, part.height);
  return part;
}

export function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("画像ファイルを作成できませんでした。")), type, quality);
  });
}

