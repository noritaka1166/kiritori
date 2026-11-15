import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createCaptureStatusTracker } from "../capture-status.js";
import { downloadFile } from "../download-files.js";

test("pagination capture normalizes hidden options at the worker boundary", async () => {
  const source = await readFile(new URL("../service_worker.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("function validateCaptureOptions("), source.indexOf("async function resolveCaptureTab("));
  const validate = vm.runInNewContext(`(${fn.trim()})`);
  const original = { mode: "pagination", format: "png", destination: "both", removeAds: true, manualHide: true };
  const result = validate(original);
  assert.equal(result.destination, "save");
  assert.equal(result.removeAds, false);
  assert.equal(result.manualHide, false);
  assert.equal(original.removeAds, true);
});

test("old jobs and older updates cannot replace the latest capture status", () => {
  const tracker = createCaptureStatusTracker();
  assert.equal(tracker.accept({ jobId: "old", revision: 4 }), true);
  assert.equal(tracker.accept({ jobId: "new", revision: 5 }), true);
  assert.equal(tracker.accept({ jobId: "old", revision: 6 }), false);
  assert.equal(tracker.accept({ jobId: "new", revision: 4 }), false);
  assert.deepEqual(tracker.current(), { jobId: "new", revision: 5 });
  assert.equal(tracker.accept({ jobId: "after-restart", revision: 1 }), true);
});

function mockDownloads(start, search) {
  const listeners = new Set();
  return {
    listeners,
    onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    emit(delta) { for (const fn of listeners) fn(delta); },
    download: start,
    search
  };
}

test("waits for completed downloads before reporting success", async () => {
  const downloads = mockDownloads(async () => 42, async () => [{ id: 42, state: "in_progress" }]);
  let finished = false;
  const promise = downloadFile(downloads, {}).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  downloads.emit({ id: 42, state: { current: "complete" } });
  await promise;
  assert.equal(finished, true);
  assert.equal(downloads.listeners.size, 0);
});

test("handles completion before download returns and rejects interrupted downloads", async () => {
  let downloads;
  downloads = mockDownloads(async () => { downloads.emit({ id: 7, state: { current: "complete" } }); return 7; }, async () => [{ state: "complete" }]);
  await downloadFile(downloads, {});
  assert.equal(downloads.listeners.size, 0);
  downloads = mockDownloads(async () => 8, async () => [{ state: "interrupted", error: "FILE_NO_SPACE" }]);
  await assert.rejects(downloadFile(downloads, {}), /FILE_NO_SPACE/);
  assert.equal(downloads.listeners.size, 0);
});

test("reports a download that becomes interrupted after it starts", async () => {
  const downloads = mockDownloads(async () => 9, async () => [{ state: "in_progress" }]);
  const result = downloadFile(downloads, {});
  await new Promise(resolve => setImmediate(resolve));
  downloads.emit({ id: 9, state: { current: "interrupted" }, error: { current: "NETWORK_FAILED" } });
  await assert.rejects(result, /NETWORK_FAILED/);
  assert.equal(downloads.listeners.size, 0);
});
