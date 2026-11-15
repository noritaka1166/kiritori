import test from "node:test";
import assert from "node:assert/strict";
import { capturePageRestriction } from "../capture-availability.js";

test("identifies protected pages without blocking unknown or ordinary pages", () => {
  assert.equal(capturePageRestriction("chrome://settings/"), "browser-page");
  assert.equal(capturePageRestriction("chrome-extension://abc/editor.html"), "browser-page");
  assert.equal(capturePageRestriction("https://chromewebstore.google.com/detail/example"), "web-store");
  assert.equal(capturePageRestriction("https://chrome.google.com/webstore/detail/example"), "web-store");
  assert.equal(capturePageRestriction("https://chrome.google.com/"), null);
  assert.equal(capturePageRestriction("https://example.com/"), null);
  assert.equal(capturePageRestriction(undefined), null);
  assert.equal(capturePageRestriction("file:///tmp/example.html", false), "file-access");
  assert.equal(capturePageRestriction("file:///tmp/example.html", true), null);
  assert.equal(capturePageRestriction("file:///tmp/example.html", undefined), null);
});
