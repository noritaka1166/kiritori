import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../editor-annotations.js", import.meta.url));
const { drawOperation, hitObject, hitRadius, textBounds, textPoint } = await import(`data:text/javascript;base64,${source.toString("base64")}`);

function setup() {
  const calls = [];
  const context = new Proxy({}, {
    get(_target, name) {
      if (name === "measureText") return () => ({ width: 60 });
      return (...args) => calls.push([name, ...args]);
    },
    set(_target, name, value) { calls.push([name, value]); return true; }
  });
  const canvas = { width: 200, height: 100, getBoundingClientRect: () => ({ width: 100 }) };
  return { drawOperation: (operation, crop) => drawOperation(operation, crop, canvas, context), hitObject: (point, state) => hitObject(point, state, canvas, context), hitRadius: () => hitRadius(canvas), textBounds: item => textBounds(item, context), textPoint, calls };
}

test("hit testing respects scaled tolerance, stacking, and opaque redaction", () => {
  const tools = setup();
  assert.equal(tools.hitRadius(), 20);
  const rect = { type: "rect", x: 10, y: 10, width: 80, height: 40, size: 20 };
  const line = { type: "line", x1: 10, y1: 10, x2: 90, y2: 10, size: 20 };
  const redact = { type: "redact", x: 30, y: 0, width: 20, height: 20 };
  assert.equal(tools.hitObject({ x: 20, y: 10 }, { operations: [rect, line] }), 1);
  assert.equal(tools.hitObject({ x: 40, y: 10 }, { operations: [rect, line, redact] }), null);
  assert.equal(tools.hitObject({ x: 40, y: 10 }, { operations: [redact, line] }), 1);
  assert.equal(tools.hitObject({ x: 150, y: 80 }, { operations: [rect, line] }), null);
});

test("rotated text uses measured bounds for drawing and selection", () => {
  const tools = setup();
  const text = { type: "text", x: 100, y: 50, size: 20, text: "hello", color: "#000000", angle: 90 };
  assert.deepEqual(tools.textBounds(text), { width: 60, height: 25 });
  assert.ok(Math.abs(tools.textPoint(text, 10, 0).y - 60) < 1e-9);
  assert.equal(tools.hitObject({ x: 90, y: 80 }, { operations: [text] }), 0);
  tools.drawOperation(text, { x: 10, y: 5 });
  assert.ok(tools.calls.some(call => call[0] === "translate" && call[1] === 90 && call[2] === 45));
  assert.ok(tools.calls.some(call => call[0] === "rotate" && call[1] === Math.PI / 2));
  assert.ok(tools.calls.some(call => call[0] === "fillText" && call[1] === "hello"));
});

test("redaction remains opaque while markers remain translucent", () => {
  const tools = setup();
  const crop = { x: 5, y: 10 };
  tools.drawOperation({ type: "redact", x: 10, y: 20, width: 30, height: 40, color: "#000000" }, crop);
  tools.drawOperation({ type: "marker", x: 10, y: 20, width: 30, height: 40, color: "#ffff00" }, crop);
  assert.deepEqual(tools.calls.filter(call => call[0] === "globalAlpha"), [["globalAlpha", 1], ["globalAlpha", 0.35]]);
  assert.deepEqual(tools.calls.filter(call => call[0] === "fillRect"), [["fillRect", 5, 10, 30, 40], ["fillRect", 5, 10, 30, 40]]);
});

test("mosaic samples only its intersection with the cropped canvas", () => {
  const tools = setup();
  const samples = [];
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage: (...args) => samples.push(args) }) }) };
  try {
    tools.drawOperation({ type: "mosaic", x: -10, y: 10, width: 30, height: 20, blockSize: 10 }, { x: 0, y: 0 });
    assert.deepEqual(samples[0].slice(1), [0, 10, 20, 20, 0, 0, 2, 2]);
    assert.ok(tools.calls.some(call => call[0] === "imageSmoothingEnabled" && call[1] === false));
  } finally {
    globalThis.document = previousDocument;
  }
});
