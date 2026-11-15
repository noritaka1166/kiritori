// Geometry, hit testing, and rendering for editor annotations. The same canvas
// context is used for measurement, drawing, and mosaic sampling.

export function drawOperation(operation, crop, canvas, context) {
  switch (operation.type) {
    case "arrow":
      drawArrow(operation, crop, context);
      break;
    case "line":
    case "rect":
    case "ellipse":
      drawShape(operation, crop, context);
      break;
    case "text":
      drawText(operation, crop, context);
      break;
    case "number":
      drawNumberMarker(operation, crop, context);
      break;
    case "mosaic":
      drawMosaic(operation, crop, canvas, context);
      break;
    case "redact":
    case "marker":
      drawFilledRectangle(operation, crop, context);
      break;
  }
}

export function drawArrow(item, crop, context) {
  const x1 = item.x1 - crop.x, y1 = item.y1 - crop.y;
  const x2 = item.x2 - crop.x, y2 = item.y2 - crop.y;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const length = Math.max(14, item.size * .65);
  context.save();
  context.strokeStyle = item.color;
  context.fillStyle = item.color;
  context.lineWidth = Math.max(3, item.size * .13);
  context.lineCap = "round";
  context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke();
  context.beginPath(); context.moveTo(x2, y2);
  context.lineTo(x2 - length * Math.cos(angle - Math.PI / 6), y2 - length * Math.sin(angle - Math.PI / 6));
  context.lineTo(x2 - length * Math.cos(angle + Math.PI / 6), y2 - length * Math.sin(angle + Math.PI / 6));
  context.closePath(); context.fill(); context.restore();
}

export function drawShape(item, crop, context) {
  context.save();
  context.strokeStyle = item.color;
  context.lineWidth = Math.max(3, item.size * .13);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  if (item.type === "line") {
    context.moveTo(item.x1 - crop.x, item.y1 - crop.y);
    context.lineTo(item.x2 - crop.x, item.y2 - crop.y);
  } else if (item.type === "rect") {
    context.rect(item.x - crop.x, item.y - crop.y, item.width, item.height);
  } else {
    context.ellipse(item.x - crop.x + item.width / 2, item.y - crop.y + item.height / 2, item.width / 2, item.height / 2, 0, 0, Math.PI * 2);
  }
  context.stroke();
  context.restore();
}

export function drawNumberMarker(item, crop, context) {
  const radius = item.size / 2;
  const rgb = item.color.match(/[0-9a-f]{2}/gi).map(value => Number.parseInt(value, 16));
  const brightness = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000;
  context.save(); context.fillStyle = item.color; context.beginPath();
  context.arc(item.x - crop.x, item.y - crop.y, radius, 0, Math.PI * 2); context.fill();
  context.fillStyle = brightness >= 160 ? "#000000" : "#ffffff";
  context.font = `bold ${Math.max(8, item.size * (item.number >= 100 ? .40 : .55))}px -apple-system, BlinkMacSystemFont, sans-serif`;
  context.textAlign = "center"; context.textBaseline = "middle";
  context.fillText(String(item.number), item.x - crop.x, item.y - crop.y, item.size * .85); context.restore();
}

export function drawText(item, crop, context) {
  context.save();
  context.font = `${item.size}px -apple-system, BlinkMacSystemFont, sans-serif`;
  context.textBaseline = "top";
  context.lineJoin = "round";
  context.lineWidth = Math.max(2, item.size / 12);
  context.strokeStyle = "white";
  context.fillStyle = item.color;
  context.translate(item.x - crop.x, item.y - crop.y);
  context.rotate((item.angle || 0) * Math.PI / 180);
  context.strokeText(item.text, 0, 0);
  context.fillText(item.text, 0, 0);
  context.restore();
}

export function textBounds(item, context) {
  context.save();
  context.font = `${item.size}px -apple-system, BlinkMacSystemFont, sans-serif`;
  const width = context.measureText(item.text).width;
  context.restore();
  return { width: Math.max(1, width), height: item.size * 1.25 };
}

export function textPoint(item, x, y) {
  const angle = (item.angle || 0) * Math.PI / 180;
  return { x: item.x + x * Math.cos(angle) - y * Math.sin(angle), y: item.y + x * Math.sin(angle) + y * Math.cos(angle) };
}

export function hitRadius(canvas) {
  const width = canvas.getBoundingClientRect().width;
  return width ? Math.max(8, 10 * canvas.width / width) : 10;
}

export function distanceToSegment(point, item) {
  const dx = item.x2 - item.x1, dy = item.y2 - item.y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - item.x1) * dx + (point.y - item.y1) * dy) / lengthSquared)) : 0;
  return Math.hypot(point.x - (item.x1 + t * dx), point.y - (item.y1 + t * dy));
}

export const blockedObjectHit = Symbol("blocked object hit");

export function hitNumber(point, item, radius) {
  return Math.hypot(point.x - item.x, point.y - item.y) <= item.size / 2 + radius / 2;
}

export function hitRedaction(point, item) {
  const inside = point.x >= item.x && point.x <= item.x + item.width
    && point.y >= item.y && point.y <= item.y + item.height;
  return inside ? blockedObjectHit : false;
}

export function hitLine(point, item, radius) {
  return distanceToSegment(point, item) <= Math.max(radius, item.size * .3);
}

export function hitRectangle(point, item, radius) {
  const dx = Math.min(Math.abs(point.x - item.x), Math.abs(point.x - item.x - item.width));
  const dy = Math.min(Math.abs(point.y - item.y), Math.abs(point.y - item.y - item.height));
  const insideBounds = point.x >= item.x - radius && point.x <= item.x + item.width + radius
    && point.y >= item.y - radius && point.y <= item.y + item.height + radius;
  return insideBounds && (dx <= radius || dy <= radius);
}

export function hitEllipse(point, item, radius) {
  const rx = item.width / 2, ry = item.height / 2;
  const normalized = Math.hypot((point.x - item.x - rx) / rx, (point.y - item.y - ry) / ry);
  return Math.abs(normalized - 1) * Math.min(rx, ry) <= radius;
}

export function hitText(point, item, radius, context) {
  const angle = -(item.angle || 0) * Math.PI / 180;
  const dx = point.x - item.x, dy = point.y - item.y;
  const x = dx * Math.cos(angle) - dy * Math.sin(angle);
  const y = dx * Math.sin(angle) + dy * Math.cos(angle);
  const box = textBounds(item, context);
  return x >= -radius / 2 && x <= box.width + radius / 2
    && y >= -radius / 2 && y <= box.height + radius / 2;
}

export const objectHitTests = {
  number: hitNumber,
  redact: hitRedaction,
  arrow: hitLine,
  line: hitLine,
  rect: hitRectangle,
  ellipse: hitEllipse,
  text: hitText
};

export function hitObject(point, state, canvas, context) {
  const radius = hitRadius(canvas);
  for (let index = state.operations.length - 1; index >= 0; index -= 1) {
    const item = state.operations[index];
    const hitTest = objectHitTests[item.type];
    const result = hitTest?.(point, item, radius, context);
    if (result === blockedObjectHit) return null;
    if (result) return index;
  }
  return null;
}

export function drawMosaic(item, crop, canvas, context) {
  const left = Math.max(0, item.x - crop.x), top = Math.max(0, item.y - crop.y);
  const right = Math.min(canvas.width, item.x + item.width - crop.x);
  const bottom = Math.min(canvas.height, item.y + item.height - crop.y);
  const width = right - left, height = bottom - top;
  if (width <= 0 || height <= 0) return;
  const small = document.createElement("canvas");
  const block = Math.max(2, Math.min(160, Number(item.blockSize ?? item.size) || 12));
  small.width = Math.max(1, Math.ceil(width / block));
  small.height = Math.max(1, Math.ceil(height / block));
  const smallContext = small.getContext("2d");
  smallContext.drawImage(canvas, left, top, width, height, 0, 0, small.width, small.height);
  context.save(); context.imageSmoothingEnabled = false;
  context.drawImage(small, 0, 0, small.width, small.height, left, top, width, height);
  context.restore();
}

export function drawFilledRectangle(item, crop, context) {
  context.save();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = item.type === "redact" ? 1 : 0.35;
  context.fillStyle = item.color;
  context.fillRect(item.x - crop.x, item.y - crop.y, item.width, item.height);
  context.restore();
}
