import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Load the extension's ES module without requiring a package.json in the extension.
const source = await readFile(new URL("../popup-settings.js", import.meta.url));
const settings = await import(`data:text/javascript;base64,${source.toString("base64")}`);

test("numeric settings retain their existing limits and fallback behavior", () => {
  for (const [normalize, cases] of [
    [settings.normalizePaginationLimit, [["", 20], [0, 20], [-3, 1], ["4.9", 4], [100, 50]]],
    [settings.normalizePaginationWait, [["", 1500], [0, 1500], [1, 500], [20000, 10000]]],
    [settings.normalizeMaxFrames, [["", 80], [0, 80], [-1, 1], [201, 200]]]
  ]) {
    for (const [input, expected] of cases) assert.equal(normalize(input), expected);
  }
  assert.equal(settings.normalizeScrollWait(""), 0); // Existing saved values.
  assert.equal(settings.normalizeScrollWait("", { emptyIsDefault: true }), 600); // Empty control.
  assert.equal(settings.normalizeScrollWait("invalid"), 600);
  assert.equal(settings.normalizeScrollWait(-1), 0);
  assert.equal(settings.normalizeScrollWait(10001), 10000);
});

test("site keys accept only web pages", () => {
  assert.equal(settings.siteKey("https://EXAMPLE.com:8080/path"), "example.com");
  assert.equal(settings.siteKey("chrome://extensions"), null);
  assert.equal(settings.siteKey("not a url"), null);
});

function mockStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(names.filter(key => Object.hasOwn(data, key)).map(key => [key, structuredClone(data[key])]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); }
  };
}

test("global and site settings retain their storage format and ordering", async () => {
  const storage = mockStorage({ captureSettings: { mode: "full" }, siteCaptureSettings: { "other.example": { mode: "region" } } });
  const store = settings.createSettingsStore(storage);
  await Promise.all([
    store.save({ mode: "viewport" }, "example.com"),
    store.save({ mode: "pagination" }, "example.com"),
    store.save({ mode: "region" }, null)
  ]);
  assert.deepEqual(storage.data.captureSettings, { mode: "region" });
  assert.deepEqual(storage.data.siteCaptureSettings, { "other.example": { mode: "region" }, "example.com": { mode: "pagination" } });
  assert.deepEqual(await store.removeSite("example.com"), { mode: "region" });
  assert.deepEqual(storage.data.siteCaptureSettings, { "other.example": { mode: "region" } });
  assert.deepEqual(await store.load(), storage.data);
});

test("a failed write does not prevent later settings from being saved", async () => {
  const storage = mockStorage({ siteCaptureSettings: [] });
  const originalSet = storage.set;
  let fail = true;
  storage.set = async values => {
    if (fail) { fail = false; throw new Error("storage error"); }
    return originalSet(values);
  };
  const store = settings.createSettingsStore(storage);
  await assert.rejects(store.save({ mode: "full" }, null), /storage error/);
  await store.save({ mode: "region" }, "example.com");
  assert.deepEqual(storage.data.siteCaptureSettings, { "example.com": { mode: "region" } });
});

test("capture delay accepts custom seconds and bounds invalid values", () => {
  assert.equal(settings.normalizeCaptureDelay(3), 3);
  assert.equal(settings.normalizeCaptureDelay("42"), 42);
  assert.equal(settings.normalizeCaptureDelay(1200), 999);
  assert.equal(settings.normalizeCaptureDelay(-1), 0);
  assert.equal(settings.normalizeCaptureDelay("invalid"), 0);
});
