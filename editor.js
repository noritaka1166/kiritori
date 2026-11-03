kiriLocalizeDocument();
const jobId = new URLSearchParams(location.search).get("job");
const restoredDraftId = new URLSearchParams(location.search).get("draft");
const canvas = document.querySelector("#canvas");
const wrap = document.querySelector("#canvas-wrap");
const overlay = document.querySelector("#overlay");
const selection = document.querySelector("#selection");
const ellipsePreview = document.querySelector("#ellipse-preview");
const arrowPreview = document.querySelector("#arrow-preview");
const arrowHead = document.querySelector("#arrow-head-path");
const hint = document.querySelector("#hint");
const draftStatus = document.querySelector("#draft-status");
const colorInput = document.querySelector("#color");
const presetColors = document.querySelector("#preset-colors");
const savedColorsRow = document.querySelector("#saved-colors-row");
const savedColorsElement = document.querySelector("#saved-colors");
const saveColorButton = document.querySelector("#save-color");
const paletteStatus = document.querySelector("#palette-status");
const sizeInput = document.querySelector("#size");
const mosaicBlockInput = document.querySelector("#mosaic-block");
const mosaicBlockLabel = document.querySelector("#mosaic-block-label");
const inlineText = document.querySelector("#inline-text");
const undoButton = document.querySelector("#undo");
const redoButton = document.querySelector("#redo");
const resetButton = document.querySelector("#reset");
const exportButton = document.querySelector("#export");
const cancelButton = document.querySelector("#cancel");
const fallback = document.querySelector("#fallback");
const objectControls = document.querySelector("#object-controls");
const objectLabel = document.querySelector("#object-label");
const objectSize = document.querySelector("#object-size");
const objectAngle = document.querySelector("#object-angle");
const objectAngleLabel = document.querySelector("#object-angle-label");
const objectLength = document.querySelector("#object-length");
const objectLengthLabel = document.querySelector("#object-length-label");
const objectText = document.querySelector("#object-text");
const objectTextLabel = document.querySelector("#object-text-label");
const objectDeselect = document.querySelector("#object-deselect");
const objectDelete = document.querySelector("#object-delete");
const objectSelection = document.querySelector("#object-selection");
const objectLine = document.querySelector("#object-line");
const objectStart = document.querySelector("#object-start");
const objectEnd = document.querySelector("#object-end");
const objectBox = document.querySelector("#object-box");
const textResizeHandle = document.querySelector("#text-resize-handle");
const textRotateHandle = document.querySelector("#text-rotate-handle");
const textRotateLine = document.querySelector("#text-rotate-line");
const toolButtons = [...document.querySelectorAll("[data-tool]")];
const context = canvas.getContext("2d", { alpha: false });
let draftDb, draftData, draftSourceUrl;
let draftWrite = Promise.resolve();
let draftClosed = false;
let draftRevision = 0;
function saveDraft() {
  if (!draftDb || !draftData || draftClosed || !history.length) return;
  const savedHistory = JSON.parse(JSON.stringify(history));
  if (inlineEdit) {
    const value = inlineText.value.trim().slice(0, 200);
    const operations = savedHistory[savedHistory.length - 1].operations;
    if (inlineEdit.index === null && value) operations.push({ ...inlineEdit.item, text: value });
    else if (inlineEdit.index !== null && operations[inlineEdit.index]) { if (value) operations[inlineEdit.index].text = value; else operations.splice(inlineEdit.index, 1); }
  }
  const revision = ++draftRevision;
  draftStatus.textContent = kiriT("下書きを保存中…");
  const update = chrome.runtime.sendMessage({ type: "draft:update", id: draftData.id, history: savedHistory, redoStack: JSON.parse(JSON.stringify(redoStack)), retentionDays: draftData.retentionDays }).then((response) => { if (!response?.ok) throw new Error("Draft update failed"); });
  draftWrite = Promise.all([draftWrite.catch(() => undefined), update]).then(() => undefined);
  draftWrite.then(() => { if (revision === draftRevision) draftStatus.textContent = kiriT("下書きを保存しました。"); }).catch(() => { if (revision === draftRevision) draftStatus.textContent = kiriT("下書きを保存できませんでした。"); });
}
async function deleteDraft() {
  draftClosed = true;
  await draftWrite.catch(() => undefined);
  if (draftDb && draftData) await draftDb.delete(draftData.id);
}
let sourceImage;
let history = [];
let redoStack = [];
let tool = "crop";
let selectedIndex = null;
let drag = null;
let pendingDragFrame = null;
let inlineEdit = null;
let outputUrl = null;
let submitted = false;
let terminal = false;
let port;
let heartbeat;
const presetPalette = [
  ["#e53935", "赤"], ["#fb8c00", "オレンジ"], ["#fdd835", "黄色"],
  ["#43a047", "緑"], ["#00acc1", "水色"], ["#1e88e5", "青"],
  ["#8e24aa", "紫"], ["#202124", "黒"], ["#ffffff", "白"]
];
const paletteStorageKey = "customAnnotationColors";
const maxSavedColors = 12;
let savedColors = [];
let paletteReady = false;
let paletteSaving = false;
let paletteDisabled = false;
let paletteRevision = 0;
let swatchButtons = [];

function normalizedColors(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((color) => typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color)).map((color) => color.toLowerCase()))].slice(0, maxSavedColors);
}

function syncPalette() {
  const selected = colorInput.value.toLowerCase();
  for (const { button, color } of swatchButtons) button.setAttribute("aria-pressed", String(color === selected));
}

function applyColor(color) {
  if (paletteDisabled || !/^#[0-9a-f]{6}$/i.test(color)) return;
  if (inlineEdit) finishInlineText();
  const normalized = color.toLowerCase();
  colorInput.value = normalized;
  syncPalette();
  const item = selectedIndex === null ? null : currentState()?.operations[selectedIndex];
  if (tool === "select" && item && ["text", "arrow", "line", "rect", "ellipse"].includes(item.type) && item.color.toLowerCase() !== normalized) {
    updateSelectedObject((selected) => { selected.color = normalized; });
  }
}

function makeSwatch(color, name) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "swatch";
  button.style.setProperty("--swatch", color);
  button.setAttribute("aria-label", kiriT("色を選択: $1", name));
  button.title = name;
  button.disabled = paletteDisabled;
  button.addEventListener("click", () => applyColor(color));
  swatchButtons.push({ button, color });
  return button;
}

function renderPalette() {
  swatchButtons = [];
  presetColors.replaceChildren();
  savedColorsElement.replaceChildren();
  for (const [color, name] of presetPalette) presetColors.append(makeSwatch(color, kiriT(name)));
  for (const color of savedColors) {
    const wrapper = document.createElement("span");
    wrapper.className = "saved-swatch";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-color";
    remove.textContent = "×";
    remove.setAttribute("aria-label", kiriT("登録色 $1 を削除", color));
    remove.title = kiriT("登録色 $1 を削除", color);
    remove.disabled = paletteDisabled || !paletteReady || paletteSaving;
    remove.addEventListener("click", () => persistPalette(savedColors.filter((value) => value !== color), "登録した色を削除しました。"));
    wrapper.append(makeSwatch(color, color), remove);
    savedColorsElement.append(wrapper);
  }
  savedColorsRow.hidden = savedColors.length === 0;
  saveColorButton.disabled = paletteDisabled || !paletteReady || paletteSaving;
  syncPalette();
}

async function persistPalette(next, successMessage) {
  if (paletteDisabled || !paletteReady || paletteSaving) return;
  paletteSaving = true;
  paletteStatus.textContent = "";
  renderPalette();
  const revision = paletteRevision;
  try {
    await chrome.storage.local.set({ [paletteStorageKey]: next });
    if (paletteRevision === revision) savedColors = normalizedColors(next);
    paletteStatus.textContent = kiriT(successMessage);
  } catch (_) {
    paletteStatus.textContent = kiriT("登録色を保存できませんでした。");
  } finally {
    paletteSaving = false;
    renderPalette();
  }
}

saveColorButton.addEventListener("click", () => {
  if (!paletteReady || paletteSaving || paletteDisabled) return;
  const color = colorInput.value.toLowerCase();
  if (savedColors.includes(color)) { paletteStatus.textContent = kiriT("この色は既に登録されています。"); return; }
  if (savedColors.length >= maxSavedColors) { paletteStatus.textContent = kiriT("登録色は最大12色です。"); return; }
  persistPalette([...savedColors, color], "色を登録しました。");
});
colorInput.addEventListener("input", syncPalette);
colorInput.addEventListener("change", () => applyColor(colorInput.value));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[paletteStorageKey]) return;
  paletteRevision += 1;
  savedColors = normalizedColors(changes[paletteStorageKey].newValue);
  renderPalette();
});
renderPalette();
const initialPaletteRevision = paletteRevision;
chrome.storage.local.get(paletteStorageKey).then((data) => {
  if (initialPaletteRevision === paletteRevision) savedColors = normalizedColors(data[paletteStorageKey]);
  paletteReady = true;
  renderPalette();
}).catch(() => {
  paletteStatus.textContent = kiriT("登録色を読み込めませんでした。");
});

const labels = {
  select: kiriT("文字や図形を選んで移動・調整できます。白い丸で大きさ、直線は両端を調整できます。"),
  crop: kiriT("残したい範囲をドラッグしてください。"),
  arrow: kiriT("矢印の始点から終点までドラッグしてください。"),
  line: kiriT("直線の始点から終点までドラッグしてください。"),
  rect: kiriT("四角を描く範囲をドラッグしてください。"),
  ellipse: kiriT("丸を描く範囲をドラッグしてください。"),
  text: kiriT("画像上の文字を入れたい場所をクリックして入力してください。Enterで確定します。"),
  mosaic: kiriT("ぼかしたい範囲をドラッグしてください。"),
  redact: kiriT("隠したい範囲をドラッグしてください。不透明に塗りつぶします。"),
  marker: kiriT("強調したい範囲をドラッグしてください。半透明の色で塗ります。")
};

function currentState() { return history[history.length - 1]; }
function cloneState() { return JSON.parse(JSON.stringify(currentState())); }

function selectTool(next) {
  if (inlineEdit) finishInlineText();
  cancelDragPreview();
  drag = null;
  clearOverlay();
  tool = next;
  mosaicBlockLabel.hidden = tool !== "mosaic";
  if (next !== "select") selectedIndex = null;
  for (const button of toolButtons) button.setAttribute("aria-pressed", String(button.dataset.tool === tool));
  hint.textContent = labels[tool];
  if (sourceImage) renderObjectSelection(currentState());
}

function updateButtons() {
  undoButton.disabled = history.length < 2 || submitted;
  redoButton.disabled = redoStack.length === 0 || submitted;
  resetButton.disabled = history.length < 2 || submitted || JSON.stringify(currentState()) === JSON.stringify(history[0]);
}

function render(state = currentState(), excludedIndex = null) {
  const crop = state.crop;
  if (canvas.width !== crop.width) canvas.width = crop.width;
  if (canvas.height !== crop.height) canvas.height = crop.height;
  wrap.style.width = `${Math.min(crop.width, 1100)}px`;
  overlay.setAttribute("viewBox", `0 0 ${crop.width} ${crop.height}`);
  context.drawImage(sourceImage, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);

  for (const [index, operation] of state.operations.entries()) {
    if (index === excludedIndex) continue;
    if (operation.type === "arrow") drawArrow(operation, crop);
    if (["line", "rect", "ellipse"].includes(operation.type)) drawShape(operation, crop);
    if (operation.type === "text") drawText(operation, crop);
    if (operation.type === "mosaic") drawMosaic(operation, crop);
    if (operation.type === "redact" || operation.type === "marker") drawFilledRectangle(operation, crop);
  }
  renderObjectSelection(state);
  updateButtons();
}

function drawArrow(item, crop) {
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

function drawShape(item, crop) {
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

function drawText(item, crop) {
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

function textBounds(item) {
  context.save();
  context.font = `${item.size}px -apple-system, BlinkMacSystemFont, sans-serif`;
  const width = context.measureText(item.text).width;
  context.restore();
  return { width: Math.max(1, width), height: item.size * 1.25 };
}

function textPoint(item, x, y) {
  const angle = (item.angle || 0) * Math.PI / 180;
  return { x: item.x + x * Math.cos(angle) - y * Math.sin(angle), y: item.y + x * Math.sin(angle) + y * Math.cos(angle) };
}

function positionInlineText() {
  if (!inlineEdit) return;
  const item = inlineEdit.item;
  const crop = currentState().crop;
  const scale = canvas.getBoundingClientRect().width / canvas.width;
  if (!Number.isFinite(scale) || scale <= 0) return;
  const sample = { ...item, text: inlineText.value || " " };
  const width = Math.max(textBounds(sample).width, textBounds(item).width);
  inlineText.style.left = `${(item.x - crop.x) * scale}px`;
  inlineText.style.top = `${(item.y - crop.y) * scale}px`;
  inlineText.style.fontSize = `${Math.max(12, item.size * scale)}px`;
  inlineText.style.width = `${Math.max(24, Math.min(600, width * scale + 12))}px`;
  inlineText.style.color = item.color;
  inlineText.style.transform = `rotate(${item.angle || 0}deg)`;
}

function startInlineText(item, index = null) {
  if (inlineEdit) finishInlineText();
  inlineEdit = { item: { ...item }, index };
  if (index !== null) render(currentState(), index);
  else hideObjectSelection();
  inlineText.value = item.text || "";
  inlineText.hidden = false;
  positionInlineText();
  inlineText.focus({ preventScroll: true });
  inlineText.setSelectionRange(inlineText.value.length, inlineText.value.length);
  hint.textContent = kiriT("画像の上で入力できます。Enterまたは別の場所をクリックすると確定します。");
}

function finishInlineText() {
  if (!inlineEdit) return;
  const edit = inlineEdit;
  const value = inlineText.value.trim().slice(0, 200);
  inlineEdit = null;
  inlineText.hidden = true;
  if (!sourceImage || submitted || terminal) return;
  const next = cloneState();
  if (edit.index === null) {
    if (!value) { hint.textContent = labels[tool]; return; }
    next.operations.push({ ...edit.item, text: value });
    selectTool("select");
    selectedIndex = next.operations.length - 1;
    addState(next);
  } else {
    const item = next.operations[edit.index];
    if (!item || item.type !== "text") { render(); return; }
    if (!value) {
      next.operations.splice(edit.index, 1);
      if (selectedIndex === edit.index) selectedIndex = null;
      else if (selectedIndex !== null && selectedIndex > edit.index) selectedIndex -= 1;
      addState(next);
    } else if (value !== item.text) {
      item.text = value;
      addState(next);
    } else {
      render();
    }
  }
  hint.textContent = labels[tool];
}

inlineText.addEventListener("input", () => { positionInlineText(); saveDraft(); });
inlineText.addEventListener("blur", finishInlineText);
inlineText.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key !== "Enter" && event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  finishInlineText();
  if (event.key === "Escape") deselectObject();
  toolButtons.find((button) => button.dataset.tool === tool)?.focus({ preventScroll: true });
});
window.addEventListener("resize", positionInlineText);

function hitRadius() {
  const width = canvas.getBoundingClientRect().width;
  return width ? Math.max(8, 10 * canvas.width / width) : 10;
}

function distanceToSegment(point, item) {
  const dx = item.x2 - item.x1, dy = item.y2 - item.y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - item.x1) * dx + (point.y - item.y1) * dy) / lengthSquared)) : 0;
  return Math.hypot(point.x - (item.x1 + t * dx), point.y - (item.y1 + t * dy));
}

function hitObject(point, state) {
  const radius = hitRadius();
  for (let index = state.operations.length - 1; index >= 0; index -= 1) {
    const item = state.operations[index];
    if (item.type === "redact" && point.x >= item.x && point.x <= item.x + item.width && point.y >= item.y && point.y <= item.y + item.height) return null;
    if (["arrow", "line"].includes(item.type) && distanceToSegment(point, item) <= Math.max(radius, item.size * .3)) return index;
    if (item.type === "rect") {
      const dx = Math.min(Math.abs(point.x - item.x), Math.abs(point.x - item.x - item.width));
      const dy = Math.min(Math.abs(point.y - item.y), Math.abs(point.y - item.y - item.height));
      if (point.x >= item.x - radius && point.x <= item.x + item.width + radius && point.y >= item.y - radius && point.y <= item.y + item.height + radius && (dx <= radius || dy <= radius)) return index;
    }
    if (item.type === "ellipse") {
      const rx = item.width / 2, ry = item.height / 2;
      const normalized = Math.hypot((point.x - item.x - rx) / rx, (point.y - item.y - ry) / ry);
      if (Math.abs(normalized - 1) * Math.min(rx, ry) <= radius) return index;
    }
    if (item.type === "text") {
      const angle = -(item.angle || 0) * Math.PI / 180;
      const dx = point.x - item.x, dy = point.y - item.y;
      const x = dx * Math.cos(angle) - dy * Math.sin(angle);
      const y = dx * Math.sin(angle) + dy * Math.cos(angle);
      const box = textBounds(item);
      if (x >= -radius / 2 && x <= box.width + radius / 2 && y >= -radius / 2 && y <= box.height + radius / 2) return index;
    }
  }
  return null;
}

function hideObjectSelection() {
  objectSelection.setAttribute("visibility", "hidden");
  for (const shape of [objectLine, objectStart, objectEnd, objectBox, textResizeHandle, textRotateHandle, textRotateLine]) shape.setAttribute("visibility", "hidden");
}

function renderObjectSelection(state) {
  if (inlineEdit) { hideObjectSelection(); return; }
  const item = tool === "select" && selectedIndex !== null ? state.operations[selectedIndex] : null;
  if (!item || !["text", "arrow", "line", "rect", "ellipse"].includes(item.type)) {
    hideObjectSelection();
    objectControls.hidden = true;
    return;
  }
  objectControls.hidden = false;
  objectLabel.textContent = ({ arrow: kiriT("矢印を調整"), text: kiriT("文字を調整"), line: kiriT("直線を調整"), rect: kiriT("四角を調整"), ellipse: kiriT("丸を調整") })[item.type];
  if (colorInput.value.toLowerCase() !== item.color.toLowerCase()) {
    colorInput.value = item.color;
    syncPalette();
  }
  objectSize.value = Math.round(item.size);
  const isLine = ["arrow", "line"].includes(item.type);
  const angle = isLine ? Math.atan2(item.y2 - item.y1, item.x2 - item.x1) * 180 / Math.PI : item.angle || 0;
  objectAngle.value = Math.round(angle);
  objectAngleLabel.hidden = ["rect", "ellipse"].includes(item.type);
  objectLengthLabel.hidden = !isLine;
  objectTextLabel.hidden = item.type !== "text";
  objectLength.value = isLine ? Math.round(Math.hypot(item.x2 - item.x1, item.y2 - item.y1)) : "";
  objectText.value = item.type === "text" ? item.text : "";
  objectSelection.setAttribute("visibility", "visible");
  const crop = state.crop;
  const radius = hitRadius() * .7;
  for (const shape of [objectLine, objectStart, objectEnd, objectBox, textResizeHandle, textRotateHandle, textRotateLine]) shape.setAttribute("vector-effect", "non-scaling-stroke");
  if (isLine) {
    objectBox.setAttribute("visibility", "hidden");
    for (const shape of [textResizeHandle, textRotateHandle, textRotateLine]) shape.setAttribute("visibility", "hidden");
    for (const shape of [objectLine, objectStart, objectEnd]) shape.setAttribute("visibility", "visible");
    for (const [name, value] of Object.entries({ x1: item.x1 - crop.x, y1: item.y1 - crop.y, x2: item.x2 - crop.x, y2: item.y2 - crop.y })) objectLine.setAttribute(name, value);
    for (const [circle, x, y] of [[objectStart, item.x1, item.y1], [objectEnd, item.x2, item.y2]]) {
      circle.setAttribute("cx", x - crop.x); circle.setAttribute("cy", y - crop.y); circle.setAttribute("r", radius);
    }
  } else if (item.type === "text") {
    for (const shape of [objectLine, objectStart, objectEnd]) shape.setAttribute("visibility", "hidden");
    objectBox.setAttribute("visibility", "visible");
    const box = textBounds(item);
    objectBox.setAttribute("x", 0); objectBox.setAttribute("y", 0);
    objectBox.setAttribute("width", box.width); objectBox.setAttribute("height", box.height);
    objectBox.setAttribute("transform", `translate(${item.x - crop.x} ${item.y - crop.y}) rotate(${item.angle || 0})`);
    const corner = textPoint(item, box.width, box.height);
    let origin = textPoint(item, box.width / 2, 0);
    let rotate = textPoint(item, box.width / 2, -radius * 4);
    const rotateBelow = drag?.handle === "text-rotate" ? drag.rotateBelow : rotate.y < crop.y;
    if (rotateBelow) {
      origin = textPoint(item, box.width / 2, box.height);
      rotate = textPoint(item, box.width / 2, box.height + radius * 4);
    }
    for (const [circle, location] of [[textResizeHandle, corner], [textRotateHandle, rotate]]) {
      circle.setAttribute("cx", location.x - crop.x); circle.setAttribute("cy", location.y - crop.y);
      circle.setAttribute("r", radius); circle.setAttribute("visibility", "visible");
    }
    textRotateLine.setAttribute("x1", origin.x - crop.x); textRotateLine.setAttribute("y1", origin.y - crop.y);
    textRotateLine.setAttribute("x2", rotate.x - crop.x); textRotateLine.setAttribute("y2", rotate.y - crop.y);
    textRotateLine.setAttribute("visibility", "visible");
  } else {
    for (const shape of [objectLine, objectStart, objectEnd, textRotateHandle, textRotateLine]) shape.setAttribute("visibility", "hidden");
    objectBox.setAttribute("visibility", "visible");
    objectBox.setAttribute("x", item.x - crop.x); objectBox.setAttribute("y", item.y - crop.y);
    objectBox.setAttribute("width", item.width); objectBox.setAttribute("height", item.height);
    objectBox.setAttribute("transform", "");
    textResizeHandle.setAttribute("cx", item.x + item.width - crop.x);
    textResizeHandle.setAttribute("cy", item.y + item.height - crop.y);
    textResizeHandle.setAttribute("r", radius); textResizeHandle.setAttribute("visibility", "visible");
  }
}

function drawMosaic(item, crop) {
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

function drawFilledRectangle(item, crop) {
  context.save();
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = item.type === "redact" ? 1 : 0.35;
  context.fillStyle = item.color;
  context.fillRect(item.x - crop.x, item.y - crop.y, item.width, item.height);
  context.restore();
}

function point(event, clamp = true) {
  const box = canvas.getBoundingClientRect();
  const crop = currentState().crop;
  const x = (event.clientX - box.left) * canvas.width / box.width;
  const y = (event.clientY - box.top) * canvas.height / box.height;
  return {
    x: crop.x + (clamp ? Math.max(0, Math.min(canvas.width, x)) : x),
    y: crop.y + (clamp ? Math.max(0, Math.min(canvas.height, y)) : y)
  };
}

function rectangle(a, b) {
  return { x: Math.round(Math.min(a.x, b.x)), y: Math.round(Math.min(a.y, b.y)), width: Math.round(Math.abs(a.x - b.x)), height: Math.round(Math.abs(a.y - b.y)) };
}

function coveringRectangle(a, b) {
  const left = Math.floor(Math.min(a.x, b.x));
  const top = Math.floor(Math.min(a.y, b.y));
  const right = Math.ceil(Math.max(a.x, b.x));
  const bottom = Math.ceil(Math.max(a.y, b.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function size() { return Math.max(12, Math.min(160, Number(sizeInput.value) || 36)); }

function addState(next) {
  redoStack = [];
  history.push(next);
  render();
  saveDraft();
}

function clearOverlay() {
  selection.setAttribute("visibility", "hidden");
  ellipsePreview.setAttribute("visibility", "hidden");
  arrowPreview.setAttribute("visibility", "hidden");
}

function movedObjectState(dragState, end) {
  const next = { ...dragState.base, operations: dragState.base.operations.slice() };
  const item = { ...next.operations[dragState.index] };
  next.operations[dragState.index] = item;
  const dx = end.x - dragState.start.x, dy = end.y - dragState.start.y;
  if (["arrow", "line"].includes(item.type)) {
    if (dragState.handle !== "end") { item.x1 += dx; item.y1 += dy; }
    if (dragState.handle !== "start") { item.x2 += dx; item.y2 += dy; }
  } else if (dragState.handle === "shape-resize") {
    item.width = Math.max(4, item.width + dx);
    item.height = Math.max(4, item.height + dy);
  } else if (dragState.handle === "text-resize") {
    const { width, height } = dragState.bounds;
    const angle = (item.angle || 0) * Math.PI / 180;
    const diagonalX = width * Math.cos(angle) - height * Math.sin(angle);
    const diagonalY = width * Math.sin(angle) + height * Math.cos(angle);
    const factor = 1 + (dx * diagonalX + dy * diagonalY) / (width * width + height * height);
    item.size = Math.max(12, Math.min(500, item.size * factor));
  } else if (dragState.handle === "text-rotate") {
    const center = dragState.center;
    const startAngle = Math.atan2(dragState.start.y - center.y, dragState.start.x - center.x);
    const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
    const angle = (item.angle || 0) * Math.PI / 180 + endAngle - startAngle;
    const normalized = Math.atan2(Math.sin(angle), Math.cos(angle));
    item.angle = normalized * 180 / Math.PI;
    item.x = center.x - (dragState.bounds.width / 2 * Math.cos(normalized) - dragState.bounds.height / 2 * Math.sin(normalized));
    item.y = center.y - (dragState.bounds.width / 2 * Math.sin(normalized) + dragState.bounds.height / 2 * Math.cos(normalized));
  } else {
    item.x += dx; item.y += dy;
  }
  return next;
}

function cancelDragPreview() {
  if (pendingDragFrame !== null) cancelAnimationFrame(pendingDragFrame);
  pendingDragFrame = null;
}

function scheduleDragPreview() {
  if (pendingDragFrame !== null) return;
  const currentDrag = drag;
  pendingDragFrame = requestAnimationFrame(() => {
    pendingDragFrame = null;
    if (drag !== currentDrag || tool !== "select") return;
    renderObjectSelection(movedObjectState(currentDrag, currentDrag.current));
  });
}

function startTextHandleDrag(event, handle) {
  if (!sourceImage || submitted || terminal || tool !== "select" || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  if (inlineEdit) finishInlineText();
  if (objectControls.contains(document.activeElement)) document.activeElement.blur();
  const state = currentState();
  const item = selectedIndex === null ? null : state.operations[selectedIndex];
  if (!item || !["text", "rect", "ellipse"].includes(item.type) || (handle === "text-rotate" && item.type !== "text")) return;
  if (item.type !== "text") handle = "shape-resize";
  const bounds = item.type === "text" ? textBounds(item) : { width: item.width, height: item.height };
  const start = point(event, false);
  const rotateBelow = textPoint(item, bounds.width / 2, -hitRadius() * .7 * 4).y < state.crop.y;
  drag = { start, current: start, index: selectedIndex, handle, base: state, bounds, center: textPoint(item, bounds.width / 2, bounds.height / 2), rotateBelow };
  canvas.setPointerCapture(event.pointerId);
}

textResizeHandle.addEventListener("pointerdown", (event) => startTextHandleDrag(event, "text-resize"));
textRotateHandle.addEventListener("pointerdown", (event) => startTextHandleDrag(event, "text-rotate"));

canvas.addEventListener("pointerdown", (event) => {
  if (!sourceImage || submitted || terminal || event.button !== 0) return;
  if (inlineEdit) finishInlineText();
  if (objectControls.contains(document.activeElement)) document.activeElement.blur();
  const start = point(event);
  if (tool === "select") {
    const state = currentState();
    let index = selectedIndex;
    let item = index === null ? null : state.operations[index];
    let handle = "move";
    const radius = hitRadius();
    if (["arrow", "line"].includes(item?.type) && Math.hypot(start.x - item.x1, start.y - item.y1) <= radius) handle = "start";
    else if (["arrow", "line"].includes(item?.type) && Math.hypot(start.x - item.x2, start.y - item.y2) <= radius) handle = "end";
    else { index = hitObject(start, state); item = index === null ? null : state.operations[index]; }
    selectedIndex = index;
    renderObjectSelection(state);
    if (!item) return;
    // 調整欄が現れて画像が下に移動しても、クリックだけで要素が動かないようにする。
    const dragStart = point(event);
    drag = { start: dragStart, current: dragStart, index, handle, base: state };
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (tool === "text") {
    event.preventDefault();
    startInlineText({ type: "text", x: start.x, y: start.y, text: "", size: size(), color: colorInput.value });
    return;
  }
  drag = { start, current: start };
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  if (!drag) return;
  drag.current = point(event, !/^(text|shape)-/.test(drag.handle || ""));
  if (tool === "select") {
    scheduleDragPreview();
    return;
  }
  const crop = currentState().crop;
  if (tool === "arrow" || tool === "line") {
    arrowPreview.setAttribute("x1", drag.start.x - crop.x); arrowPreview.setAttribute("y1", drag.start.y - crop.y);
    arrowPreview.setAttribute("x2", drag.current.x - crop.x); arrowPreview.setAttribute("y2", drag.current.y - crop.y);
    arrowPreview.setAttribute("stroke", colorInput.value); arrowHead.setAttribute("fill", colorInput.value);
    arrowPreview.setAttribute("marker-end", tool === "arrow" ? "url(#arrow-head)" : "none");
    arrowPreview.setAttribute("stroke-width", Math.max(3, size() * .13)); arrowPreview.setAttribute("visibility", "visible");
  } else if (tool === "ellipse") {
    const rect = rectangle(drag.start, drag.current);
    ellipsePreview.setAttribute("cx", rect.x - crop.x + rect.width / 2); ellipsePreview.setAttribute("cy", rect.y - crop.y + rect.height / 2);
    ellipsePreview.setAttribute("rx", rect.width / 2); ellipsePreview.setAttribute("ry", rect.height / 2);
    ellipsePreview.setAttribute("stroke", colorInput.value); ellipsePreview.setAttribute("stroke-width", Math.max(3, size() * .13));
    ellipsePreview.setAttribute("visibility", "visible");
  } else {
    const rect = rectangle(drag.start, drag.current);
    selection.setAttribute("x", rect.x - crop.x); selection.setAttribute("y", rect.y - crop.y);
    selection.setAttribute("width", rect.width); selection.setAttribute("height", rect.height);
    selection.setAttribute("fill", tool === "rect" ? "none" : "rgba(26,115,232,.15)");
    selection.setAttribute("stroke", tool === "rect" ? colorInput.value : "#1a73e8");
    selection.setAttribute("visibility", "visible");
  }
});

canvas.addEventListener("pointerup", (event) => {
  if (!drag) return;
  const end = point(event, !/^(text|shape)-/.test(drag.handle || ""));
  const start = drag.start;
  if (tool === "select") {
    const originalDrag = drag;
    drag = null;
    cancelDragPreview();
    if (Math.hypot(end.x - start.x, end.y - start.y) >= 0.5) addState(movedObjectState(originalDrag, end));
    else {
      renderObjectSelection(currentState());
      const item = currentState().operations[selectedIndex];
      if (item?.type === "text" && !originalDrag.handle?.startsWith("text-")) {
        event.preventDefault();
        startInlineText(item, selectedIndex);
      }
    }
    return;
  }
  drag = null;
  clearOverlay();
  const rect = rectangle(start, end);
  const next = cloneState();
  if (tool === "crop" && rect.width >= 4 && rect.height >= 4) {
    next.crop = rect;
  } else if (tool === "mosaic" && rect.width >= 4 && rect.height >= 4) {
    const blockSize = Math.max(2, Math.min(160, Math.floor(Number(mosaicBlockInput.value) || 12)));
    mosaicBlockInput.value = blockSize;
    next.operations.push({ type: "mosaic", ...rect, blockSize });
  } else if ((tool === "redact" || tool === "marker") && rect.width >= 4 && rect.height >= 4) {
    const area = tool === "redact" ? coveringRectangle(start, end) : rect;
    next.operations.push({ type: tool, ...area, color: colorInput.value });
  } else if ((tool === "rect" || tool === "ellipse") && rect.width >= 4 && rect.height >= 4) {
    next.operations.push({ type: tool, ...rect, size: size(), color: colorInput.value });
  } else if ((tool === "arrow" || tool === "line") && Math.hypot(end.x - start.x, end.y - start.y) >= 4) {
    next.operations.push({ type: tool, x1: start.x, y1: start.y, x2: end.x, y2: end.y, size: size(), color: colorInput.value });
  } else {
    return;
  }
  addState(next);
});
canvas.addEventListener("pointercancel", () => { drag = null; cancelDragPreview(); clearOverlay(); if (sourceImage) renderObjectSelection(currentState()); });

for (const button of toolButtons) button.addEventListener("click", () => selectTool(button.dataset.tool));

function navigateHistory(direction) {
  if (submitted || terminal || !sourceImage) return;
  if (inlineEdit) finishInlineText();
  drag = null;
  cancelDragPreview();
  clearOverlay();
  selectedIndex = null;
  if (direction === "undo" && history.length > 1) redoStack.push(history.pop());
  else if (direction === "redo" && redoStack.length) history.push(redoStack.pop());
  render();
  saveDraft();
}

undoButton.addEventListener("click", () => navigateHistory("undo"));
redoButton.addEventListener("click", () => navigateHistory("redo"));
resetButton.addEventListener("click", () => {
  if (submitted || terminal || !sourceImage) return;
  if (inlineEdit) finishInlineText();
  if (history.length < 2 || JSON.stringify(currentState()) === JSON.stringify(history[0])) return;
  drag = null;
  cancelDragPreview();
  clearOverlay();
  selectedIndex = null;
  addState(JSON.parse(JSON.stringify(history[0])));
});

document.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229 || event.altKey || (!event.metaKey && !event.ctrlKey) || event.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const key = event.key.toLowerCase();
  const direction = key === "z" ? (event.shiftKey ? "redo" : "undo") : key === "y" && !event.shiftKey ? "redo" : null;
  if (!direction || submitted || terminal || !sourceImage) return;
  event.preventDefault();
  navigateHistory(direction);
});

function updateSelectedObject(change) {
  if (submitted || terminal || selectedIndex === null || !currentState()?.operations[selectedIndex]) return;
  const next = cloneState();
  const item = next.operations[selectedIndex];
  if (change(item) === false) { render(); return; }
  addState(next);
}

objectSize.addEventListener("change", () => updateSelectedObject((item) => {
  const value = Number(objectSize.value);
  if (!objectSize.value || !Number.isFinite(value)) return false;
  item.size = Math.max(12, Math.min(500, value));
}));
objectAngle.addEventListener("change", () => updateSelectedObject((item) => {
  const value = Number(objectAngle.value);
  if (!objectAngle.value || !Number.isFinite(value)) return false;
  const angle = Math.max(-360, Math.min(360, value));
  if (item.type === "text") item.angle = angle;
  else {
    const length = Math.hypot(item.x2 - item.x1, item.y2 - item.y1);
    item.x2 = item.x1 + length * Math.cos(angle * Math.PI / 180);
    item.y2 = item.y1 + length * Math.sin(angle * Math.PI / 180);
  }
}));
objectLength.addEventListener("change", () => updateSelectedObject((item) => {
  if (!["arrow", "line"].includes(item.type)) return false;
  const value = Number(objectLength.value);
  if (!objectLength.value || !Number.isFinite(value)) return false;
  const length = Math.max(4, Math.min(100000, value));
  const angle = Math.atan2(item.y2 - item.y1, item.x2 - item.x1);
  item.x2 = item.x1 + length * Math.cos(angle);
  item.y2 = item.y1 + length * Math.sin(angle);
}));
objectText.addEventListener("change", () => updateSelectedObject((item) => {
  if (item.type !== "text" || !objectText.value.trim()) return false;
  item.text = objectText.value.trim().slice(0, 200);
}));
function deselectObject() {
  if (inlineEdit) finishInlineText();
  if (submitted || terminal || selectedIndex === null) return;
  // 調整欄からフォーカスを移し、編集中の値を確定してから選択を解除する。
  if (objectControls.contains(document.activeElement)) {
    toolButtons.find((button) => button.dataset.tool === "select")?.focus();
  }
  drag = null;
  cancelDragPreview();
  selectedIndex = null;
  clearOverlay();
  renderObjectSelection(currentState());
}

objectDeselect.addEventListener("click", deselectObject);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.isComposing || tool !== "select" || selectedIndex === null || submitted || terminal) return;
  event.preventDefault();
  deselectObject();
});
objectDelete.addEventListener("click", () => {
  if (inlineEdit) finishInlineText();
  if (submitted || terminal || selectedIndex === null) return;
  const next = cloneState();
  next.operations.splice(selectedIndex, 1);
  selectedIndex = null;
  addState(next);
});

function setEditingDisabled(disabled) {
  paletteDisabled = disabled;
  for (const element of [...toolButtons, colorInput, sizeInput, mosaicBlockInput, inlineText, objectSize, objectAngle, objectLength, objectText, objectDeselect, objectDelete, undoButton, redoButton, resetButton, exportButton]) element.disabled = disabled;
  renderPalette();
  if (!disabled) updateButtons();
}

exportButton.addEventListener("click", async () => {
  if (submitted || !sourceImage) return;
  if (inlineEdit) finishInlineText();
  submitted = true;
  setEditingDisabled(true);
  cancelButton.disabled = true;
  hint.textContent = kiriT("編集した画像を出力しています…");
  try {
    const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error(kiriT("画像を作成できませんでした。"))), "image/png"));
    outputUrl = URL.createObjectURL(blob);
    const response = restoredDraftId
      ? await chrome.runtime.sendMessage({ type: "draft:export", id: restoredDraftId, url: outputUrl })
      : await chrome.runtime.sendMessage({ type: "capture:editor:commit", jobId, url: outputUrl });
    if (!response?.ok) throw new Error(response?.error || kiriT("画像を出力できませんでした。"));
    if (restoredDraftId) { draftClosed = true; await draftWrite.catch(() => undefined); terminal = true; hint.textContent = response.message || kiriT("出力しました。"); cancelButton.disabled = false; cancelButton.textContent = kiriT("閉じる"); }
  } catch (error) {
    submitted = false;
    setEditingDisabled(false);
    cancelButton.disabled = false;
    hint.textContent = kiriT(error?.message || "画像を出力できませんでした。");
  }
});

cancelButton.addEventListener("click", async () => {
  if (terminal || restoredDraftId) {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id) await chrome.tabs.remove(tab.id);
      else window.close();
    } catch (_) { window.close(); }
    return;
  }
  cancelButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "capture:cancel", jobId });
    if (!result?.ok) throw new Error(result?.error || kiriT("キャンセルできませんでした。"));
    await deleteDraft().catch(() => undefined);
    if (!terminal) hint.textContent = kiriT("キャンセルしています…");
  } catch (error) {
    cancelButton.disabled = false;
    hint.textContent = kiriT(error?.message || "キャンセルできませんでした。");
  }
});

chrome.runtime.onMessage.addListener((message) => {
  const state = message?.status;
  if (message?.type !== "capture:progress" || state?.jobId !== jobId || state.active) return;
  if (inlineEdit) finishInlineText();
  terminal = true;
  if (state.phase === "completed") draftClosed = true;
  clearInterval(heartbeat);
  hint.textContent = state.message || (state.phase === "completed" ? kiriT("出力しました。") : kiriT("撮影を終了しました。"));
  cancelButton.disabled = false;
  cancelButton.textContent = kiriT("閉じる");
  setEditingDisabled(true);
  if (state.phase === "error" && outputUrl) { fallback.href = outputUrl; fallback.hidden = false; }
});

window.addEventListener("beforeunload", () => {
  clearInterval(heartbeat);
  if (outputUrl) URL.revokeObjectURL(outputUrl);
  if (draftSourceUrl) URL.revokeObjectURL(draftSourceUrl);
});

async function initialize() {
  if ((!jobId && !restoredDraftId) || !context) throw new Error(kiriT("編集する画像が見つかりません。"));
  try { draftDb = (await import("./draft-store.js")).draftStore; await draftDb.deleteExpired(); } catch (_) { draftStatus.textContent = kiriT("下書きを保存できませんでした。"); }
  if (restoredDraftId) {
    if (!draftDb) throw new Error(kiriT("下書きを読み込めませんでした。"));
    draftData = await draftDb.get(restoredDraftId);
    if (!draftData || draftData.expiresAt <= Date.now()) throw new Error(kiriT("下書きが見つからないか、保存期限が過ぎています。"));
    const settings = await chrome.storage.local.get("draftRetentionDays");
    const retentionDays = [0, 1, 7, 30].includes(settings.draftRetentionDays) ? settings.draftRetentionDays : 7;
    if (retentionDays === 0) draftClosed = true;
    else draftData.retentionDays = retentionDays;
    draftSourceUrl = URL.createObjectURL(draftData.source); sourceImage = new Image(); sourceImage.src = draftSourceUrl; await sourceImage.decode();
    history = draftData.history; redoStack = draftData.redoStack || []; render();
    exportButton.textContent = ({ save: kiriT("保存"), copy: kiriT("コピー"), both: kiriT("保存してコピー") })[draftData.options.destination] || kiriT("出力");
    exportButton.disabled = false; cancelButton.textContent = kiriT("閉じる"); selectTool("crop"); return;
  }
  port = chrome.runtime.connect({ name: "kiritori-editor" });
  port.onDisconnect.addListener(() => {
    if (terminal) return;
    if (inlineEdit) finishInlineText();
    terminal = true;
    clearInterval(heartbeat);
    hint.textContent = kiriT("編集の接続が切れました。編集画像をPNGとして保存できます。");
    setEditingDisabled(true);
    cancelButton.disabled = false;
    cancelButton.textContent = kiriT("閉じる");
    if (canvas.width && canvas.height && sourceImage) {
      canvas.toBlob((blob) => {
        if (!blob) return;
        if (outputUrl) URL.revokeObjectURL(outputUrl);
        outputUrl = URL.createObjectURL(blob);
        fallback.href = outputUrl;
        fallback.hidden = false;
      }, "image/png");
    }
  });
  port.postMessage({ type: "hello", jobId });
  heartbeat = setInterval(() => { try { port.postMessage({ type: "heartbeat" }); } catch (_) { clearInterval(heartbeat); } }, 20_000);
  const response = await chrome.runtime.sendMessage({ type: "capture:editor:load", jobId });
  if (!response?.ok) throw new Error(response?.error || kiriT("画像を読み込めませんでした。"));
  sourceImage = new Image();
  sourceImage.src = response.url;
  await sourceImage.decode();
  if (terminal) return;
  history = [{ crop: { x: 0, y: 0, width: sourceImage.naturalWidth, height: sourceImage.naturalHeight }, operations: [] }];
  if (draftDb && response.meta && response.options) {
    try {
      const settings = await chrome.storage.local.get("draftRetentionDays");
      const retentionDays = [0, 1, 7, 30].includes(settings.draftRetentionDays) ? settings.draftRetentionDays : 7;
      if (retentionDays > 0) {
        const source = await (await fetch(response.url)).blob();
        const width = response.meta.mode === "scroll-area" ? response.meta.scrollArea.clientWidth : response.meta.mode === "region" ? response.meta.region.width : response.meta.viewportWidth;
        draftData = { id: jobId, source, meta: response.meta, options: response.options, scale: sourceImage.naturalWidth / width, retentionDays };
        const now = Date.now();
        await draftDb.put({ ...draftData, history, redoStack, updatedAt: now, expiresAt: now + retentionDays * 86400000 });
        draftStatus.textContent = kiriT("下書きを保存しました。");
      }
    } catch (_) { draftStatus.textContent = kiriT("下書きを保存できませんでした。"); }
  }
  render();
  exportButton.textContent = ({ save: kiriT("保存"), copy: kiriT("コピー"), both: kiriT("保存してコピー") })[response.destination] || kiriT("出力");
  exportButton.disabled = false;
  selectTool("crop");
}

initialize().catch((error) => {
  hint.textContent = kiriT(error?.message || "画像を読み込めませんでした。");
  cancelButton.textContent = kiriT("閉じる");
  terminal = true;
  clearInterval(heartbeat);
  if (jobId) chrome.runtime.sendMessage({ type: "capture:cancel", jobId }).catch(() => undefined);
});
