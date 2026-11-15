import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function load(name) {
  const source = await readFile(new URL(`../${name}`, import.meta.url));
  return import(`data:text/javascript;base64,${source.toString("base64")}`);
}
const selection = await load("page-selection.js");
const capture = await load("page-capture.js");

// Chrome serializes each function, so run the serialized source in an isolated context.
function inject(fn, globals, ...args) {
  const context = vm.createContext({ ...globals, args });
  return vm.runInContext(`(${fn.toString()})(...args)`, context);
}

test("all page functions can be serialized independently", () => {
  for (const fn of Object.values({ ...selection, ...capture })) {
    assert.equal(typeof fn, "function");
    assert.doesNotThrow(() => new vm.Script(`(${fn.toString()})`));
  }
});

test("page metadata and pagination snapshots work in an isolated page", () => {
  const globals = {
    document: { title: "Page", documentElement: { clientWidth: 800, clientHeight: 600 }, body: { innerText: "content" }, readyState: "complete" },
    location: { href: "https://example.test/" }
  };
  const info = inject(selection.readPageInfo, globals);
  assert.equal(info.title, "Page");
  assert.equal(info.viewportHeight, 600);
  const snapshot = inject(selection.paginationSnapshot, globals);
  assert.match(snapshot.signature, /^https:\/\/example\.test\/\|7\|\d+$/);
  assert.equal(snapshot.ready, true);
});

test("cancellation only affects the matching page selection", () => {
  let cancelled = 0;
  const globals = { __kiritoriPaginationPicker: { jobId: "one", cancel: () => cancelled++ } };
  inject(selection.cancelPaginationSelection, globals, "other");
  assert.equal(cancelled, 0);
  inject(selection.cancelPaginationSelection, globals, "one");
  assert.equal(cancelled, 1);
});

test("full-page cleanup restores scroll position and removes capture state", () => {
  let removed = false;
  let position;
  const element = { dataset: { localcaptureHidden: "true" } };
  const window = {
    __localCaptureState: { x: 12, y: 34, hidden: [element], style: { remove: () => { removed = true; } } },
    scrollTo: (...args) => { position = args; }
  };
  assert.equal(inject(capture.restoreFullPage, { window }), true);
  assert.equal(element.dataset.localcaptureHidden, undefined);
  assert.equal(removed, true);
  assert.deepEqual(position, [12, 34]);
  assert.equal(window.__localCaptureState, undefined);
  assert.equal(inject(capture.restoreFullPage, { window }), false);
});

test("scroll-area operations ignore absent or unrelated capture state", () => {
  const window = { __kiritoriScrollCapture: { jobId: "one", element: { isConnected: true } } };
  assert.equal(inject(capture.scrollScrollableArea, { window }, "other", 50), null);
  assert.equal(inject(capture.readScrollableAreaMetrics, { window }, "other"), null);
  assert.equal(inject(capture.restoreScrollableArea, { window }, "other"), false);
  assert.equal(window.__kiritoriScrollCapture.jobId, "one");
});
