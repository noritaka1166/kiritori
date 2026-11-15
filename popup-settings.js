// Settings persistence and numeric normalization shared by the popup controls.
export const defaults = {
  mode: "viewport", format: "png", captureDelay: 0, paginationLimit: 20,
  paginationScope: "viewport", paginationWait: 1500, destination: "save",
  filenamePattern: "title-date", splitOutput: false, maxFrames: 80,
  scrollSpeed: "normal", scrollWaitMs: 600, folder: "Screenshots",
  removeAds: false, manualHide: false, preview: true
};

function clampInteger(value, min, max, fallback) {
  return Math.min(max, Math.max(min, Math.floor(Number(value) || fallback)));
}

export function normalizeCaptureDelay(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.min(999, Math.max(0, Math.floor(seconds))) : 0;
}

export const normalizePaginationLimit = (value) => clampInteger(value, 1, 50, defaults.paginationLimit);
export const normalizePaginationWait = (value) => clampInteger(value, 500, 10000, defaults.paginationWait);
export const normalizeMaxFrames = (value) => clampInteger(value, 1, 200, defaults.maxFrames);

export function normalizeScrollWait(value, { emptyIsDefault = false } = {}) {
  const wait = emptyIsDefault && value === "" ? Number.NaN : Number(value);
  return Math.min(10000, Math.max(0, Number.isFinite(wait) ? Math.floor(wait) : defaults.scrollWaitMs));
}

export function siteKey(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.hostname.toLowerCase() : null;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return null;
  }
}

function copyProfiles(value) {
  return Object.assign(Object.create(null), value && typeof value === "object" && !Array.isArray(value) ? value : {});
}

export function createSettingsStore(storage) {
  let pending = Promise.resolve();
  return {
    async load() {
      return storage.get(["captureSettings", "siteCaptureSettings"]);
    },
    save(snapshot, host) {
      pending = pending.catch(() => undefined).then(async () => {
        if (!host) return storage.set({ captureSettings: snapshot });
        const data = await storage.get("siteCaptureSettings");
        const profiles = copyProfiles(data.siteCaptureSettings);
        profiles[host] = snapshot;
        await storage.set({ siteCaptureSettings: profiles });
      });
      return pending;
    },
    removeSite(host) {
      pending = pending.catch(() => undefined).then(async () => {
        const data = await storage.get(["siteCaptureSettings", "captureSettings"]);
        const profiles = copyProfiles(data.siteCaptureSettings);
        delete profiles[host];
        await storage.set({ siteCaptureSettings: profiles });
        return data.captureSettings;
      });
      return pending;
    },
    wait() { return pending.catch(() => undefined); }
  };
}

export function normalizeFolder(value) {
  return String(value || "")
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim())
    .filter(Boolean)
    .join("/");
}
