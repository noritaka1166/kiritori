import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../capture-view.js", import.meta.url));
const { closeCaptureView } = await import(`data:text/javascript;base64,${source.toString("base64")}`);

test("restores the source tab and window before closing the view", async () => {
  const calls = [];
  globalThis.chrome = {
    tabs: {
      update: async (...args) => { calls.push(["update", ...args]); return { windowId: 2 }; },
      getCurrent: async () => { calls.push(["getCurrent"]); return { id: 3 }; },
      remove: async id => { calls.push(["remove", id]); }
    },
    windows: { update: async (...args) => { calls.push(["focus", ...args]); } }
  };
  globalThis.window = { close: () => calls.push(["close"]) };
  await closeCaptureView(1);
  assert.deepEqual(calls, [["update", 1, { active: true }], ["focus", 2, { focused: true }], ["getCurrent"], ["remove", 3]]);
});

test("closes the view even when the source tab no longer exists", async () => {
  let removed = false;
  globalThis.chrome = { tabs: {
    update: async () => { throw new Error("tab closed"); },
    getCurrent: async () => ({ id: 3 }),
    remove: async () => { removed = true; }
  } };
  await closeCaptureView(1);
  assert.equal(removed, true);
});

test("falls back to closing the window when the current tab is unavailable", async () => {
  let closed = 0;
  globalThis.chrome = { tabs: { getCurrent: async () => null } };
  globalThis.window = { close: () => closed++ };
  await closeCaptureView(null);
  assert.equal(closed, 1);
});
