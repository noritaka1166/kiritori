import test from "node:test";
import assert from "node:assert/strict";
import { makePdf } from "../pdf-output.js";
import { appendHistory, navigateHistoryStacks, historyForDraft } from "../editor-history.js";
import { shouldShowCaptureProgress, getProgressMessage } from "../popup-progress.js";
import { validateScrollableAreaBounds, validatePaginatedScrollPosition } from "../capture-validation.js";

test("PDF output contains each page and valid cross-reference offsets", async () => {
  const jpeg = new Blob([Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)], { type: "image/jpeg" });
  const page = (width, height) => ({ width, height, toBlob: callback => callback(jpeg) });
  const pdf = await makePdf(null, null, [page(100, 200), page(300, 100)]);
  assert.equal(pdf.type, "application/pdf");
  const bytes = Buffer.from(await pdf.arrayBuffer());
  const text = bytes.toString("latin1");
  assert.match(text, /\/Count 2\b/);
  assert.match(text, /\/MediaBox \[0 0 75\.00 150\.00\]/);
  assert.match(text, /\/MediaBox \[0 0 225\.00 75\.00\]/);
  const offset = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(offset, offset + 4), "xref");
  const entries = text.slice(offset).split("\n").slice(3, 11);
  entries.forEach((entry, index) => {
    const objectOffset = Number(entry.slice(0, 10));
    assert.ok(text.startsWith(`${index + 1} 0 obj`, objectOffset));
  });
});

test("PDF slicing releases temporary canvases after encoding", async () => {
  const created = [];
  const original = globalThis.document;
  globalThis.document = { createElement: () => {
    const canvas = { getContext: () => ({ drawImage() {} }), toBlob: callback => callback(new Blob(["jpeg"])) };
    created.push(canvas); return canvas;
  } };
  try {
    const blob = await makePdf({ width: 100, height: 250 }, 100);
    assert.match(await blob.text(), /\/Count 3\b/);
    assert.deepEqual(created.map(canvas => [canvas.width, canvas.height]), [[0, 0], [0, 0], [0, 0]]);
  } finally { globalThis.document = original; }
});

test("undo, redo, new edits, and draft snapshots retain their existing format", () => {
  const history = [{ operations: [] }, { operations: [{ type: "text", text: "old" }] }];
  const redo = [];
  navigateHistoryStacks(history, redo, "undo");
  assert.equal(history.length, 1);
  navigateHistoryStacks(history, redo, "redo");
  assert.equal(history.length, 2);
  const saved = historyForDraft(history, { index: 0 }, " updated ");
  assert.equal(saved[1].operations[0].text, "updated");
  assert.equal(history[1].operations[0].text, "old");
  assert.equal(historyForDraft(history, { index: 0 }, " ")[1].operations.length, 0);
  assert.equal(historyForDraft(history, { index: null, item: { type: "text" } }, "new")[1].operations[1].text, "new");
  assert.deepEqual(appendHistory(history, { operations: [] }), []);
});

test("capture progress reflects mode, phase, and cancellation", () => {
  const translate = (text, value) => text.replace("$1", value);
  assert.equal(shouldShowCaptureProgress(null), false);
  assert.equal(shouldShowCaptureProgress({ active: true, mode: "full" }), true);
  assert.equal(shouldShowCaptureProgress({ active: true, mode: "viewport", phase: "preparing" }), false);
  assert.equal(shouldShowCaptureProgress({ active: true, mode: "viewport", phase: "editing" }), true);
  assert.equal(getProgressMessage({ phase: "countdown", countdownRemaining: 3 }, translate), "3秒後に撮影を開始します…");
  assert.equal(getProgressMessage({ phase: "editing", cancelRequested: true }, translate), "撮影をキャンセルしています…");
});

test("capture geometry validation preserves boundary and scroll checks", () => {
  const page = { viewportWidth: 100, viewportHeight: 100 };
  assert.doesNotThrow(() => validateScrollableAreaBounds({ rect: { x: 0, y: 0, width: 101, height: 100 } }, page));
  assert.throws(() => validateScrollableAreaBounds({ rect: { x: -1, y: 0, width: 20, height: 20 } }, page));
  assert.throws(() => validateScrollableAreaBounds(null, page));
  assert.doesNotThrow(() => validatePaginatedScrollPosition(0, -1, 0));
  assert.throws(() => validatePaginatedScrollPosition(1, 0, 1));
  assert.doesNotThrow(() => validatePaginatedScrollPosition(2, 0, 1));
});
