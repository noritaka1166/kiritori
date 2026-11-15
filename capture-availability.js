// A missing URL is inconclusive: Chrome may withhold tab metadata.
export function capturePageRestriction(url, fileAccessAllowed) {
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol === "file:") return fileAccessAllowed === false ? "file-access" : null;
  if (["chrome:", "chrome-extension:", "chrome-search:", "chrome-untrusted:", "devtools:", "edge:", "about:"].includes(parsed.protocol)) return "browser-page";
  if ((parsed.hostname === "chromewebstore.google.com" && parsed.protocol === "https:") ||
      (parsed.hostname === "chrome.google.com" && (parsed.pathname === "/webstore" || parsed.pathname.startsWith("/webstore/")))) return "web-store";
  return null;
}
