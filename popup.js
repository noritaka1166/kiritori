import { capturePageRestriction } from "./capture-availability.js";
import { createCaptureStatusTracker } from "./capture-status.js";
import { shouldShowCaptureProgress, getProgressMessage } from "./popup-progress.js";
import { defaults, siteKey, createSettingsStore, normalizeFolder, normalizeCaptureDelay, normalizePaginationLimit, normalizePaginationWait, normalizeMaxFrames, normalizeScrollWait } from "./popup-settings.js";

kiriLocalizeDocument();
// Chrome sizes extension popups from their content. Wait until that sizing settles
// before accommodating a window that genuinely has less than 480px available.
let popupSizeTimer;
function fitPopupToViewport() {
  document.body.style.minHeight = window.innerHeight < 480 ? "0" : "";
}
function schedulePopupSizing() {
  clearTimeout(popupSizeTimer);
  popupSizeTimer = setTimeout(fitPopupToViewport, 200);
}
window.addEventListener("resize", schedulePopupSizing);
schedulePopupSizing();
const draftRetention = document.querySelector("#draft-retention");
const draftList = document.querySelector("#draft-list");
const draftListStatus = document.querySelector("#draft-list-status");
const draftClear = document.querySelector("#draft-clear");
const draftClearDialog = document.querySelector("#draft-clear-dialog");
const draftClearCancel = document.querySelector("#draft-clear-cancel");
const draftClearConfirm = document.querySelector("#draft-clear-confirm");
const draftClearTitle = document.querySelector("#draft-clear-title");
const draftClearDescription = document.querySelector("#draft-clear-description");
let draftToDelete = null;
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
      const open = document.createElement("button"); open.className = "draft-open"; open.type = "button"; open.textContent = kiriT("復元");
      open.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?draft=${encodeURIComponent(draft.id)}`) }));
      const remove = document.createElement("button"); remove.className = "draft-remove"; remove.type = "button"; remove.textContent = kiriT("削除");
      remove.addEventListener("click", () => {
        draftToDelete = draft.id;
        draftClearTitle.textContent = kiriT("下書きを削除しますか？");
        draftClearDescription.textContent = kiriT("「$1」を削除します。この操作は取り消せません。", draft.meta?.title || "KiriTori");
        draftClearConfirm.textContent = kiriT("削除");
        draftClearDialog.showModal();
      });
      row.append(title, open, remove); draftList.append(row);
    }
  } catch (error) {
    console.error("下書きを読み込めませんでした。", error);
    draftListStatus.textContent = kiriT("下書きを読み込めませんでした。");
  }
}
draftRetention.addEventListener("change", async () => {
  try { await chrome.storage.local.set({ draftRetentionDays: Number(draftRetention.value) }); }
  catch (error) {
    console.error("下書き設定を保存できませんでした。", error);
    draftListStatus.textContent = kiriT("設定を保存できませんでした。");
  }
});
draftClear.addEventListener("click", () => {
  if (!draftDb) return;
  draftToDelete = null;
  draftClearTitle.textContent = kiriT("下書きをすべて削除しますか？");
  draftClearDescription.textContent = kiriT("保存された下書きはすべて削除され、復元できません。");
  draftClearConfirm.textContent = kiriT("すべて削除");
  draftClearDialog.showModal();
});
draftClearCancel.addEventListener("click", () => draftClearDialog.close());
draftClearDialog.addEventListener("cancel", (event) => { if (draftClearConfirm.disabled) event.preventDefault(); });
draftClearConfirm.addEventListener("click", async () => {
  if (!draftDb || draftClearConfirm.disabled) return;
  draftClearConfirm.disabled = true;
  draftClearCancel.disabled = true;
  try {
    if (draftToDelete === null) await draftDb.clear();
    else await draftDb.delete(draftToDelete);
    draftClearDialog.close();
    await refreshDrafts();
  } catch (error) {
    console.error("下書きを削除できませんでした。", error);
    draftClearDialog.close();
    draftListStatus.textContent = kiriT("下書きを削除できませんでした。");
  } finally {
    draftClearConfirm.disabled = false;
    draftClearCancel.disabled = false;
  }
});
const siteSettingsEnabled = document.querySelector("#site-settings-enabled");
const siteSettingsStatus = document.querySelector("#site-settings-status");
let siteHost = null;
const mode = document.querySelector("#capture-mode");
const format = document.querySelector("#output-format");
const paginationSetting = document.querySelector("#pagination-setting");
const paginationLimit = document.querySelector("#pagination-limit");
const paginationScope = document.querySelector("#pagination-scope");
const paginationAreaNote = document.querySelector("#pagination-area-note");
const paginationWait = document.querySelector("#pagination-wait");
const captureDelay = document.querySelector("#capture-delay");
const captureDelayCustom = document.querySelector("#capture-delay-custom");
const captureDelaySeconds = document.querySelector("#capture-delay-seconds");
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
const captureModeDescription = document.querySelector("#capture-mode-description");
const folder = document.querySelector("#folder");
const removeAds = document.querySelector("#remove-ads");
const manualHide = document.querySelector("#manual-hide");
const previewEdit = document.querySelector("#preview-edit");
const folderRow = document.querySelector("#folder-row");
const destinationFolderSummary = document.querySelector("#destination-folder-summary");
const destinationFolderPath = document.querySelector("#destination-folder-path");
const changeDestinationFolder = document.querySelector("#change-destination-folder");
const captureButton = document.querySelector("#capture");
const captureAvailability = document.querySelector("#capture-availability");
let captureRestricted = false;
const statusOutput = document.querySelector("#status");
const progressPanel = document.querySelector("#capture-progress");
const progressText = document.querySelector("#progress-text");
const cancelCapture = document.querySelector("#cancel-capture");
const openEditor = document.querySelector("#open-editor");
const failureHistory = document.querySelector("#failure-history");
const failureCount = document.querySelector("#failure-count");
const failureList = document.querySelector("#failure-list");
const failureStatus = document.querySelector("#failure-status");
const clearFailures = document.querySelector("#clear-failures");

const settingsStore = createSettingsStore(chrome.storage.local);
let settingsLoaded = false;
let captureBusy = false;
let startPending = false;
const captureStatusTracker = createCaptureStatusTracker();
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
    failureCount.textContent = kiriT("$1件", failures.length);
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
  } catch (error) {
    if (request !== failureRequest) return;
    console.error("失敗履歴を読み込めませんでした。", error);
    failureHistory.hidden = false;
    failureHistory.open = true;
    failureCount.textContent = "";
    failureStatus.textContent = kiriT("失敗履歴を読み込めませんでした。拡張機能を再読み込みしてください。");
  }
}

clearFailures.addEventListener("click", async () => {
  clearFailures.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "capture:failures:clear" });
    if (!response?.ok) throw new Error("失敗履歴を削除できませんでした。");
    await refreshFailures();
  } catch (error) {
    console.error("失敗履歴を削除できませんでした。", error);
    failureStatus.textContent = kiriT("失敗履歴を削除できませんでした。");
  } finally {
    clearFailures.disabled = false;
  }
});

function updateCaptureButton() {
  captureButton.disabled = !settingsLoaded || captureBusy || startPending || captureRestricted;
}

function renderCaptureStatus(captureStatus) {
  if (!captureStatusTracker.accept(captureStatus)) return;
  captureBusy = Boolean(captureStatus?.active);
  const showProgress = shouldShowCaptureProgress(captureStatus);
  progressPanel.hidden = !showProgress;
  if (showProgress) {
    renderProgressState(captureStatus);
  } else {
    renderInactiveCaptureStatus(captureStatus);
  }
  updateCaptureButton();
}

function renderProgressState(captureStatus) {
  progressText.textContent = getProgressMessage(captureStatus, kiriT);
  cancelCapture.disabled = !captureStatus.cancellable || captureStatus.cancelRequested;
  cancelCapture.textContent = captureStatus.cancelRequested ? kiriT("キャンセル中…") : kiriT("撮影をキャンセル");
  openEditor.hidden = captureStatus.phase !== "editing" || !captureStatus.editorTabId;
}

function renderInactiveCaptureStatus(captureStatus) {
  if (!captureStatus || captureStatus.active || !captureStatus.message) return;
  statusOutput.textContent = captureStatus.message;
}

async function refreshCaptureStatus() {
  const requested = captureStatusTracker.current();
  try {
    const response = await chrome.runtime.sendMessage({ type: "capture:status" });
    if (response?.ok) {
      const current = captureStatusTracker.current();
      if (current.jobId !== requested.jobId || current.revision !== requested.revision) return;
      renderCaptureStatus(response.status);
    }
  } catch (error) {
    console.error("撮影状態を取得できませんでした。", error);
    captureBusy = false;
    progressPanel.hidden = true;
    updateCaptureButton();
    statusOutput.textContent = kiriT("撮影状態を取得できませんでした。拡張機能を再読み込みしてください。");
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "capture:progress") renderCaptureStatus(message.status);
  if (message?.type === "capture:failures:changed") void refreshFailures();
});

openEditor.addEventListener("click", async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: "capture:editor:focus" });
    if (!response?.ok) statusOutput.textContent = kiriT(response?.error || "編集画面を開けませんでした。");
  } catch (error) {
    statusOutput.textContent = kiriT(error?.message || "編集画面を開けませんでした。");
  }
});

cancelCapture.addEventListener("click", async () => {
  cancelCapture.disabled = true;
  cancelCapture.textContent = kiriT("キャンセル中…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "capture:cancel" });
    if (!response?.ok) statusOutput.textContent = kiriT(response?.error || "キャンセルできませんでした。");
  } catch (error) {
    statusOutput.textContent = kiriT(error?.message || "キャンセルできませんでした。");
  }
  await refreshCaptureStatus();
});

function currentSettings() {
  return {
    mode: mode.value,
    format: format.value,
    captureDelay: captureDelay.value === "custom" ? Math.max(1, normalizeCaptureDelay(captureDelaySeconds.value)) : Number(captureDelay.value),
    paginationScope: paginationScope.value,
    paginationLimit: normalizePaginationLimit(paginationLimit.value),
    paginationWait: normalizePaginationWait(paginationWait.value),
    destination: destination.value,
    filenamePattern: filenamePattern.value,
    splitOutput: splitOutput.checked,
    maxFrames: normalizeMaxFrames(maxFramesInput.value),
    scrollSpeed: scrollSpeed.value,
    scrollWaitMs: normalizeScrollWait(scrollWaitInput.value, { emptyIsDefault: true }),
    folder: folder.value,
    removeAds: removeAds.checked,
    manualHide: manualHide.checked,
    preview: previewEdit.checked
  };
}

function saveSettings() {
  return settingsStore.save(currentSettings(), siteSettingsEnabled.checked ? siteHost : null);
}

function persistSettingsFromControls() {
  void saveSettings().catch((error) => {
    console.error("設定を保存できませんでした。", error);
    statusOutput.textContent = kiriT("設定を保存できませんでした。");
  });
}

function applySettings(captureSettings) {
  if (captureSettings) {
    applySavedSettings(captureSettings);
  } else {
    applyLegacySettings();
  }
  updateControls();
}

function applySavedSettings(captureSettings) {
  const settings = { ...defaults, ...captureSettings };
  setSelectValueIfValid(mode, settings.mode, ["viewport", "region", "full", "scroll-area", "pagination"]);
  format.value = selectValue(settings.format, ["png", "jpeg", "pdf"], defaults.format);
  const delay = normalizeCaptureDelay(settings.captureDelay);
  captureDelay.value = [0, 3, 5].includes(delay) ? String(delay) : "custom";
  if (delay > 0 && ![3, 5].includes(delay)) captureDelaySeconds.value = String(delay);
  paginationScope.value = selectValue(settings.paginationScope, ["viewport", "full", "scroll-area"], defaults.paginationScope);
  paginationLimit.value = normalizePaginationLimit(settings.paginationLimit);
  paginationWait.value = normalizePaginationWait(settings.paginationWait);
  setSelectValueIfValid(destination, settings.destination, ["save", "copy", "both"]);
  setSelectValueIfValid(filenamePattern, settings.filenamePattern, ["title-date", "date-site-title", "site-date-title"]);
  splitOutput.checked = settings.splitOutput === true;
  maxFramesInput.value = normalizeMaxFrames(settings.maxFrames);
  setSelectValueIfValid(scrollSpeed, settings.scrollSpeed, ["fast", "normal", "slow", "custom"]);
  scrollWaitInput.value = normalizeScrollWait(settings.scrollWaitMs);
  folder.value = settings.folder || defaults.folder;
  removeAds.checked = settings.removeAds === true;
  manualHide.checked = settings.manualHide === true;
  previewEdit.checked = settings.preview !== false;
}

function selectValue(value, allowedValues, fallback) {
  return allowedValues.includes(value) ? value : fallback;
}

function setSelectValueIfValid(select, value, allowedValues) {
  if (allowedValues.includes(value)) select.value = value;
}

function applyLegacySettings() {
  // 以前の版のポップアップ設定を引き継ぎます。
  folder.value = localStorage.getItem("capture-folder") || defaults.folder;
  removeAds.checked = localStorage.getItem("remove-ads") === "true";
}

async function loadSettings() {
  const [tabs, data] = await Promise.all([chrome.tabs.query({ active: true, lastFocusedWindow: true }), settingsStore.load()]);
  const tabUrl = tabs[0]?.url;
  let fileAccessAllowed;
  if (tabUrl?.startsWith("file:")) {
    try { fileAccessAllowed = await chrome.extension.isAllowedFileSchemeAccess(); }
    catch (error) { console.warn("ファイルへのアクセス設定を確認できませんでした。", error); }
  }
  const restriction = capturePageRestriction(tabUrl, fileAccessAllowed);
  const restrictionMessages = {
    "browser-page": "Chromeの設定画面など、ブラウザー内部のページは撮影できません。",
    "web-store": "Chrome ウェブストアのページは撮影できません。",
    "file-access": "ローカルファイルを撮影するには、拡張機能の設定でファイルのURLへのアクセスを許可してください。"
  };
  captureRestricted = Boolean(restriction);
  captureAvailability.hidden = !restriction;
  captureAvailability.textContent = restriction ? kiriT(restrictionMessages[restriction]) : "";
  siteHost = siteKey(tabUrl);
  const profiles = data.siteCaptureSettings;
  const hasProfile = Boolean(siteHost && profiles && Object.hasOwn(profiles, siteHost));
  siteSettingsEnabled.disabled = !siteHost;
  siteSettingsEnabled.checked = hasProfile;
  siteSettingsStatus.textContent = siteHost ? kiriT("対象サイト: $1", siteHost) : kiriT("このページではサイト別設定を使えません。");
  applySettings(hasProfile ? profiles[siteHost] : data.captureSettings);
}

siteSettingsEnabled.addEventListener("change", async () => {
  if (!siteHost || !settingsLoaded) return;
  siteSettingsEnabled.disabled = true;
  try {
    await settingsStore.wait();
    if (siteSettingsEnabled.checked) { await saveSettings(); }
    else {
      const globalSettings = await settingsStore.removeSite(siteHost);
      applySettings(globalSettings || defaults);
    }
  } catch (error) {
    console.error("サイト別設定を保存できませんでした。", error);
    siteSettingsStatus.textContent = kiriT("サイト別設定を保存できませんでした。");
  }
  finally { siteSettingsEnabled.disabled = false; }
});

function updateControls() {
  const isPdf = format.value === "pdf";
  const isPagination = mode.value === "pagination";
  paginationSetting.hidden = !isPagination;
  paginationAreaNote.hidden = paginationScope.value !== "scroll-area";
  captureDelayCustom.hidden = captureDelay.value !== "custom";
  document.querySelector("#capture-delay-note").hidden = captureDelay.value === "0";
  previewEdit.disabled = false;
  document.querySelector("#preview-label").textContent = isPagination ? kiriT("出力前にプレビュー") : kiriT("出力前にプレビュー・編集");
  document.querySelector("#preview-note").hidden = isPagination;
  removeAds.disabled = isPagination;
  manualHide.disabled = isPagination;
  const modeDescriptions = {
    viewport: "今画面に表示されている部分を撮影します。",
    region: "画面上で選んだ範囲を撮影します。",
    full: "ページ全体を縦にスクロールして撮影します。",
    "scroll-area": "表など、ページ内で個別にスクロールする領域を撮影します。",
    pagination: "次のページに進みながら複数ページを撮影します。"
  };
  captureModeDescription.textContent = kiriT(modeDescriptions[mode.value] || "");
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
  destinationFolderSummary.hidden = destination.value === "copy";
  const folderPath = normalizeFolder(folder.value);
  destinationFolderPath.textContent = kiriT("保存先: $1", folderPath ? `Downloads / ${folderPath}` : "Downloads");
  splitSetting.hidden = !["full", "scroll-area"].includes(mode.value) || destination.value === "copy";
}

mode.addEventListener("change", () => { updateControls(); persistSettingsFromControls(); });
format.addEventListener("change", () => { updateControls(); persistSettingsFromControls(); });
captureDelay.addEventListener("change", () => { updateControls(); persistSettingsFromControls(); });
captureDelaySeconds.addEventListener("change", () => { captureDelaySeconds.value = String(Math.max(1, normalizeCaptureDelay(captureDelaySeconds.value))); persistSettingsFromControls(); });
paginationLimit.addEventListener("change", persistSettingsFromControls);
paginationScope.addEventListener("change", () => { updateControls(); persistSettingsFromControls(); });
paginationWait.addEventListener("change", persistSettingsFromControls);
destination.addEventListener("change", () => { updateControls(); persistSettingsFromControls(); });
filenamePattern.addEventListener("change", persistSettingsFromControls);
splitOutput.addEventListener("change", persistSettingsFromControls);
scrollSpeed.addEventListener("change", () => { updateControls(); persistSettingsFromControls(); });
scrollWaitInput.addEventListener("change", () => { scrollWaitInput.value = normalizeScrollWait(scrollWaitInput.value, { emptyIsDefault: true }); persistSettingsFromControls(); });
maxFramesInput.addEventListener("change", () => { maxFramesInput.value = normalizeMaxFrames(maxFramesInput.value); persistSettingsFromControls(); });
folder.addEventListener("input", updateControls);
folder.addEventListener("change", persistSettingsFromControls);
changeDestinationFolder.addEventListener("click", () => {
  document.querySelector("#advanced-settings").open = true;
  folder.focus();
  folder.scrollIntoView({ block: "nearest" });
});
removeAds.addEventListener("change", persistSettingsFromControls);
manualHide.addEventListener("change", persistSettingsFromControls);
previewEdit.addEventListener("change", persistSettingsFromControls);
updateControls();
const settingsReady = loadSettings()
  .catch(() => {
    statusOutput.textContent = kiriT("設定を読み込めませんでした。拡張機能を再読み込みしてください。");
  })
  .finally(() => { settingsLoaded = true; updateCaptureButton(); });

captureButton.addEventListener("click", async () => {
  startPending = true;
  captureBusy = true;
  updateCaptureButton();
  statusOutput.textContent = ["full", "scroll-area"].includes(mode.value) ? kiriT("ページをスクロールしながら撮影しています…") : kiriT("撮影しています…");

  try {
    await settingsReady;
    await saveSettings();
    const result = await chrome.runtime.sendMessage({
      type: "capture:start",
      options: currentSettings()
    });
    if (result?.cancelled) {
      statusOutput.textContent = kiriT("撮影をキャンセルしました。");
      return;
    }
    if (!result?.ok) throw new Error(result?.error || kiriT("撮影に失敗しました。"));
    statusOutput.textContent = result.message;
  } catch (error) {
    statusOutput.textContent = kiriT(error?.message || "撮影に失敗しました。");
  } finally {
    startPending = false;
    await refreshCaptureStatus();
    updateCaptureButton();
  }
});

try {
  draftDb = (await import("./draft-store.js")).draftStore;
  const draftSettings = await chrome.storage.local.get("draftRetentionDays");
  draftRetention.value = String([0, 1, 7, 30].includes(draftSettings.draftRetentionDays) ? draftSettings.draftRetentionDays : 7);
  await refreshDrafts();
} catch (error) {
  console.error("下書きを読み込めませんでした。", error);
  draftListStatus.textContent = kiriT("下書きを読み込めませんでした。");
}

await Promise.all([refreshCaptureStatus(), refreshFailures()]);
