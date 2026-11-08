kiriLocalizeDocument();
const draftRetention = document.querySelector("#draft-retention");
const draftList = document.querySelector("#draft-list");
const draftListStatus = document.querySelector("#draft-list-status");
const draftClear = document.querySelector("#draft-clear");
let draftDb;
async function refreshDrafts() {
  if (!draftDb) return;
  try {
    await draftDb.deleteExpired();
    const drafts = (await draftDb.list()).sort((a,b) => b.updatedAt - a.updatedAt);
    draftList.replaceChildren(); draftClear.hidden = drafts.length === 0;
    draftListStatus.textContent = drafts.length ? kiriT("保存された下書き") : kiriT("保存された下書きはありません。");
    for (const draft of drafts) {
      const row = document.createElement("div"); row.className = "draft-row";
      const title = document.createElement("span"); title.textContent = `${draft.meta?.title || "KiriTori"} · ${new Date(draft.updatedAt).toLocaleString(chrome.i18n.getUILanguage())}`;
      const open = document.createElement("button"); open.type = "button"; open.textContent = kiriT("復元");
      open.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?draft=${encodeURIComponent(draft.id)}`) }));
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = kiriT("削除");
      remove.addEventListener("click", async () => { try { await draftDb.delete(draft.id); await refreshDrafts(); } catch (_) { draftListStatus.textContent = kiriT("下書きを削除できませんでした。"); } });
      row.append(title, open, remove); draftList.append(row);
    }
  } catch (_) { draftListStatus.textContent = kiriT("下書きを読み込めませんでした。"); }
}
(async () => {
  try {
    draftDb = (await import("./draft-store.js")).draftStore;
    const settings = await chrome.storage.local.get("draftRetentionDays");
    draftRetention.value = String([0, 1, 7, 30].includes(settings.draftRetentionDays) ? settings.draftRetentionDays : 7);
    await refreshDrafts();
  } catch (_) { draftListStatus.textContent = kiriT("下書きを読み込めませんでした。"); }
})();
draftRetention.addEventListener("change", async () => {
  try { await chrome.storage.local.set({ draftRetentionDays: Number(draftRetention.value) }); }
  catch (_) { draftListStatus.textContent = kiriT("設定を保存できませんでした。"); }
});
draftClear.addEventListener("click", async () => { if (!draftDb) return; try { await draftDb.clear(); await refreshDrafts(); } catch (_) { draftListStatus.textContent = kiriT("下書きを削除できませんでした。"); } });
const siteSettingsEnabled = document.querySelector("#site-settings-enabled");
const siteSettingsStatus = document.querySelector("#site-settings-status");
let siteHost = null;
function siteKey(url) { try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) ? parsed.hostname.toLowerCase() : null; } catch (_) { return null; } }
const mode = document.querySelector("#capture-mode");
const format = document.querySelector("#output-format");
const paginationSetting = document.querySelector("#pagination-setting");
const paginationLimit = document.querySelector("#pagination-limit");
const paginationScope = document.querySelector("#pagination-scope");
const paginationWait = document.querySelector("#pagination-wait");
const captureDelay = document.querySelector("#capture-delay");
const destination = document.querySelector("#destination");
const filenamePattern = document.querySelector("#filename-pattern");
const scrollSpeed = document.querySelector("#scroll-speed");
const scrollSpeedSetting = document.querySelector("#scroll-speed-setting");
const scrollWaitCustom = document.querySelector("#scroll-wait-custom");
const scrollWaitInput = document.querySelector("#scroll-wait-ms");
const maxFramesInput = document.querySelector("#max-frames");
const frameLimitSetting = document.querySelector("#frame-limit-setting");
const splitOutput = document.querySelector("#split-output");
const splitSetting = document.querySelector("#split-setting");
const scrollAreaNote = document.querySelector("#scroll-area-note");
const folder = document.querySelector("#folder");
const removeAds = document.querySelector("#remove-ads");
const manualHide = document.querySelector("#manual-hide");
const previewEdit = document.querySelector("#preview-edit");
const folderRow = document.querySelector("#folder-row");
const captureButton = document.querySelector("#capture");
const status = document.querySelector("#status");
const progressPanel = document.querySelector("#capture-progress");
const progressText = document.querySelector("#progress-text");
const cancelCapture = document.querySelector("#cancel-capture");
const openEditor = document.querySelector("#open-editor");
const failureHistory = document.querySelector("#failure-history");
const failureList = document.querySelector("#failure-list");
const failureStatus = document.querySelector("#failure-status");
const clearFailures = document.querySelector("#clear-failures");

const defaults = {
  mode: "viewport",
  format: "png",
  captureDelay: 0,
  paginationLimit: 20,
  paginationScope: "viewport",
  paginationWait: 1500,
  destination: "save",
  filenamePattern: "title-date",
  splitOutput: false,
  maxFrames: 80,
  scrollSpeed: "normal",
  scrollWaitMs: 600,
  folder: "Screenshots",
  removeAds: false,
  manualHide: false,
  preview: true
};
let settingsWrite = Promise.resolve();
let settingsLoaded = false;
let captureBusy = false;
let startPending = false;
let latestJobId = null;
let latestRevision = 0;
let failureRequest = 0;
captureButton.disabled = true;

async function refreshFailures() {
  const request = ++failureRequest;
  try {
    const response = await chrome.runtime.sendMessage({ type: "capture:failures:list" });
    if (request !== failureRequest) return;
    if (!response?.ok) throw new Error(kiriT("履歴を読み込めませんでした。"));
    failureList.replaceChildren();
    const failures = Array.isArray(response.failures) ? response.failures.slice(0, 10) : [];
    failureHistory.hidden = failures.length === 0;
    failureStatus.textContent = "";
    const modes = { viewport: kiriT("表示中の範囲"), region: kiriT("選択範囲"), full: kiriT("ページ全体"), "scroll-area": kiriT("スクロール領域"), pagination: kiriT("ページ送りをしながら撮影") };
    const phases = { preparing: kiriT("準備中"), countdown: kiriT("撮影待機中"), selecting: kiriT("要素選択中"), capturing: kiriT("撮影中"), processing: kiriT("画像処理中"), editing: kiriT("編集中"), saving: kiriT("出力中") };
    for (const failure of failures) {
      const item = document.createElement("li");
      const meta = document.createElement("p");
      meta.className = "failure-meta";
      const date = new Date(failure.time);
      const when = Number.isNaN(date.getTime()) ? kiriT("日時不明") : date.toLocaleString(chrome.i18n.getUILanguage());
      meta.textContent = [when, modes[failure.mode], phases[failure.phase], failure.currentFrame > 0 ? kiriT("$1画面目", failure.currentFrame) : ""].filter(Boolean).join(" · ");
      const reason = document.createElement("strong");
      reason.textContent = kiriT(failure.reason || "撮影処理に失敗しました。");
      const advice = document.createElement("p");
      advice.textContent = kiriT(failure.advice || "もう一度撮影してください。");
      item.append(meta, reason, advice);
      failureList.append(item);
    }
  } catch (_) {
    if (request !== failureRequest) return;
    failureHistory.hidden = false;
    failureStatus.textContent = kiriT("失敗履歴を読み込めませんでした。拡張機能を再読み込みしてください。");
  }
}

clearFailures.addEventListener("click", async () => {
  clearFailures.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "capture:failures:clear" });
    if (!response?.ok) throw new Error();
    await refreshFailures();
  } catch (_) {
    failureStatus.textContent = kiriT("失敗履歴を削除できませんでした。");
  } finally {
    clearFailures.disabled = false;
  }
});

function updateCaptureButton() {
  captureButton.disabled = !settingsLoaded || captureBusy || startPending;
}

function renderCaptureStatus(captureStatus) {
  if (captureStatus?.jobId && captureStatus.jobId !== latestJobId) {
    latestJobId = captureStatus.jobId;
    latestRevision = 0;
  }
  if (captureStatus?.revision && captureStatus.revision < latestRevision) return;
  if (captureStatus?.revision) latestRevision = captureStatus.revision;
  captureBusy = Boolean(captureStatus?.active);
  const showProgress = captureBusy && (["full", "scroll-area", "pagination"].includes(captureStatus.mode) || captureStatus.phase === "editing" || captureStatus.phase === "selecting" || captureStatus.phase === "countdown");
  progressPanel.hidden = !showProgress;
  if (showProgress) {
    if (captureStatus.cancelRequested || captureStatus.phase === "cancelling") {
      progressText.textContent = kiriT("撮影をキャンセルしています…");
    } else if (captureStatus.phase === "countdown") {
      progressText.textContent = kiriT("$1秒後に撮影を開始します…", captureStatus.countdownRemaining);
    } else if (captureStatus.phase === "selecting") {
      progressText.textContent = captureStatus.selectionKind === "pagination" ? kiriT("ページ上の「次へ」ボタンを選んでください。") : captureStatus.selectionKind === "scroll-area" ? kiriT("ページ内の表など、縦にスクロールする領域を選んでください。") : kiriT("ページ上で隠す要素を選び、「選択完了」を押してください。");
    } else if (captureStatus.phase === "editing") {
      progressText.textContent = kiriT("プレビュー画面で画像を確認・編集してください。");
    } else if (captureStatus.phase === "processing") {
      progressText.textContent = kiriT("$1画面を撮影し、画像をまとめています…", captureStatus.currentFrame);
    } else if (captureStatus.phase === "saving") {
      progressText.textContent = kiriT("撮影した画像を出力しています…");
    } else if (captureStatus.currentFrame > 0) {
      progressText.textContent = captureStatus.mode === "pagination" ? kiriT("現在$1ページ目を撮影中…", captureStatus.currentFrame) : kiriT("現在$1画面目を撮影中…", captureStatus.currentFrame);
    } else {
      progressText.textContent = kiriT("撮影を準備しています…");
    }
    cancelCapture.disabled = !captureStatus.cancellable || captureStatus.cancelRequested;
    cancelCapture.textContent = captureStatus.cancelRequested ? kiriT("キャンセル中…") : kiriT("撮影をキャンセル");
    openEditor.hidden = captureStatus.phase !== "editing" || !captureStatus.editorTabId;
  } else if (captureStatus && !captureStatus.active && captureStatus.message) {
    status.textContent = captureStatus.message;
  }
  updateCaptureButton();
}

async function refreshCaptureStatus() {
  const requestedJobId = latestJobId;
  const requestedRevision = latestRevision;
  try {
    const response = await chrome.runtime.sendMessage({ type: "capture:status" });
    if (response?.ok) {
      if (!response.status && (latestJobId !== requestedJobId || latestRevision !== requestedRevision)) return;
      renderCaptureStatus(response.status);
    }
  } catch (_) {
    captureBusy = false;
    progressPanel.hidden = true;
    updateCaptureButton();
    status.textContent = kiriT("撮影状態を取得できませんでした。拡張機能を再読み込みしてください。");
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "capture:progress") renderCaptureStatus(message.status);
  if (message?.type === "capture:failures:changed") refreshFailures();
});

openEditor.addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "capture:editor:focus" });
    if (!response?.ok) status.textContent = kiriT(response?.error || "編集画面を開けませんでした。");
  } catch (error) {
    status.textContent = kiriT(error?.message || "編集画面を開けませんでした。");
  }
});

cancelCapture.addEventListener("click", async () => {
  cancelCapture.disabled = true;
  cancelCapture.textContent = kiriT("キャンセル中…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "capture:cancel" });
    if (!response?.ok) status.textContent = kiriT(response?.error || "キャンセルできませんでした。");
  } catch (error) {
    status.textContent = kiriT(error?.message || "キャンセルできませんでした。");
  }
  await refreshCaptureStatus();
});

function currentSettings() {
  return {
    mode: mode.value,
    format: format.value,
    captureDelay: Number(captureDelay.value),
    paginationScope: paginationScope.value,
    paginationLimit: Math.min(50, Math.max(1, Math.floor(Number(paginationLimit.value) || 20))),
    paginationWait: Math.min(10000, Math.max(500, Math.floor(Number(paginationWait.value) || 1500))),
    destination: destination.value,
    filenamePattern: filenamePattern.value,
    splitOutput: splitOutput.checked,
    maxFrames: Math.min(200, Math.max(1, Math.floor(Number(maxFramesInput.value) || 80))),
    scrollSpeed: scrollSpeed.value,
    scrollWaitMs: Math.min(10000, Math.max(0, Number.isFinite(Number(scrollWaitInput.value)) && scrollWaitInput.value !== "" ? Math.floor(Number(scrollWaitInput.value)) : 600)),
    folder: folder.value,
    removeAds: removeAds.checked,
    manualHide: manualHide.checked,
    preview: previewEdit.checked
  };
}

async function saveSettings() {
  const snapshot = currentSettings();
  const useSite = siteSettingsEnabled.checked && siteHost;
  settingsWrite = settingsWrite.catch(() => undefined).then(async () => {
    if (useSite) {
      const data = await chrome.storage.local.get("siteCaptureSettings");
      const profiles = Object.assign(Object.create(null), data.siteCaptureSettings && typeof data.siteCaptureSettings === "object" && !Array.isArray(data.siteCaptureSettings) ? data.siteCaptureSettings : {});
      profiles[siteHost] = snapshot;
      await chrome.storage.local.set({ siteCaptureSettings: profiles });
    } else await chrome.storage.local.set({ captureSettings: snapshot });
  });
  await settingsWrite;
}

function applySettings(captureSettings) {
  if (captureSettings) {
    const settings = { ...defaults, ...captureSettings };
    if (["viewport", "region", "full", "scroll-area", "pagination"].includes(settings.mode)) mode.value = settings.mode;
    format.value = ["png", "jpeg", "pdf"].includes(settings.format) ? settings.format : "png";
    captureDelay.value = [0, 3, 5].includes(settings.captureDelay) ? String(settings.captureDelay) : "0";
    paginationScope.value = ["viewport", "full", "scroll-area"].includes(settings.paginationScope) ? settings.paginationScope : "viewport";
    paginationLimit.value = Math.min(50, Math.max(1, Math.floor(Number(settings.paginationLimit) || 20)));
    paginationWait.value = Math.min(10000, Math.max(500, Math.floor(Number(settings.paginationWait) || 1500)));
    if (["save", "copy", "both"].includes(settings.destination)) destination.value = settings.destination;
    if (["title-date", "date-site-title", "site-date-title"].includes(settings.filenamePattern)) filenamePattern.value = settings.filenamePattern;
    splitOutput.checked = settings.splitOutput === true;
    maxFramesInput.value = Math.min(200, Math.max(1, Math.floor(Number(settings.maxFrames) || 80)));
    if (["fast", "normal", "slow", "custom"].includes(settings.scrollSpeed)) scrollSpeed.value = settings.scrollSpeed;
    scrollWaitInput.value = Math.min(10000, Math.max(0, Number.isFinite(Number(settings.scrollWaitMs)) ? Math.floor(Number(settings.scrollWaitMs)) : 600));
    folder.value = settings.folder || defaults.folder;
    removeAds.checked = settings.removeAds === true;
    manualHide.checked = settings.manualHide === true;
    previewEdit.checked = settings.preview !== false;
  } else {
    // 以前の版のポップアップ設定を引き継ぎます。
    folder.value = localStorage.getItem("capture-folder") || defaults.folder;
    removeAds.checked = localStorage.getItem("remove-ads") === "true";
  }
  updateControls();
}

async function loadSettings() {
  const [tabs, data] = await Promise.all([chrome.tabs.query({ active: true, lastFocusedWindow: true }), chrome.storage.local.get(["captureSettings", "siteCaptureSettings"])]);
  siteHost = siteKey(tabs[0]?.url);
  const profiles = data.siteCaptureSettings;
  const hasProfile = Boolean(siteHost && profiles && Object.prototype.hasOwnProperty.call(profiles, siteHost));
  siteSettingsEnabled.disabled = !siteHost;
  siteSettingsEnabled.checked = hasProfile;
  siteSettingsStatus.textContent = siteHost ? kiriT("対象サイト: $1", siteHost) : kiriT("このページではサイト別設定を使えません。");
  applySettings(hasProfile ? profiles[siteHost] : data.captureSettings);
}

siteSettingsEnabled.addEventListener("change", async () => {
  if (!siteHost || !settingsLoaded) return;
  siteSettingsEnabled.disabled = true;
  try {
    await settingsWrite.catch(() => undefined);
    if (siteSettingsEnabled.checked) { await saveSettings(); }
    else {
      const data = await chrome.storage.local.get(["siteCaptureSettings", "captureSettings"]);
      const profiles = Object.assign(Object.create(null), data.siteCaptureSettings && typeof data.siteCaptureSettings === "object" && !Array.isArray(data.siteCaptureSettings) ? data.siteCaptureSettings : {});
      delete profiles[siteHost];
      await chrome.storage.local.set({ siteCaptureSettings: profiles });
      applySettings(data.captureSettings || defaults);
    }
  } catch (_) { siteSettingsStatus.textContent = kiriT("サイト別設定を保存できませんでした。"); }
  finally { siteSettingsEnabled.disabled = false; }
});

function updateControls() {
  const isPdf = format.value === "pdf";
  const isPagination = mode.value === "pagination";
  paginationSetting.hidden = !isPagination;
  previewEdit.disabled = false;
  document.querySelector("#preview-label").textContent = isPagination ? kiriT("出力前にプレビュー") : kiriT("出力前にプレビュー・編集");
  document.querySelector("#preview-note").hidden = isPagination;
  removeAds.disabled = isPagination;
  manualHide.disabled = isPagination;
  scrollAreaNote.hidden = mode.value !== "scroll-area";
  const scrolling = ["full", "scroll-area"].includes(mode.value) || (isPagination && ["full", "scroll-area"].includes(paginationScope.value));
  frameLimitSetting.hidden = !scrolling;
  scrollSpeedSetting.hidden = !scrolling;
  scrollWaitCustom.hidden = scrollSpeed.value !== "custom";
  for (const option of destination.options) {
    if (option.value === "copy" || option.value === "both") {
      option.disabled = isPdf || isPagination;
    }
  }
  if ((isPdf || isPagination) && destination.value !== "save") destination.value = "save";
  folderRow.hidden = destination.value === "copy";
  splitSetting.hidden = !["full", "scroll-area"].includes(mode.value) || destination.value === "copy";
}

mode.addEventListener("change", () => { updateControls(); saveSettings(); });
format.addEventListener("change", () => { updateControls(); saveSettings(); });
captureDelay.addEventListener("change", saveSettings);
paginationLimit.addEventListener("change", saveSettings);
paginationScope.addEventListener("change", () => { updateControls(); saveSettings(); });
paginationWait.addEventListener("change", saveSettings);
destination.addEventListener("change", () => { updateControls(); saveSettings(); });
filenamePattern.addEventListener("change", saveSettings);
splitOutput.addEventListener("change", saveSettings);
scrollSpeed.addEventListener("change", () => { updateControls(); saveSettings(); });
scrollWaitInput.addEventListener("change", () => { const value = scrollWaitInput.value === "" ? 600 : Number(scrollWaitInput.value); scrollWaitInput.value = Math.min(10000, Math.max(0, Number.isFinite(value) ? Math.floor(value) : 600)); saveSettings(); });
maxFramesInput.addEventListener("change", () => { maxFramesInput.value = Math.min(200, Math.max(1, Math.floor(Number(maxFramesInput.value) || 80))); saveSettings(); });
folder.addEventListener("change", saveSettings);
removeAds.addEventListener("change", saveSettings);
manualHide.addEventListener("change", saveSettings);
previewEdit.addEventListener("change", saveSettings);
updateControls();
const settingsReady = loadSettings()
  .catch(() => {
    status.textContent = kiriT("設定を読み込めませんでした。拡張機能を再読み込みしてください。");
  })
  .finally(() => { settingsLoaded = true; updateCaptureButton(); });
refreshCaptureStatus();
refreshFailures();

captureButton.addEventListener("click", async () => {
  startPending = true;
  captureBusy = true;
  updateCaptureButton();
  status.textContent = ["full", "scroll-area"].includes(mode.value) ? kiriT("ページをスクロールしながら撮影しています…") : kiriT("撮影しています…");

  try {
    await settingsReady;
    await saveSettings();
    const result = await chrome.runtime.sendMessage({
      type: "capture:start",
      options: currentSettings()
    });
    if (result?.cancelled) {
      status.textContent = kiriT("撮影をキャンセルしました。");
      return;
    }
    if (!result?.ok) throw new Error(result?.error || kiriT("撮影に失敗しました。"));
    status.textContent = result.message;
  } catch (error) {
    status.textContent = kiriT(error?.message || "撮影に失敗しました。");
  } finally {
    startPending = false;
    await refreshCaptureStatus();
    updateCaptureButton();
  }
});
