import "./i18n.js";
import { draftStore } from "./draft-store.js";
import {
  updateCountdownOverlay,
  selectPaginationButton,
  cancelPaginationSelection,
  paginationSnapshot,
  clickPaginationButton,
  readPageInfo,
  selectElementsToHide,
  cancelManualSelection,
  restoreStaleScrollAreaState,
  selectScrollableArea,
  getPaginationAreaLocator,
  activatePaginationArea
} from "./page-selection.js";
import {
  scrollScrollableArea,
  readScrollableAreaMetrics,
  hideScrollableAreaSticky,
  suppressScrollableAreaHover,
  waitForScrollableAreaStable,
  restoreScrollableArea,
  restoreManualHiddenElements,
  hideBackToTopButtons,
  restoreBackToTopButtons,
  applyAdFilter,
  restoreAdFilter,
  selectRegion,
  prepareFullPage,
  scrollFullPage,
  readFullPageMetrics,
  waitForPageHeightStable,
  restoreFullPage
} from "./page-capture.js";


let offscreenCreation;
let activeCapture = null;
let lastCaptureStatus = null;
let captureRevision = 0;
const badgeTimers = new Map();
const failureHistoryKey = "captureFailureHistory";
let failureHistoryWrite = Promise.resolve();
const draftUpdateQueues = new Map();

const runtimeMessageHandlers = new Map([
  ["capture:failures:list", handleFailureList],
  ["capture:failures:clear", handleFailureClear],
  ["capture:status", handleCaptureStatus],
  ["capture:cancel", handleCaptureCancel],
  ["capture:editor:focus", handleEditorFocus],
  ["capture:editor:retake", handleEditorRetake],
  ["capture:editor:load", handleEditorMessage],
  ["capture:editor:commit", handleEditorMessage],
  ["capture:pagination:accept", handleEditorMessage],
  ["draft:update", handleDraftUpdate],
  ["draft:export", handleDraftExport],
  ["capture:start", handleCaptureStart]
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;
  return runtimeMessageHandlers.get(message?.type)?.(message, sender, sendResponse) ?? false;
});

function handleFailureList(_message, _sender, sendResponse) {
  failureHistoryWrite.then(() => chrome.storage.local.get(failureHistoryKey))
    .then((data) => sendResponse({ ok: true, failures: Array.isArray(data[failureHistoryKey]) ? data[failureHistoryKey] : [] }))
    .catch(() => sendResponse({ ok: false, error: kiriT("失敗履歴を読み込めませんでした。") }));
  return true;
}

function handleFailureClear(_message, _sender, sendResponse) {
  failureHistoryWrite = failureHistoryWrite.catch(() => undefined).then(() => chrome.storage.local.set({ [failureHistoryKey]: [] }));
  failureHistoryWrite.then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false, error: kiriT("失敗履歴を削除できませんでした。") }));
  return true;
}

function handleCaptureStatus(_message, _sender, sendResponse) {
  sendResponse({ ok: true, status: activeCapture ? captureStatus(activeCapture) : lastCaptureStatus });
  return false;
}

function handleCaptureCancel(message, _sender, sendResponse) {
  const job = activeCapture;
  if (!job?.cancellable || (message.jobId?.length && message.jobId !== job.id)) {
    sendResponse({ ok: false, error: kiriT("キャンセルできる撮影はありません。") });
    return false;
  }
  const wasSelecting = job.phase === "selecting";
  job.cancelRequested = true;
  reportCapture(job, { phase: "cancelling" });
  job.editorResolve?.(null);
  if (wasSelecting && job.tabId) {
    void executeInTab(job.tabId, cancelManualSelection, [job.id]).catch(() => undefined);
    if (job.selectionKind === "pagination") void executeInTab(job.tabId, cancelPaginationSelection, [job.id]).catch(() => undefined);
  }
  sendResponse({ ok: true });
  return false;
}

function handleEditorFocus(_message, _sender, sendResponse) {
  if (!activeCapture?.editorTabId || activeCapture.phase !== "editing") {
    sendResponse({ ok: false, error: kiriT("編集画面が見つかりません。") });
    return false;
  }
  chrome.tabs.update(activeCapture.editorTabId, { active: true })
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false, error: kiriT("編集画面を開けませんでした。") }));
  return true;
}

function handleEditorRetake(message, sender, sendResponse) {
  const job = activeCapture;
  const validSender = sender?.url?.startsWith(chrome.runtime.getURL("editor.html")) && sender.tab?.id === job?.editorTabId;
  if (!validSender || !job || job.id !== message.jobId || job.phase !== "editing" || job.editorCommitted || job.editorRetakePending) {
    sendResponse({ ok: false, error: kiriT("撮り直しを開始できませんでした。") });
    return false;
  }
  job.editorRetakePending = true;
  retakeCapture(job)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: kiriT(error.message || "撮り直しを開始できませんでした。") }))
    .finally(() => { job.editorRetakePending = false; });
  return true;
}

async function retakeCapture(job) {
  let tab;
  try {
    tab = await chrome.tabs.get(job.tabId);
  } catch (_) {
    throw new Error("撮影元のタブが見つかりません。");
  }
  if (!tab?.url || tab.url !== job.editorMeta?.url) throw new Error("撮影元のページが変更されています。元のページを開き直して撮影してください。");
  assertRetakeAllowed(job);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  assertRetakeAllowed(job);
  job.editorCommitted = true;
  reportCapture(job, { phase: "processing", cancellable: false });
  job.editorResolve?.({ retry: true, tab });
  return { ok: true };
}

function assertRetakeAllowed(job) {
  if (activeCapture !== job || job.phase !== "editing" || job.cancelRequested || job.editorCommitted) {
    throw new Error("撮り直しを開始できませんでした。");
  }
}

function handleEditorMessage(message, sender, sendResponse) {
  const context = getEditorMessageContext(message, sender);
  if (!context) {
    sendResponse({ ok: false, error: kiriT("編集する画像が見つかりません。") });
    return false;
  }
  const { job, isPaginationPreview } = context;
  job.editorTabId = sender.tab.id;
  if (message.type === "capture:editor:load") return sendEditorLoadResponse(job, sendResponse);
  if (message.type === "capture:pagination:accept") return acceptPaginationPreview(job, isPaginationPreview, sendResponse);
  return commitEditorImage(message, job, isPaginationPreview, sendResponse);
}

function getEditorMessageContext(message, sender) {
  const job = activeCapture;
  const isPaginationPreview = job?.mode === "pagination" && sender?.url?.startsWith(chrome.runtime.getURL("pagination-preview.html"));
  const isImageEditor = job?.mode !== "pagination" && sender?.url?.startsWith(chrome.runtime.getURL("editor.html"));
  const validSender = (isPaginationPreview || isImageEditor) && sender?.tab?.id;
  if (!job || job.id !== message.jobId || job.phase !== "editing" || !validSender ||
      (job.editorTabId && sender.tab.id !== job.editorTabId)) return null;
  return { job, isPaginationPreview };
}

function sendEditorLoadResponse(job, sendResponse) {
  sendResponse({ ok: true, url: job.previewUrl, format: job.editorOptions.format, destination: job.editorOptions.destination, meta: job.editorMeta, options: job.editorOptions, pagination: job.previewPages, sourceTabId: job.tabId });
  return false;
}

function acceptPaginationPreview(job, isPaginationPreview, sendResponse) {
  if (!isPaginationPreview || job.editorCommitted || job.editorRetakePending) {
    sendResponse({ ok: false, error: kiriT("編集画像を受け取れませんでした。") });
    return false;
  }
  job.editorCommitted = true;
  reportCapture(job, { phase: "processing", cancellable: false });
  job.editorResolve?.({ unchanged: true });
  sendResponse({ ok: true });
  return false;
}

function commitEditorImage(message, job, isPaginationPreview, sendResponse) {
  const validImage = typeof message.url === "string" && message.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`);
  if (isPaginationPreview || job.editorCommitted || job.editorRetakePending || !validImage) {
    sendResponse({ ok: false, error: kiriT("編集画像を受け取れませんでした。") });
    return false;
  }
  job.editorCommitted = true;
  reportCapture(job, { phase: "processing", cancellable: false });
  job.editorResolve?.({ url: message.url });
  sendResponse({ ok: true });
  return false;
}

function handleDraftUpdate(message, sender, sendResponse) {
  const validSender = sender?.url?.startsWith(chrome.runtime.getURL("editor.html")) && sender.tab?.id;
  const validData = typeof message.id === "string" && Array.isArray(message.history) && Array.isArray(message.redoStack) && [1, 7, 30].includes(message.retentionDays);
  if (!validSender || !validData) {
    sendResponse({ ok: false });
    return false;
  }
  const previous = draftUpdateQueues.get(message.id) || Promise.resolve();
  const update = previous.catch(() => undefined).then(() => {
    const now = Date.now();
    return draftStore.update(message.id, { history: message.history, redoStack: message.redoStack, retentionDays: message.retentionDays, updatedAt: now, expiresAt: now + message.retentionDays * 86400000 });
  });
  draftUpdateQueues.set(message.id, update);
  update.then((found) => sendResponse({ ok: found })).catch(() => sendResponse({ ok: false })).finally(() => {
    if (draftUpdateQueues.get(message.id) === update) draftUpdateQueues.delete(message.id);
  });
  return true;
}

function handleDraftExport(message, sender, sendResponse) {
  const validSender = sender?.url?.startsWith(chrome.runtime.getURL("editor.html")) && sender.tab?.id;
  const validUrl = typeof message.url === "string" && message.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`);
  if (!validSender || !validUrl) {
    sendResponse({ ok: false, error: kiriT("画像を出力できませんでした。") });
    return false;
  }
  exportRecoveredDraft(message.id, message.url)
    .then((result) => sendResponse({ ok: true, message: result }))
    .catch((error) => sendResponse({ ok: false, error: explainError(error) }));
  return true;
}

function handleCaptureStart(message, _sender, sendResponse) {
  startCapture(message.options)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, cancelled: error?.name === "CaptureCancelled", error: explainError(error) }));
  return true;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "kiritori-selector") {
    port.onMessage.addListener(() => {});
    return;
  }
  if (port.name !== "kiritori-editor") return;
  let linkedJob;
  let linkedJobId;
  port.onMessage.addListener((message) => {
    if (message?.type === "hello" && activeCapture?.id === message.jobId) { linkedJob = activeCapture; linkedJobId = message.jobId; }
  });
  port.onDisconnect.addListener(() => {
    if (linkedJob && activeCapture === linkedJob && linkedJob.id === linkedJobId && linkedJob.phase === "editing" && !linkedJob.editorCommitted) {
      linkedJob.cancelRequested = true;
      reportCapture(linkedJob, { phase: "cancelling" });
      linkedJob.editorResolve?.(null);
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const job = activeCapture;
  if (job?.editorTabId === tabId && job.phase === "editing" && !job.editorCommitted) {
    job.cancelRequested = true;
    reportCapture(job, { phase: "cancelling" });
    job.editorResolve?.(null);
  }
});

function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "local-capture-root",
      title: "KiriTori",
      contexts: ["all"]
    });
    chrome.contextMenus.create({
      id: "local-capture-viewport",
      parentId: "local-capture-root",
      title: kiriT("表示中の範囲を撮影"),
      contexts: ["all"]
    });
    chrome.contextMenus.create({
      id: "local-capture-region",
      parentId: "local-capture-root",
      title: kiriT("範囲を選択して撮影"),
      contexts: ["all"]
    });
    chrome.contextMenus.create({
      id: "local-capture-full",
      parentId: "local-capture-root",
      title: kiriT("ページ全体を撮影"),
      contexts: ["all"]
    });
    chrome.contextMenus.create({
      id: "local-capture-scroll-area",
      parentId: "local-capture-root",
      title: kiriT("スクロール領域を撮影"),
      contexts: ["all"]
    });
    chrome.contextMenus.create({
      id: "local-capture-pagination",
      parentId: "local-capture-root",
      title: kiriT("ページ送りをしながら撮影"),
      contexts: ["all"]
    });
  });
}
chrome.runtime.onInstalled.addListener(registerContextMenus);
chrome.runtime.onStartup.addListener(registerContextMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const modeByMenuId = {
    "local-capture-viewport": "viewport",
    "local-capture-region": "region",
    "local-capture-full": "full",
    "local-capture-scroll-area": "scroll-area",
    "local-capture-pagination": "pagination"
  };
  const mode = modeByMenuId[info.menuItemId];
  if (!mode || !tab?.id) return;
  await runQuickCapture({ ...tab, url: tab.url || info.pageUrl }, mode);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "capture-current-settings") return;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs[0]?.id) return;
  await runQuickCapture(tabs[0]);
});

function captureStatus(job) {
  return {
    jobId: job.id,
    active: job.active,
    mode: job.mode,
    phase: job.phase,
    currentFrame: job.currentFrame,
    selectionKind: job.selectionKind || null,
    countdownRemaining: job.countdownRemaining || 0,
    cancellable: job.cancellable,
    cancelRequested: job.cancelRequested,
    message: job.message || "",
    editorTabId: job.editorTabId || null,
    revision: job.revision
  };
}

function reportCapture(job, changes = {}) {
  Object.assign(job, changes);
  job.revision = ++captureRevision;
  const status = captureStatus(job);
  lastCaptureStatus = status;
  if ((["full", "scroll-area", "pagination"].includes(job.mode) || job.hadCountdown) && job.tabId) {
    const text = captureBadgeText(job);
    chrome.action.setBadgeText({ text, tabId: job.tabId }).catch(() => undefined);
    chrome.action.setBadgeBackgroundColor({ color: "#1a73e8", tabId: job.tabId }).catch(() => undefined);
    const description = captureStatusDescription(job);
    const title = job.active ? `KiriTori: ${description}` : "KiriTori";
    chrome.action.setTitle({ title, tabId: job.tabId }).catch(() => undefined);
  }
  chrome.runtime.sendMessage({ type: "capture:progress", status }).catch(() => undefined);
}

function captureBadgeText(job) {
  if (!job.active) return "";
  if (job.phase === "countdown") return String(job.countdownRemaining);
  return job.currentFrame ? String(job.currentFrame) : "…";
}

function captureStatusDescription(job) {
  if (job.cancelRequested) return kiriT("撮影をキャンセル中");
  if (job.phase === "countdown") return kiriT("$1秒後に撮影を開始します…", job.countdownRemaining);
  if (job.phase === "selecting") return selectionStatusDescription(job);
  if (job.phase === "editing") return kiriT("プレビューで編集中");
  if (job.phase === "processing") return kiriT("画像をまとめています");
  if (job.phase === "saving") return kiriT("画像を出力中");
  if (job.currentFrame) return kiriT("$1画面目を撮影中", job.currentFrame);
  return kiriT("撮影を準備中");
}

function selectionStatusDescription(job) {
  if (job.mode === "scroll-area" && job.selectionKind === "scroll-area") return kiriT("スクロール領域を選択中");
  return kiriT("隠す要素を選択中");
}

function throwIfCancelled(job) {
  if (job.cancelRequested) {
    const error = new Error("撮影をキャンセルしました。");
    error.name = "CaptureCancelled";
    throw error;
  }
}

async function startCapture(options, targetTab) {
  if (activeCapture) {
    const error = new Error("別の撮影が進行中です。完了またはキャンセルを待ってください。");
    await rememberFailure(error, { mode: options?.mode, phase: "preparing" });
    throw error;
  }
  const job = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    active: true, mode: options?.mode, phase: "preparing", currentFrame: 0,
    cancellable: ["full", "scroll-area", "pagination"].includes(options?.mode), cancelRequested: false,
    tabId: targetTab?.id, offscreenStarted: false, revision: 0
  };
  activeCapture = job;
  if (job.tabId && badgeTimers.has(job.tabId)) {
    clearTimeout(badgeTimers.get(job.tabId));
    badgeTimers.delete(job.tabId);
  }
  reportCapture(job);
  try {
    let captureTab = targetTab;
    while (true) {
      const result = await handleCapture(options, captureTab, job);
      if (!result.retry) {
        reportCapture(job, { active: false, phase: "completed", cancellable: false, message: result.message });
        return result;
      }
      captureTab = result.tab;
      job.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      job.editorTabId = null;
      job.editorCommitted = false;
      reportCapture(job, { phase: "preparing", currentFrame: 0, cancellable: ["full", "scroll-area", "pagination"].includes(job.mode) });
    }
  } catch (error) {
    if (job.offscreenStarted) await offscreenMessage({ type: "discard" }).catch(() => undefined);
    const cancelled = error?.name === "CaptureCancelled";
    const failureContext = { mode: job.mode, phase: job.phase, currentFrame: job.currentFrame };
    reportCapture(job, { active: false, phase: cancelled ? "cancelled" : "error", cancellable: false, message: explainError(error) });
    if (!cancelled) await rememberFailure(error, failureContext);
    throw error;
  } finally {
    if (activeCapture === job) activeCapture = null;
  }
}

async function handleCapture(options, targetTab, job) {
  options = validateCaptureOptions(options);
  const tab = await resolveCaptureTab(targetTab);
  job.tabId = tab.id;
  clearTabBadgeTimer(tab.id);
  await prepareCaptureTab(tab, options, job);

  const state = createCaptureState(options);
  try {
    await prepareCaptureEnvironment(tab, options, job, state);
    if (options.mode === "pagination") {
      await capturePaginationMode(tab, options, job, state);
    } else if (options.mode === "full") {
      await captureFullPage(tab, options, job, state);
    } else if (options.mode === "scroll-area") {
      await captureScrollableArea(tab, options, job, state);
    } else {
      await captureViewportOrRegion(tab, options, job, state);
    }
  } finally {
    await restoreCaptureEnvironment(tab, job, state);
  }
  return finalizeCapture(options, job, state);
}

function validateCaptureOptions(options) {
  if (!options || !["viewport", "region", "full", "scroll-area", "pagination"].includes(options.mode)) {
    throw new Error("撮影範囲を選び直してください。");
  }
  if (!["png", "jpeg", "pdf"].includes(options.format)) {
    throw new Error("出力形式を選び直してください。");
  }
  if (!["save", "copy", "both"].includes(options.destination)) {
    throw new Error("出力先を選び直してください。");
  }
  if (options.format === "pdf" && options.destination !== "save") {
    throw new Error("PDFはファイル保存のみ対応しています。");
  }
  if (options.mode !== "pagination") return options;
  return { ...options, destination: "save", removeAds: false, manualHide: false };
}

async function resolveCaptureTab(targetTab) {
  const tabs = targetTab ? [] : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = targetTab || tabs[0];
  if (!tab?.id || !tab.windowId) throw new Error("撮影するChromeタブが見つかりません。");
  return tab;
}

function clearTabBadgeTimer(tabId) {
  if (!badgeTimers.has(tabId)) return;
  clearTimeout(badgeTimers.get(tabId));
  badgeTimers.delete(tabId);
}

async function prepareCaptureTab(tab, options, job) {
  const seconds = [3, 5].includes(options.captureDelay) ? options.captureDelay : 0;
  if (seconds) await runCaptureCountdown(tab, job, seconds, options);
  else {
    reportCapture(job);
    throwIfCancelled(job);
  }
  await ensureOffscreenDocument();
  throwIfCancelled(job);
  await executeInTab(tab.id, restoreStaleScrollAreaState);
  throwIfCancelled(job);
}

async function runCaptureCountdown(tab, job, seconds, options) {
  job.hadCountdown = true;
  const deadline = Date.now() + seconds * 1000;
  try {
    await continueCaptureCountdown(tab, job, options, deadline, 0);
  } finally {
    await executeInTab(tab.id, updateCountdownOverlay, [job.id, 0, ""]);
  }
  throwIfCancelled(job);
  await assertTabStillActive(tab.id, tab.windowId);
  throwIfCancelled(job);
  reportCapture(job, { phase: "preparing", countdownRemaining: 0, cancellable: ["full", "scroll-area", "pagination"].includes(options.mode) });
}

async function continueCaptureCountdown(tab, job, options, deadline, previousRemaining) {
  throwIfCancelled(job);
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return;
  const remaining = Math.ceil(remainingMs / 1000);
  if (remaining !== previousRemaining) {
    reportCapture(job, { phase: "countdown", countdownRemaining: remaining, cancellable: true });
    await executeInTab(tab.id, updateCountdownOverlay, [job.id, remaining, kiriT("$1秒後に撮影を開始します…", remaining)]);
  }
  await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  await continueCaptureCountdown(tab, job, options, deadline, remaining);
}

function createCaptureState(options) {
  const maxFrames = Math.min(200, Math.max(1, Math.floor(Number(options.maxFrames) || 80)));
  const waitPresets = { fast: 200, normal: 600, slow: 1500 };
  const customWait = options.scrollWaitMs === null || options.scrollWaitMs === "" ? Number.NaN : Number(options.scrollWaitMs);
  const scrollWaitMs = options.scrollSpeed === "custom" && Number.isFinite(customWait)
    ? Math.min(10000, Math.max(0, Math.floor(customWait)))
    : (waitPresets[options.scrollSpeed] ?? 600);
  return {
    meta: null,
    adFilterApplied: false,
    backToTopFilterRequested: false,
    manualHideRequested: false,
    scrollAreaSelected: false,
    reachedLimit: false,
    paginationWarning: "",
    maxFrames,
    scrollWaitMs,
    lastFrameCapturedAt: 0,
    previousY: -1
  };
}

async function prepareCaptureEnvironment(tab, options, job, state) {
  state.backToTopFilterRequested = true;
  await executeInTab(tab.id, hideBackToTopButtons);
  throwIfCancelled(job);
  if (options.removeAds === true) {
    state.adFilterApplied = true;
    await executeInTab(tab.id, applyAdFilter);
    throwIfCancelled(job);
  }
  if (options.manualHide === true) {
    state.manualHideRequested = true;
    await selectElementsToHideForCapture(tab, options, job);
  }
}

async function selectElementsToHideForCapture(tab, options, job) {
  reportCapture(job, { phase: "selecting", cancellable: true });
  throwIfCancelled(job);
  const selection = await executeInTab(tab.id, selectElementsToHide, [job.id, {
    label: kiriT("非表示にする要素の選択"), instruction: kiriT("クリックで非表示 · ↑で親要素を選択"),
    count: kiriT("選択: $1", "__COUNT__"), undo: kiriT("直前を戻す"), cancel: kiriT("キャンセル"), done: kiriT("選択完了")
  }]);
  if (selection?.cancelled) job.cancelRequested = true;
  throwIfCancelled(job);
  reportCapture(job, { phase: "preparing", cancellable: ["full", "scroll-area", "pagination"].includes(options.mode) });
}

async function restoreCaptureEnvironment(tab, job, state) {
  if (state.scrollAreaSelected) await executeInTab(tab.id, restoreScrollableArea, [job.id]).catch(() => undefined);
  if (state.manualHideRequested) await executeInTab(tab.id, restoreManualHiddenElements, [job.id]).catch(() => undefined);
  if (state.adFilterApplied) await executeInTab(tab.id, restoreAdFilter).catch(() => undefined);
  if (state.backToTopFilterRequested) await executeInTab(tab.id, restoreBackToTopButtons).catch(() => undefined);
}

async function capturePaginationMode(tab, options, job, state) {
  const target = await selectPaginationTarget(tab, options, job, state);
  state.meta = { ...target.page, mode: "pagination" };
  options.fileStem = makeFileStem(state.meta, options.filenamePattern);
  await offscreenMessage({ type: target.useBundle ? "begin-pagination-bundle" : "begin", meta: state.meta, options });
  job.offscreenStarted = true;
  const timing = { last: 0 };
  const limit = Math.min(50, Math.max(1, Math.floor(Number(options.paginationLimit) || 20)));
  const waitMs = Math.min(10000, Math.max(500, Math.floor(Number(options.paginationWait) || 1500)));
  const finishedEarly = await capturePaginationPages(tab, job, state, target, timing, limit, waitMs);
  if (!finishedEarly) state.paginationWarning = kiriT("$1ページの上限まで撮影しました。続きは含まれていません。", limit);
}

async function selectPaginationTarget(tab, options, job, state) {
  const page = await executeInTab(tab.id, readPageInfo);
  const scope = ["viewport", "full", "scroll-area"].includes(options.paginationScope) ? options.paginationScope : "viewport";
  const useBundle = scope !== "viewport";
  let areaLocator = null;
  if (scope === "scroll-area") {
    areaLocator = await selectPaginationScrollArea(tab, job, state);
  }
  reportCapture(job, { phase: "selecting", selectionKind: "pagination", cancellable: true });
  const button = await executeInTab(tab.id, selectPaginationButton, [job.id, kiriT("ページ上の「次へ」ボタンを選んでください。"), kiriT("Escでキャンセル")]);
  if (!button) throw createCaptureCancelled("撮影をキャンセルしました。");
  throwIfCancelled(job);
  return { page, scope, useBundle, areaLocator, button };
}

async function selectPaginationScrollArea(tab, job, state) {
  reportCapture(job, { phase: "selecting", selectionKind: "scroll-area", cancellable: true });
  const selected = await executeInTab(tab.id, selectScrollableArea, [job.id, {
    label: kiriT("スクロール領域を選択"), instruction: kiriT("カーソルを合わせてクリックし、スクロール領域を選びます。↑キーで親の領域を選べます。"),
    choose: kiriT("この領域を撮影"), cancel: kiriT("キャンセル"), empty: kiriT("縦スクロールできる領域を選んでください。")
  }]);
  if (!selected) throw createCaptureCancelled("撮影をキャンセルしました。");
  state.scrollAreaSelected = true;
  throwIfCancelled(job);
  const locator = await executeInTab(tab.id, getPaginationAreaLocator, [job.id]);
  if (!locator) throw new Error("スクロール領域がページ内から見つかりません。もう一度選択してください。");
  return locator;
}

function createCaptureCancelled(message) {
  const error = new Error(message);
  error.name = "CaptureCancelled";
  return error;
}

async function capturePaginationPages(tab, job, state, target, timing, limit, waitMs) {
  const seen = new Set();
  for (let index = 0; index < limit; index += 1) {
    const shouldContinue = await capturePaginationPage({ tab, job, state, target, timing, seen, index, limit, waitMs });
    if (!shouldContinue) return true;
  }
  return false;
}

async function capturePaginationPage({ tab, job, state, target, timing, seen, index, limit, waitMs }) {
  throwIfCancelled(job);
  await assertTabStillActive(tab.id, tab.windowId);
  const snapshot = await executeInTab(tab.id, paginationSnapshot);
  if (seen.has(snapshot.signature)) {
    state.paginationWarning = kiriT("同じページが再表示されたため、そこで撮影を終了しました。");
    return false;
  }
  seen.add(snapshot.signature);
  reportCapture(job, { phase: "capturing", selectionKind: null, currentFrame: index + 1, cancellable: true });
  const captured = await captureCurrentPaginationPage(tab, job, state, target, timing, index);
  if (!captured) return false;
  if (index === limit - 1) return true;
  return advancePaginationPage(tab, job, state, target.button, target.useBundle, snapshot, waitMs);
}

async function captureCurrentPaginationPage(tab, job, state, target, timing, index) {
  try {
    if (target.useBundle) return await capturePaginationBundlePage(tab, job, state, target, timing, index);
    return await capturePaginationViewportPage(tab, job, state);
  } catch (error) {
    if (target.useBundle) await offscreenMessage({ type: "abort-pagination-page" }).catch(() => undefined);
    if (index > 0 && /ページ画像が大きすぎます/.test(error?.message || "")) {
      state.paginationWarning = kiriT("画像サイズの上限に達したため、そこまでのページを保存しました。");
      return false;
    }
    throw error;
  }
}

async function capturePaginationBundlePage(tab, job, state, target, timing, index) {
  if (target.scope === "scroll-area" && index > 0) {
    const found = await executeInTab(tab.id, activatePaginationArea, [job.id, target.areaLocator]);
    if (!found) {
      state.paginationWarning = kiriT("次のページでスクロール領域を特定できないため、そこで撮影を終了しました。");
      return false;
    }
    state.scrollAreaSelected = true;
  }
  const complete = await capturePaginatedScroll(tab, job, target.scope, target.page, state.maxFrames, state.scrollWaitMs, timing);
  if (target.scope === "scroll-area") state.scrollAreaSelected = false;
  if (complete) return true;
  state.paginationWarning = kiriT("スクロール撮影の上限に達したため、このページまでの撮影を終了しました。");
  return false;
}

async function capturePaginationViewportPage(tab, job, state) {
  if (state.lastFrameCapturedAt) await delay(Math.max(0, 510 - (Date.now() - state.lastFrameCapturedAt)));
  throwIfCancelled(job);
  const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  state.lastFrameCapturedAt = Date.now();
  await assertTabStillActive(tab.id, tab.windowId);
  throwIfCancelled(job);
  await offscreenMessage({ type: "add-frame", image });
  return true;
}

async function advancePaginationPage(tab, job, state, button, useBundle, snapshot, waitMs) {
  const beforeNext = useBundle ? await executeInTab(tab.id, paginationSnapshot) : snapshot;
  const click = await executeInTab(tab.id, clickPaginationButton, [button]);
  if (click === "end") return false;
  if (click !== "clicked") {
    state.paginationWarning = kiriT("次へボタンを確認できないため、そこで撮影を終了しました。");
    return false;
  }
  await waitWithCancellation(waitMs, job);
  const next = await findNextPaginationSnapshot(tab, job, beforeNext);
  if (next?.ready && next.signature !== beforeNext.signature) return true;
  state.paginationWarning = kiriT("ページの変化を確認できないため、そこで撮影を終了しました。");
  return false;
}

function waitWithCancellation(duration, job, elapsed = 0) {
  if (elapsed >= duration) return Promise.resolve();
  const step = Math.min(250, duration - elapsed);
  return delay(step).then(() => {
    throwIfCancelled(job);
    return waitWithCancellation(duration, job, elapsed + step);
  });
}

async function findNextPaginationSnapshot(tab, job, previousSnapshot, attempt = 0) {
  if (attempt >= 20) return null;
  throwIfCancelled(job);
  await assertTabStillActive(tab.id, tab.windowId);
  let next;
  try {
    next = await executeInTab(tab.id, paginationSnapshot);
  } catch (_) {
    // A navigation can temporarily make the tab unavailable while pagination advances.
    next = null;
  }
  if (next?.ready && next.signature !== previousSnapshot.signature) return next;
  await delay(250);
  return findNextPaginationSnapshot(tab, job, previousSnapshot, attempt + 1);
}

async function captureFullPage(tab, options, job, state) {
  const prepared = await executeInTab(tab.id, prepareFullPage);
  state.meta = { ...prepared, mode: "full" };
  options.fileStem = makeFileStem(state.meta, options.filenamePattern);
  await offscreenMessage({ type: "begin", meta: state.meta, options });
  job.offscreenStarted = true;
  try {
    await captureFullPageFrames(tab, job, state);
  } finally {
    await executeInTab(tab.id, restoreFullPage).catch(() => undefined);
  }
}

async function captureFullPageFrames(tab, job, state) {
  let targetY = 0;
  let completed = false;
  for (let index = 0; index < state.maxFrames; index += 1) {
    const result = await captureFullPageFrame(tab, job, state, index, targetY);
    if (result.completed) {
      completed = true;
      break;
    }
    targetY = result.targetY;
  }
  if (!completed) {
    await offscreenMessage({ type: "trim-to-captured" });
    state.reachedLimit = true;
  }
}

async function captureFullPageFrame(tab, job, state, index, targetY) {
  throwIfCancelled(job);
  reportCapture(job, { phase: "capturing", currentFrame: index + 1 });
  await assertTabStillActive(tab.id, tab.windowId);
  const frameInfo = await executeInTab(tab.id, scrollFullPage, [targetY]);
  throwIfCancelled(job);
  const actualY = frameInfo?.scrollY;
  if (!Number.isFinite(actualY) || (index > 0 && actualY <= state.previousY + 1)) {
    throw new Error("ページを縦にスクロールできませんでした。表示範囲か選択範囲で撮影してください。");
  }
  state.previousY = actualY;
  await delay(Math.max(state.scrollWaitMs, state.lastFrameCapturedAt ? 510 - (Date.now() - state.lastFrameCapturedAt) : 0, 0));
  throwIfCancelled(job);
  await assertTabStillActive(tab.id, tab.windowId);
  const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  state.lastFrameCapturedAt = Date.now();
  await assertTabStillActive(tab.id, tab.windowId);
  throwIfCancelled(job);
  const pageMetrics = await executeInTab(tab.id, readFullPageMetrics);
  await offscreenMessage({ type: "add-frame", image, scrollY: actualY, pageHeight: frameInfo.pageHeight, currentPageHeight: pageMetrics.pageHeight });
  throwIfCancelled(job);
  let latestMetrics = pageMetrics;
  let bottom = Math.max(0, latestMetrics.pageHeight - latestMetrics.viewportHeight);
  if (actualY >= bottom - 1) {
    latestMetrics = await executeInTab(tab.id, waitForPageHeightStable);
    throwIfCancelled(job);
    bottom = Math.max(0, latestMetrics.pageHeight - latestMetrics.viewportHeight);
    if (actualY >= bottom - 1) return { completed: true };
  }
  const nextTargetY = Math.min(actualY + latestMetrics.viewportHeight, bottom);
  if (nextTargetY <= actualY + 1) {
    throw new Error("ページのスクロール位置を更新できませんでした。表示範囲か選択範囲で撮影してください。");
  }
  return { completed: false, targetY: nextTargetY };
}

async function captureScrollableArea(tab, options, job, state) {
  const page = await executeInTab(tab.id, readPageInfo);
  await selectCaptureScrollableArea(tab, job, state);
  const metrics = await executeInTab(tab.id, readScrollableAreaMetrics, [job.id]);
  validateScrollableAreaBounds(metrics, page);
  await executeInTab(tab.id, suppressScrollableAreaHover, [job.id]);
  state.meta = { ...page, mode: "scroll-area", scrollArea: metrics };
  options.fileStem = makeFileStem(state.meta, options.filenamePattern);
  await offscreenMessage({ type: "begin", meta: state.meta, options });
  job.offscreenStarted = true;
  await captureScrollableAreaFrames(tab, job, state, page);
}

async function selectCaptureScrollableArea(tab, job, state) {
  reportCapture(job, { phase: "selecting", selectionKind: "scroll-area", cancellable: true });
  throwIfCancelled(job);
  const selected = await executeInTab(tab.id, selectScrollableArea, [job.id, {
    label: kiriT("スクロール領域を選択"),
    instruction: kiriT("カーソルを合わせてクリックし、スクロール領域を選びます。↑キーで親の領域を選べます。"),
    choose: kiriT("この領域を撮影"), cancel: kiriT("キャンセル"), empty: kiriT("縦スクロールできる領域を選んでください。")
  }]);
  if (!selected) throw createCaptureCancelled("スクロール領域の選択をキャンセルしました。");
  state.scrollAreaSelected = true;
  reportCapture(job, { phase: "preparing", selectionKind: null, cancellable: true });
}

function validateScrollableAreaBounds(area, page, missingMessage = "スクロール領域がページ内から見つかりません。もう一度選択してください。") {
  if (!area) throw new Error(missingMessage);
  const outsideViewport = area.rect.x < 0 || area.rect.y < 0 ||
    area.rect.x + area.rect.width > page.viewportWidth + 1 ||
    area.rect.y + area.rect.height > page.viewportHeight + 1;
  if (outsideViewport) throw new Error("スクロール領域全体が画面に表示されるようにしてから撮影してください。");
}

async function captureScrollableAreaFrames(tab, job, state, page) {
  let targetY = 0;
  let completed = false;
  for (let index = 0; index < state.maxFrames; index += 1) {
    const result = await captureScrollableAreaFrame(tab, job, state, page, index, targetY);
    if (result.completed) {
      completed = true;
      break;
    }
    targetY = result.targetY;
  }
  if (!completed) {
    await offscreenMessage({ type: "trim-to-captured" });
    state.reachedLimit = true;
  }
}

async function captureScrollableAreaFrame(tab, job, state, page, index, targetY) {
  throwIfCancelled(job);
  reportCapture(job, { phase: "capturing", currentFrame: index + 1 });
  await assertTabStillActive(tab.id, tab.windowId);
  const frameInfo = await executeInTab(tab.id, scrollScrollableArea, [job.id, targetY]);
  throwIfCancelled(job);
  validateScrollableAreaBounds(frameInfo, page, "スクロール領域全体が画面に表示されるようにしてから撮影してください。");
  const actualY = frameInfo.scrollTop;
  if (!Number.isFinite(actualY) || (index > 0 && actualY <= state.previousY + 1)) {
    throw new Error("スクロール領域を縦にスクロールできませんでした。");
  }
  state.previousY = actualY;
  await delay(Math.max(state.scrollWaitMs, state.lastFrameCapturedAt ? 510 - (Date.now() - state.lastFrameCapturedAt) : 0, 0));
  throwIfCancelled(job);
  await assertTabStillActive(tab.id, tab.windowId);
  const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  state.lastFrameCapturedAt = Date.now();
  await assertTabStillActive(tab.id, tab.windowId);
  throwIfCancelled(job);
  const metrics = await executeInTab(tab.id, readScrollableAreaMetrics, [job.id]);
  if (!metrics) throw new Error("スクロール領域がページ内から見つかりません。もう一度選択してください。");
  await offscreenMessage({ type: "add-frame", image, scrollY: actualY, pageHeight: frameInfo.scrollHeight, currentPageHeight: metrics.scrollHeight, crop: frameInfo.rect });
  if (index === 0) await executeInTab(tab.id, hideScrollableAreaSticky, [job.id]);
  throwIfCancelled(job);
  let latest = metrics;
  let bottom = Math.max(0, latest.scrollHeight - latest.clientHeight);
  if (actualY >= bottom - 1) {
    latest = await executeInTab(tab.id, waitForScrollableAreaStable, [job.id]);
    throwIfCancelled(job);
    bottom = Math.max(0, latest.scrollHeight - latest.clientHeight);
    if (actualY >= bottom - 1) return { completed: true };
  }
  const nextTargetY = Math.min(actualY + latest.clientHeight, bottom);
  if (nextTargetY <= actualY + 1) throw new Error("スクロール領域を縦にスクロールできませんでした。");
  return { completed: false, targetY: nextTargetY };
}

async function captureViewportOrRegion(tab, options, job, state) {
  const page = await executeInTab(tab.id, readPageInfo);
  state.meta = { ...page, mode: options.mode };
  if (options.mode === "region") {
    const region = await executeInTab(tab.id, selectRegion, [kiriT("ドラッグして範囲を選択 · Escでキャンセル")]);
    if (!region) throw createCaptureCancelled("範囲選択をキャンセルしました。");
    state.meta.region = region;
  }
  options.fileStem = makeFileStem(state.meta, options.filenamePattern);
  await offscreenMessage({ type: "begin", meta: state.meta, options });
  job.offscreenStarted = true;
  await assertTabStillActive(tab.id, tab.windowId);
  const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  await assertTabStillActive(tab.id, tab.windowId);
  await offscreenMessage({ type: "add-frame", image, scrollY: 0 });
}

async function finalizeCapture(options, job, state) {
  throwIfCancelled(job);
  reportCapture(job, { phase: "processing" });
  if (options.preview !== false) {
    const previewResult = await processCapturePreview(options, job, state);
    if (previewResult?.retry) return previewResult;
  }
  throwIfCancelled(job);
  const artifact = await offscreenMessage({ type: "finish" });
  job.offscreenStarted = false;
  if (job.cancelRequested) {
    await offscreenMessage({ type: "release", urls: artifact.files.map((file) => file.url) }).catch(() => undefined);
    throwIfCancelled(job);
  }
  reportCapture(job, { phase: "saving", cancellable: false });
  const copied = await copyCaptureArtifact(options, artifact);
  const saved = await saveCaptureFiles(options, artifact.files);
  return {
    message: successMessage(options, saved, copied) +
      (state.paginationWarning ? " · " + state.paginationWarning : "") +
      (state.reachedLimit ? " · " + kiriT("$1画面の上限まで撮影しました。続きは含まれていません。", state.maxFrames) : "")
  };
}

async function processCapturePreview(options, job, state) {
  const preview = await offscreenMessage({ type: "preview" });
  try {
    throwIfCancelled(job);
    if (options.mode === "pagination") state.meta.paginationWarning = state.paginationWarning;
    const edited = await openCaptureEditor(job, options, preview.url, state.meta, preview);
    throwIfCancelled(job);
    if (edited.retry) {
      await offscreenMessage({ type: "discard" });
      job.offscreenStarted = false;
      return { retry: true, tab: edited.tab };
    }
    if (!edited.unchanged) await offscreenMessage({ type: "replace-image", url: edited.url });
  } finally {
    const urls = preview.pages ? preview.pages.map((page) => page.url) : [preview.url];
    await offscreenMessage({ type: "release", urls }).catch(() => undefined);
  }
}

async function copyCaptureArtifact(options, artifact) {
  if (options.destination !== "copy" && options.destination !== "both") return false;
  await offscreenMessage({ type: "copy", clipboard: artifact.clipboard });
  return true;
}

async function saveCaptureFiles(options, files) {
  if (options.destination !== "save" && options.destination !== "both") {
    await offscreenMessage({ type: "release", urls: files.map((file) => file.url) });
    return 0;
  }
  const folderPath = normalizeFolder(options.folder);
  return files.reduce((saving, file) => saving.then(async (saved) => {
    const filename = [folderPath, `${options.fileStem}${file.suffix}`].filter(Boolean).join("/");
    const downloadId = await chrome.downloads.download({ url: file.url, filename, conflictAction: "uniquify", saveAs: false });
    releaseUrlAfterDownload(downloadId, file.url);
    return saved + 1;
  }), Promise.resolve(0));
}
async function openCaptureEditor(job, options, previewUrl, meta, preview = null) {
  const choice = new Promise((resolve) => { job.editorResolve = resolve; });
  job.previewUrl = previewUrl;
  job.previewPages = buildPreviewPages(options, preview);
  job.editorOptions = { ...options };
  job.editorMeta = meta;
  job.editorCommitted = false;
  reportCapture(job, { phase: "editing", cancellable: true });
  const url = `${chrome.runtime.getURL(options.mode === "pagination" ? "pagination-preview.html" : "editor.html")}?job=${encodeURIComponent(job.id)}`;
  let sourceTab;
  try { sourceTab = await chrome.tabs.get(job.tabId); } catch (_) { /* The source tab may have been closed. */ }
  const editorTab = await chrome.tabs.create({ url, ...(sourceTab?.id && sourceTab.windowId != null ? { windowId: sourceTab.windowId, openerTabId: sourceTab.id } : {}) });
  job.editorTabId = editorTab.id;
  reportCapture(job);
  if (job.cancelRequested) job.editorResolve(null);
  const result = await choice;
  job.editorResolve = null;
  throwIfCancelled(job);
  if (!result?.url && !result?.retry && !result?.unchanged) throw new Error("編集した画像を受け取れませんでした。");
  return result;
}

function buildPreviewPages(options, preview) {
  if (options.mode !== "pagination") return null;
  if (preview.pages) return { pages: preview.pages, count: preview.pages.length };
  return { width: preview.width, height: preview.height, pageHeight: preview.pageHeight, count: Math.ceil(preview.height / preview.pageHeight) };
}

async function exportRecoveredDraft(id, url) {
  if (activeCapture) throw new Error("別の撮影が進行中です。完了またはキャンセルを待ってください。");
  const job = { id: `draft-${id}`, active: true, mode: null, phase: "processing", currentFrame: 0, cancellable: false, cancelRequested: false, revision: 0 };
  activeCapture = job; reportCapture(job);
  try {
    await (draftUpdateQueues.get(id) || Promise.resolve()).catch(() => undefined);
    const draft = await draftStore.get(id);
    if (!draft || draft.expiresAt <= Date.now()) throw new Error("編集する画像が見つかりません。");
    job.mode = draft.meta.mode;
    const options = draft.options;
    await offscreenMessage({ type: "begin", meta: draft.meta, options, scale: draft.scale });
    await offscreenMessage({ type: "replace-image", url });
    const artifact = await offscreenMessage({ type: "finish" });
    const copied = await copyCaptureArtifact(options, artifact);
    const saved = await saveRecoveredDraftFiles(options, artifact.files);
    return successMessage(options, saved, copied);
  } catch (error) {
    await offscreenMessage({ type: "discard" }).catch(() => undefined);
    throw error;
  } finally { reportCapture(job, { active: false, cancellable: false }); if (activeCapture === job) activeCapture = null; }
}

async function saveRecoveredDraftFiles(options, files) {
  if (options.destination !== "save" && options.destination !== "both") {
    await offscreenMessage({ type: "release", urls: files.map((file) => file.url) });
    return 0;
  }
  const folder = normalizeFolder(options.folder);
  return files.reduce((saving, file) => saving.then(async (saved) => {
    const filename = [folder, `${options.fileStem}${file.suffix}`].filter(Boolean).join("/");
    const downloadId = await chrome.downloads.download({ url: file.url, filename, conflictAction: "uniquify", saveAs: false });
    releaseUrlAfterDownload(downloadId, file.url);
    return saved + 1;
  }), Promise.resolve(0));
}

async function runQuickCapture(tab, modeOverride) {
  if (!tab?.id) return;
  let captureStarted = false;
  try {
    const { captureSettings, siteCaptureSettings } = await chrome.storage.local.get(["captureSettings", "siteCaptureSettings"]);
    let host = null;
    try { const parsed = new URL(tab.url); if (["http:", "https:"].includes(parsed.protocol)) host = parsed.hostname.toLowerCase(); } catch (_) { /* Chrome may omit or provide a non-URL tab address. */ }
    const siteSettings = host && siteCaptureSettings && Object.hasOwn(siteCaptureSettings, host) ? siteCaptureSettings[host] : null;
    const options = {
      mode: "viewport",
      format: "png",
      destination: "save",
      filenamePattern: "title-date",
      splitOutput: false,
      folder: "Screenshots",
      removeAds: false,
      manualHide: false,
      preview: true,
      ...captureSettings,
      ...siteSettings
    };
    if (modeOverride) options.mode = modeOverride;
    captureStarted = true;
    const result = await startCapture(options, tab);
    setQuickFeedback(tab.id, "✓", `KiriTori: ${result.message}`, "#188038");
  } catch (error) {
    if (!captureStarted) await rememberFailure(error, { mode: modeOverride, phase: "preparing" });
    if (activeCapture?.tabId === tab.id) return;
    showQuickCaptureFailure(tab.id, error);
  }
}

function showQuickCaptureFailure(tabId, error) {
  if (error?.name === "CaptureCancelled") {
    setQuickFeedback(tabId, "−", kiriT("KiriTori: 撮影をキャンセルしました"), "#5f6368", 5000);
    return;
  }
  const reason = kiriT(describeFailure(error).reason);
  const title = `KiriTori: ${reason} ${kiriT("アイコンを開くと詳細を確認できます。")}`;
  setQuickFeedback(tabId, "!", title, "#d93025", 30000);
}

function setQuickFeedback(tabId, badge, title, color, duration = 5000) {
  if (badgeTimers.has(tabId)) clearTimeout(badgeTimers.get(tabId));
  chrome.action.setBadgeBackgroundColor({ color, tabId });
  chrome.action.setBadgeText({ text: badge, tabId });
  chrome.action.setTitle({ title, tabId });
  const timer = setTimeout(() => {
    chrome.action.setBadgeText({ text: "", tabId });
    chrome.action.setTitle({ title: "KiriTori", tabId });
    badgeTimers.delete(tabId);
  }, duration);
  badgeTimers.set(tabId, timer);
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length) return;

  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD", "BLOBS"],
      justification: "画面画像の結合・形式変換と、ユーザーが選んだ場合のクリップボード書き込みに使います。"
    });
  }
  try {
    await offscreenCreation;
  } finally {
    offscreenCreation = undefined;
  }
}

async function offscreenMessage(message) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: "offscreen", ...message });
  if (!response?.ok) throw new Error(response?.error || "画像処理に失敗しました。");
  return response.result;
}

async function executeInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return results[0]?.result;
}

async function assertTabStillActive(tabId, windowId) {
  const tabs = await chrome.tabs.query({ active: true, windowId });
  if (tabs[0]?.id !== tabId) {
    throw new Error("撮影中にタブが切り替わったため、処理を中止しました。");
  }
}

async function capturePaginatedScroll(tab, job, scope, page, maxFrames, scrollWaitMs, timing) {
  try {
    const prepared = await preparePaginatedScroll(tab, job, scope, page);
    await offscreenMessage({ type: "begin-pagination-page", meta: { ...prepared, mode: scope } });
    const completed = await capturePaginatedScrollFrames(tab, job, scope, page, maxFrames, scrollWaitMs, timing);
    await offscreenMessage({ type: "trim-to-captured" });
    await offscreenMessage({ type: "end-pagination-page" });
    return completed;
  } finally {
    const restore = scope === "full" ? restoreFullPage : restoreScrollableArea;
    const args = scope === "full" ? [] : [job.id];
    await executeInTab(tab.id, restore, args).catch(() => undefined);
  }
}

async function preparePaginatedScroll(tab, job, scope, page) {
  if (scope === "full") return executeInTab(tab.id, prepareFullPage);
  const area = await executeInTab(tab.id, readScrollableAreaMetrics, [job.id]);
  validateScrollableAreaBounds(area, page);
  await executeInTab(tab.id, suppressScrollableAreaHover, [job.id]);
  return { ...page, scrollArea: area };
}

async function capturePaginatedScrollFrames(tab, job, scope, page, maxFrames, scrollWaitMs, timing) {
  let targetY = 0;
  let previousY = -1;
  for (let index = 0; index < maxFrames; index += 1) {
    const result = await capturePaginatedScrollFrame(tab, job, scope, page, scrollWaitMs, timing, { index, targetY, previousY });
    if (result.completed) return true;
    targetY = result.targetY;
    previousY = result.actualY;
  }
  return false;
}

async function capturePaginatedScrollFrame(tab, job, scope, page, scrollWaitMs, timing, framePosition) {
  const { index, targetY, previousY } = framePosition;
  throwIfCancelled(job);
  await assertTabStillActive(tab.id, tab.windowId);
  const fullPage = scope === "full";
  const scroll = fullPage ? scrollFullPage : scrollScrollableArea;
  const scrollArgs = fullPage ? [targetY] : [job.id, targetY];
  const frame = await executeInTab(tab.id, scroll, scrollArgs);
  const actualY = fullPage ? frame?.scrollY : frame?.scrollTop;
  validatePaginatedScrollPosition(actualY, previousY, index);
  if (!fullPage) validateScrollableAreaBounds(frame, page, "スクロール領域全体が画面に表示されるようにしてから撮影してください。");
  await waitForCaptureInterval(scrollWaitMs, timing);
  throwIfCancelled(job);
  await assertTabStillActive(tab.id, tab.windowId);
  const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  timing.last = Date.now();
  await assertTabStillActive(tab.id, tab.windowId);
  throwIfCancelled(job);
  const metricsReader = fullPage ? readFullPageMetrics : readScrollableAreaMetrics;
  const metricsArgs = fullPage ? [] : [job.id];
  const metrics = await executeInTab(tab.id, metricsReader, metricsArgs);
  if (!metrics) throw new Error("スクロール領域がページ内から見つかりません。もう一度選択してください。");
  await addPaginatedScrollFrame(job, scope, image, frame, metrics, actualY);
  if (scope === "scroll-area" && index === 0) await executeInTab(tab.id, hideScrollableAreaSticky, [job.id]);
  throwIfCancelled(job);
  return updatePaginatedScrollTarget(tab, job, scope, actualY, metrics);
}

function validatePaginatedScrollPosition(actualY, previousY, index) {
  if (Number.isFinite(actualY) && (index === 0 || actualY > previousY + 1)) return;
  throw new Error("ページを縦にスクロールできませんでした。表示範囲か選択範囲で撮影してください。");
}

async function waitForCaptureInterval(scrollWaitMs, timing) {
  const minimumInterval = timing.last ? 510 - (Date.now() - timing.last) : 0;
  await delay(Math.max(scrollWaitMs, minimumInterval, 0));
}

async function addPaginatedScrollFrame(job, scope, image, frame, metrics, actualY) {
  const fullPage = scope === "full";
  await offscreenMessage({
    type: "add-frame",
    image,
    scrollY: actualY,
    pageHeight: fullPage ? frame.pageHeight : frame.scrollHeight,
    currentPageHeight: fullPage ? metrics.pageHeight : metrics.scrollHeight,
    ...(fullPage ? {} : { crop: frame.rect })
  });
}

async function updatePaginatedScrollTarget(tab, job, scope, actualY, metrics) {
  let latest = metrics;
  let height = scope === "full" ? latest.pageHeight : latest.scrollHeight;
  let viewport = latest.viewportHeight || latest.clientHeight;
  if (actualY >= Math.max(0, height - viewport) - 1) {
    const stableReader = scope === "full" ? waitForPageHeightStable : waitForScrollableAreaStable;
    const args = scope === "full" ? [] : [job.id];
    latest = await executeInTab(tab.id, stableReader, args);
    throwIfCancelled(job);
    if (!latest) throw new Error("スクロール領域がページ内から見つかりません。もう一度選択してください。");
    height = scope === "full" ? latest.pageHeight : latest.scrollHeight;
    viewport = latest.viewportHeight || latest.clientHeight;
    if (actualY >= Math.max(0, height - viewport) - 1) return { completed: true, actualY };
  }
  const targetY = Math.min(actualY + viewport, Math.max(0, height - viewport));
  if (targetY <= actualY + 1) {
    throw new Error("ページのスクロール位置を更新できませんでした。表示範囲か選択範囲で撮影してください。");
  }
  return { completed: false, targetY, actualY };
}
function normalizeFolder(value) {
  return String(value || "")
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => part.replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim())
    .filter(Boolean)
    .join("/");
}

function trimFilenameEnding(value) {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "." || value[end - 1] === " ")) end -= 1;
  return value.slice(0, end);
}

function makeFileStem(meta, pattern = "title-date", date = new Date()) {
  const sanitize = (value, maxBytes, fallback) => {
    const cleaned = trimFilenameEnding(String(value || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim());
    const encoder = new TextEncoder();
    let result = "";
    for (const character of cleaned) {
      if (encoder.encode(result + character).length > maxBytes) break;
      result += character;
    }
    return trimFilenameEnding(result) || fallback;
  };
  let host = "site";
  try { host = new URL(meta.url).hostname || host; } catch (_) { /* The page URL may be missing or malformed. */ }
  const title = sanitize(meta.title, 120, "screenshot");
  const site = sanitize(host, 55, "site");
  const two = (value) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}_${two(date.getHours())}-${two(date.getMinutes())}-${two(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, "0")}`;
  if (pattern === "date-site-title") return `${stamp}_${site}_${title}`;
  if (pattern === "site-date-title") return `${site}_${stamp}_${title}`;
  return `${title}_${stamp}`;
}

function releaseUrlAfterDownload(downloadId, url) {
  const listener = (delta) => {
    if (delta.id !== downloadId) return;
    const state = delta.state?.current;
    if (state !== "complete" && state !== "interrupted") return;
    chrome.downloads.onChanged.removeListener(listener);
    offscreenMessage({ type: "release", urls: [url] }).catch(() => undefined);
  };
  chrome.downloads.onChanged.addListener(listener);
}

function successMessage(options, saved, copied) {
  const actions = [];
  if (saved) actions.push(kiriT("$1件をDownloads配下に保存しました", saved));
  if (copied) actions.push(kiriT("クリップボードにコピーしました"));
  return actions.join(" · ") || kiriT("出力しました。");
}

function describeFailure(error, phase) {
  const message = String(error?.message || "");
  if (/スクロール領域が長すぎ/.test(message)) {
    return { reason: "スクロール領域が長すぎて一度に撮影できません。", advice: "撮影範囲を小さくするか、ページ全体・表示中の範囲で分けて撮影してください。" };
  }
  if (/スクロール領域全体が画面に表示/.test(message)) {
    return { reason: "選んだスクロール領域が画面内に収まっていません。", advice: "ページをスクロールして領域全体を表示してから、もう一度選択してください。" };
  }
  if (/スクロール領域を縦にスクロール/.test(message)) {
    return { reason: "選んだ領域を縦にスクロールできませんでした。", advice: "縦にスクロールできる表や領域を選び直してください。" };
  }
  if (/スクロール領域がページ内から見つかりません/.test(message)) {
    return { reason: "撮影中にスクロール領域が見つからなくなりました。", advice: "ページを開いたまま、もう一度撮影してください。" };
  }
  if (/ページが長すぎ|ページ画像が大きすぎ|編集画像が大きすぎ/i.test(message)) {
    return { reason: "ページまたは画像が大きすぎます。", advice: "表示中の範囲や選択範囲で分けて撮影してください。画像サイズの上限は8,000万画素です。" };
  }
  if (/タブが切り替わった/i.test(message)) {
    return { reason: "撮影中にタブが切り替わりました。", advice: "撮影するタブを開いたまま、もう一度実行してください。" };
  }
  if (/別の撮影が進行中/i.test(message)) {
    return { reason: "別の撮影が進行中です。", advice: "実行中の撮影を完了するかキャンセルしてから、もう一度実行してください。" };
  }
  if (/スクロールできません|スクロール位置を更新できません/i.test(message)) {
    return { reason: "ページをスクロールできませんでした。", advice: "表示中の範囲か選択範囲で撮影してください。" };
  }
  if (/Cannot access|cannot be scripted|extensions gallery|Cannot be scripted/i.test(message)) {
    return { reason: "このページにはアクセスできません。", advice: "Chromeの内部ページやChromeウェブストア以外のWebページでお試しください。" };
  }
  if (/No tab with id|tab was closed|タブが見つかりません/i.test(message)) {
    return { reason: "撮影するタブが見つかりません。", advice: "ページを開き直して撮影してください。" };
  }
  if (/クリップボード|clipboard/i.test(message)) {
    return { reason: "クリップボードにコピーできませんでした。", advice: "出力先を「ファイルに保存」に変更してお試しください。" };
  }
  if (phase === "saving") {
    return { reason: "画像の出力に失敗しました。", advice: "Chromeのダウンロード設定と保存先を確認し、もう一度お試しください。コピーや一部のファイルが既に出力された場合があります。" };
  }
  return { reason: "撮影処理に失敗しました。", advice: "ページを再読み込みして再度お試しください。続く場合は表示中の範囲で撮影してください。" };
}

async function rememberFailure(error, context = {}) {
  const details = describeFailure(error, context.phase);
  const failure = {
    time: new Date().toISOString(),
    mode: ["viewport", "region", "full", "scroll-area", "pagination"].includes(context.mode) ? context.mode : null,
    phase: ["preparing", "countdown", "selecting", "capturing", "processing", "editing", "saving"].includes(context.phase) ? context.phase : null,
    currentFrame: Number.isInteger(context.currentFrame) && context.currentFrame > 0 ? context.currentFrame : 0,
    ...details
  };
  failureHistoryWrite = failureHistoryWrite.catch(() => undefined).then(async () => {
    const data = await chrome.storage.local.get(failureHistoryKey);
    const previous = Array.isArray(data[failureHistoryKey]) ? data[failureHistoryKey] : [];
    await chrome.storage.local.set({ [failureHistoryKey]: [failure, ...previous].slice(0, 10) });
    chrome.runtime.sendMessage({ type: "capture:failures:changed" }).catch(() => undefined);
  });
  await failureHistoryWrite.catch(() => undefined);
}

function explainError(error) {
  const message = error?.message || "撮影処理に失敗しました。";
  if (/Cannot access|cannot be scripted|The extensions gallery cannot be scripted/i.test(message)) {
    return kiriT("このページでは撮影できません。通常のWebページでお試しください。");
  }
  if (message.startsWith("クリップボードへのコピーに失敗しました")) {
    const details = describeFailure(error);
    return `${kiriT(details.reason)} ${kiriT(details.advice)}`;
  }
  if (/[ぁ-んァ-ン一-龯]/.test(message)) return kiriT(message);
  const details = describeFailure(error);
  return `${kiriT(details.reason)} ${kiriT(details.advice)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
