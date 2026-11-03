kiriLocalizeDocument();
const mode = document.querySelector("#capture-mode");
const format = document.querySelector("#output-format");
const destination = document.querySelector("#destination");
const filenamePattern = document.querySelector("#filename-pattern");
const splitOutput = document.querySelector("#split-output");
const splitSetting = document.querySelector("#split-setting");
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
  destination: "save",
  filenamePattern: "title-date",
  splitOutput: false,
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
    const modes = { viewport: kiriT("表示中の範囲"), region: kiriT("選択範囲"), full: kiriT("ページ全体") };
    const phases = { preparing: kiriT("準備中"), selecting: kiriT("要素選択中"), capturing: kiriT("撮影中"), processing: kiriT("画像処理中"), editing: kiriT("編集中"), saving: kiriT("出力中") };
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
  const showProgress = captureBusy && (captureStatus.mode === "full" || captureStatus.phase === "editing" || captureStatus.phase === "selecting");
  progressPanel.hidden = !showProgress;
  if (showProgress) {
    if (captureStatus.cancelRequested || captureStatus.phase === "cancelling") {
      progressText.textContent = kiriT("撮影をキャンセルしています…");
    } else if (captureStatus.phase === "selecting") {
      progressText.textContent = kiriT("ページ上で隠す要素を選び、「選択完了」を押してください。");
    } else if (captureStatus.phase === "editing") {
      progressText.textContent = kiriT("プレビュー画面で画像を確認・編集してください。");
    } else if (captureStatus.phase === "processing") {
      progressText.textContent = kiriT("$1画面を撮影し、画像をまとめています…", captureStatus.currentFrame);
    } else if (captureStatus.phase === "saving") {
      progressText.textContent = kiriT("撮影した画像を出力しています…");
    } else if (captureStatus.currentFrame > 0) {
      progressText.textContent = kiriT("現在$1画面目を撮影中…", captureStatus.currentFrame);
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
    destination: destination.value,
    filenamePattern: filenamePattern.value,
    splitOutput: splitOutput.checked,
    folder: folder.value,
    removeAds: removeAds.checked,
    manualHide: manualHide.checked,
    preview: previewEdit.checked
  };
}

async function saveSettings() {
  const snapshot = currentSettings();
  settingsWrite = settingsWrite
    .catch(() => undefined)
    .then(() => chrome.storage.local.set({ captureSettings: snapshot }));
  await settingsWrite;
}

async function loadSettings() {
  const { captureSettings } = await chrome.storage.local.get("captureSettings");
  if (captureSettings) {
    const settings = { ...defaults, ...captureSettings };
    if (["viewport", "region", "full"].includes(settings.mode)) mode.value = settings.mode;
    if (["png", "jpeg", "pdf", "md"].includes(settings.format)) format.value = settings.format;
    if (["save", "copy", "both"].includes(settings.destination)) destination.value = settings.destination;
    if (["title-date", "date-site-title", "site-date-title"].includes(settings.filenamePattern)) filenamePattern.value = settings.filenamePattern;
    splitOutput.checked = settings.splitOutput === true;
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
  await saveSettings();
}

function updateControls() {
  const isPdf = format.value === "pdf";
  for (const option of destination.options) {
    if (option.value === "copy" || option.value === "both") {
      option.disabled = isPdf;
    }
  }
  if (isPdf && destination.value !== "save") destination.value = "save";
  folderRow.hidden = destination.value === "copy";
  splitSetting.hidden = mode.value !== "full" || format.value === "md" || destination.value === "copy";
}

mode.addEventListener("change", () => { updateControls(); saveSettings(); });
format.addEventListener("change", () => { updateControls(); saveSettings(); });
destination.addEventListener("change", () => { updateControls(); saveSettings(); });
filenamePattern.addEventListener("change", saveSettings);
splitOutput.addEventListener("change", saveSettings);
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
  status.textContent = mode.value === "full" ? kiriT("ページをスクロールしながら撮影しています…") : kiriT("撮影しています…");

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
