import "./i18n.js";
import { draftStore } from "./draft-store.js";

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
    const shouldContinue = await capturePaginationPage(tab, job, state, target, timing, seen, index, limit, waitMs);
    if (!shouldContinue) return true;
  }
  return false;
}

async function capturePaginationPage(tab, job, state, target, timing, seen, index, limit, waitMs) {
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
  const area = await selectCaptureScrollableArea(tab, job, state);
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

// Executed in the page's isolated world. The overlay never receives pointer input.
async function updateCountdownOverlay(jobId, remaining, label) {
  const key = "__kiriToriCountdown";
  let state = globalThis[key];
  if (state && state.jobId !== jobId) {
    clearTimeout(state.timeout);
    state.host.remove();
    delete globalThis[key];
    state = null;
  }
  if (!remaining) {
    if (state) {
      clearTimeout(state.timeout);
      state.host.remove();
      delete globalThis[key];
      // Give Chrome a chance to repaint before capturing the page.
      await new Promise(resolve => {
        let finished = false;
        const done = () => { if (!finished) { finished = true; clearTimeout(timer); resolve(); } };
        const timer = setTimeout(done, 120);
        requestAnimationFrame(() => requestAnimationFrame(done));
      });
    }
    return;
  }
  if (!state) {
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "closed" });
    const badge = document.createElement("div");
    badge.style.cssText = "all:initial;display:flex;align-items:center;justify-content:center;width:88px;height:88px;border:3px solid white;border-radius:50%;background:rgba(26,115,232,.94);box-shadow:0 4px 20px rgba(0,0,0,.35);color:white;font:700 48px/1 system-ui,sans-serif;pointer-events:none;";
    badge.setAttribute("role", "status");
    badge.setAttribute("aria-live", "polite");
    shadow.appendChild(badge);
    (document.documentElement || document.body).appendChild(host);
    state = { jobId, host, badge, timeout: null };
    globalThis[key] = state;
  }
  state.badge.textContent = String(remaining);
  state.badge.setAttribute("aria-label", label);
  clearTimeout(state.timeout);
  // If the worker or page is interrupted, do not leave the badge on the page.
  state.timeout = setTimeout(() => {
    state.host.remove();
    if (globalThis[key] === state) delete globalThis[key];
  }, 1800);
}

function selectPaginationButton(jobId, instruction, cancelText) {
  return new Promise(resolve => {
    const banner = document.createElement("div");
    banner.style.cssText = "all:initial;position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#174ea6;color:white;padding:12px 18px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 2px 12px #0006;pointer-events:none;";
    banner.textContent = `${instruction} · ${cancelText}`;
    document.documentElement.appendChild(banner);
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
      banner.remove();
      if (globalThis.__kiritoriPaginationPicker?.jobId === jobId) delete globalThis.__kiritoriPaginationPicker;
      if (!value) { resolve(value); return; }
      // Wait for the selection banner to disappear from the rendered page before capture.
      let finished = false;
      const finishAfterPaint = () => {
        if (finished) return;
        finished = true;
        clearTimeout(fallback);
        resolve(value);
      };
      const fallback = setTimeout(finishAfterPaint, 300);
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(finishAfterPaint, 50)));
    };
    const onKey = event => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); finish(null); } };
    const onMouseDown = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const onPointerDown = event => { event.stopImmediatePropagation(); };
    const onClick = (event) => {
      event.preventDefault(); event.stopImmediatePropagation();
      const element = findInteractiveTarget(event.target);
      if (!element) return;
      finish(describePaginationTarget(element));
    };

    function findInteractiveTarget(target) {
      if (!(target instanceof Element)) return null;
      return target.closest('button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"], [tabindex][aria-label]');
    }

    function describePaginationTarget(element) {
      return {
        selector: buildElementSelector(element),
        fallback: findUniqueAttributeSelector(element),
        tag: element.localName,
        label: readPaginationLabel(element)
      };
    }

    function buildElementSelector(element) {
      const parts = [];
      for (let node = element; node?.nodeType === 1; node = node.parentElement) {
        if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
        let position = 1;
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.tagName === node.tagName) position++;
        parts.unshift(`${node.localName}:nth-of-type(${position})`);
      }
      return parts.join(" > ");
    }

    function findUniqueAttributeSelector(element) {
      for (const name of ["aria-label", "data-tooltip", "title"]) {
        const value = name === "data-tooltip" ? element.dataset.tooltip : element.getAttribute(name);
        if (!value) continue;
        const candidate = `${element.localName}[${name}=${JSON.stringify(value)}]`;
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      }
      return null;
    }

    function readPaginationLabel(element) {
      return (element.getAttribute("aria-label") || element.dataset.tooltip || element.getAttribute("title") || element.textContent || element.value || "").trim().slice(0, 120);
    }
    globalThis.__kiritoriPaginationPicker = { jobId, cancel: () => finish(null) };
    document.addEventListener("click", onClick, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
  });
}

function cancelPaginationSelection(jobId) {
  if (globalThis.__kiritoriPaginationPicker?.jobId === jobId) void globalThis.__kiritoriPaginationPicker.cancel();
}

function paginationSnapshot() {
  const root = document.body;
  const text = (root?.innerText || "").slice(0, 200000);
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  return { signature: `${location.href}|${text.length}|${hash >>> 0}`, ready: document.readyState === "complete" };
}

function clickPaginationButton(button) {
  const element = findPaginationTarget(button);
  if (!element) return "missing";
  if (isDisabledPaginationTarget(element)) return "end";
  if (!hasSafePaginationLink(element)) return "missing";
  setTimeout(() => dispatchPaginationClick(element), 0);
  return "clicked";

  function findPaginationTarget(target) {
    try {
      const direct = document.querySelector(target.selector);
      if (matchesTarget(direct, target)) return direct;
      if (!target.fallback) return null;
      const candidates = document.querySelectorAll(target.fallback);
      const fallback = candidates.length === 1 ? candidates[0] : null;
      return matchesTarget(fallback, target) ? fallback : null;
    } catch (_) {
      // Page-provided selectors may become invalid after client-side navigation.
      return null;
    }
  }

  function matchesTarget(element, target) {
    if (!element || element.localName !== target.tag) return false;
    const label = (element.getAttribute("aria-label") || element.dataset.tooltip || element.getAttribute("title") || element.textContent || element.value || "").trim().slice(0, 120);
    return label === target.label;
  }

  function isDisabledPaginationTarget(target) {
    return target.matches(":disabled, [disabled], [aria-disabled=true], .disabled") ||
      target.closest('[aria-disabled="true"], [inert], .disabled') ||
      !target.getClientRects().length ||
      getComputedStyle(target).visibility !== "visible";
  }

  function hasSafePaginationLink(target) {
    if (target.localName !== "a") return true;
    if (target.target && target.target.toLowerCase() !== "_self") return false;
    const href = target.getAttribute("href");
    if (!href) return true;
    try {
      const url = new URL(href, location.href);
      return ["http:", "https:"].includes(url.protocol) && url.origin === location.origin;
    } catch (_) {
      // Ignore malformed page-provided href values.
      return false;
    }
  }

  function dispatchPaginationClick(target) {
    if (!target.isConnected) return;
    const rect = target.getBoundingClientRect();
    const eventOptions = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
    };
    if (typeof PointerEvent === "function") {
      target.dispatchEvent(new PointerEvent("pointerdown", { ...eventOptions, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
    }
    if (!target.isConnected) return;
    target.dispatchEvent(new MouseEvent("mousedown", { ...eventOptions, buttons: 1, detail: 1 }));
    if (!target.isConnected) return;
    if (typeof PointerEvent === "function") {
      target.dispatchEvent(new PointerEvent("pointerup", { ...eventOptions, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
    }
    target.dispatchEvent(new MouseEvent("mouseup", { ...eventOptions, buttons: 0, detail: 1 }));
    if (target.isConnected) target.dispatchEvent(new MouseEvent("click", { ...eventOptions, buttons: 0, detail: 1 }));
  }
}
async function assertTabStillActive(tabId, windowId) {
  const tabs = await chrome.tabs.query({ active: true, windowId });
  if (tabs[0]?.id !== tabId) {
    throw new Error("撮影中にタブが切り替わったため、処理を中止しました。");
  }
}

function readPageInfo() {
  return {
    title: document.title || "screenshot",
    url: location.href,
    viewportWidth: document.documentElement.clientWidth,
    viewportHeight: document.documentElement.clientHeight
  };
}

async function selectElementsToHide(jobId, labels) {
  if (window.__kiritoriManualHide?.restore) window.__kiritoriManualHide.restore();
  if (window.__kiritoriManualCancelJob === jobId) return { cancelled: true, count: 0 };

  const host = document.createElement("div");
  host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
  const shadow = host.attachShadow({ mode: "closed" });
  const glass = document.createElement("div");
  const highlight = document.createElement("div");
  const bar = document.createElement("div");
  const instruction = document.createElement("span");
  const count = document.createElement("span");
  const undo = document.createElement("button");
  const cancel = document.createElement("button");
  const done = document.createElement("button");
  Object.assign(glass.style, { position: "fixed", inset: "0", cursor: "crosshair", pointerEvents: "auto", zIndex: "0" });
  Object.assign(highlight.style, { boxSizing: "border-box", position: "fixed", pointerEvents: "none", zIndex: "1", border: "3px solid #1a73e8", background: "rgba(26,115,232,.14)", display: "none" });
  Object.assign(bar.style, { boxSizing: "border-box", position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)", maxWidth: "calc(100vw - 24px)", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", flexWrap: "wrap", padding: "10px 12px", borderRadius: "10px", background: "#202124", color: "white", font: "13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif", boxShadow: "0 3px 14px #0005", pointerEvents: "auto", zIndex: "2" });
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", labels.label);
  instruction.textContent = labels.instruction;
  count.textContent = labels.count.replace("__COUNT__", "0");
  for (const button of [undo, cancel, done]) {
    button.type = "button";
    Object.assign(button.style, { appearance: "none", border: "1px solid #9ca9bc", borderRadius: "6px", padding: "6px 10px", background: "white", color: "#202124", font: "inherit", cursor: "pointer" });
  }
  undo.textContent = labels.undo; undo.disabled = true; undo.style.opacity = ".5";
  cancel.textContent = labels.cancel;
  done.textContent = labels.done;
  Object.assign(done.style, { background: "#8ab4f8", borderColor: "#8ab4f8", color: "#102a50", fontWeight: "700" });
  bar.append(instruction, count, undo, cancel, done);
  shadow.append(glass, highlight, bar);
  const style = document.createElement("style");
  style.textContent = `[data-kiritori-manual-hide="${jobId}"]{display:none!important}`;
  const state = { jobId, records: [], host, style, settled: false, port: null, timer: null };
  let hovered = null;
  let parentHistory = [];
  let resolveSelection;
  const selection = new Promise((resolve) => { resolveSelection = resolve; });

  function restoreRecord(record) {
    const element = record.element;
    if (element.style.getPropertyValue("display") === "none" && element.style.getPropertyPriority("display") === "important") {
      if (record.display) element.style.setProperty("display", record.display, record.priority);
      else element.style.removeProperty("display");
      if (!record.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    if (element.dataset.kiritoriManualHide === jobId) {
      if (record.hadMarker) element.dataset.kiritoriManualHide = record.marker;
      else delete element.dataset.kiritoriManualHide;
    }
  }

  function updateCount() {
    count.textContent = labels.count.replace("__COUNT__", String(state.records.length));
    undo.disabled = state.records.length === 0;
    undo.style.opacity = undo.disabled ? ".5" : "1";
  }

  function showHighlight(element) {
    hovered = element;
    if (!element) { highlight.style.display = "none"; return; }
    const rect = element.getBoundingClientRect();
    Object.assign(highlight.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  }

  function elementAt(x, y) {
    glass.style.pointerEvents = "none";
    const element = document.elementFromPoint(x, y);
    glass.style.pointerEvents = "auto";
    if (!element || element === document.documentElement || element === document.body || element === host) return null;
    return element;
  }

  async function finish(cancelled) {
    if (state.settled) return;
    state.settled = true;
    clearInterval(state.timer);
    try { state.port?.disconnect(); } catch (_) {}
    window.removeEventListener("keydown", onKey, true);
    host.remove();
    await new Promise((resolve) => {
      let complete = false;
      const doneWaiting = () => { if (!complete) { complete = true; resolve(); } };
      setTimeout(doneWaiting, 150);
      requestAnimationFrame(() => requestAnimationFrame(doneWaiting));
    });
    resolveSelection({ cancelled, count: state.records.length });
  }

  function onKey(event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void finish(true); }
    else if (event.key === "Enter" && !shadow.activeElement) { event.preventDefault(); event.stopPropagation(); void finish(false); }
    else if (event.key === "ArrowUp" && hovered?.parentElement && hovered.parentElement !== document.body && hovered.parentElement !== document.documentElement) {
      event.preventDefault(); event.stopPropagation(); parentHistory.push(hovered); showHighlight(hovered.parentElement);
    } else if (event.key === "ArrowDown" && parentHistory.length) {
      event.preventDefault(); event.stopPropagation(); showHighlight(parentHistory.pop());
    }
  }

  state.cancel = () => { void finish(true); };
  state.restore = () => {
    if (!state.settled) void finish(true);
    while (state.records.length) restoreRecord(state.records.pop());
    style.remove(); host.remove();
    if (window.__kiritoriManualHide === state) delete window.__kiritoriManualHide;
  };
  window.__kiritoriManualHide = state;
  document.documentElement.appendChild(style);
  document.documentElement.appendChild(host);
  window.addEventListener("keydown", onKey, true);

  glass.addEventListener("mousemove", (event) => {
    parentHistory = [];
    showHighlight(elementAt(event.clientX, event.clientY));
  });
  glass.addEventListener("click", (event) => {
    event.preventDefault(); event.stopPropagation();
    const element = hovered || elementAt(event.clientX, event.clientY);
    if (!element?.style) return;
    state.records.push({
      element,
      display: element.style.getPropertyValue("display"),
      priority: element.style.getPropertyPriority("display"),
      hadStyle: element.hasAttribute("style"),
      hadMarker: element.dataset.kiritoriManualHide !== undefined,
      marker: element.dataset.kiritoriManualHide
    });
    element.dataset.kiritoriManualHide = jobId;
    element.style.setProperty("display", "none", "important");
    parentHistory = [];
    showHighlight(null);
    updateCount();
  });
  glass.addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const scale = getWheelScale(event.deltaMode);
    window.scrollBy({ left: event.deltaX * scale, top: event.deltaY * scale, behavior: "instant" });
    parentHistory = []; showHighlight(null);
  }, { passive: false });
  undo.addEventListener("click", () => {
    if (state.records.length) {
      restoreRecord(state.records.pop());
    }
    updateCount();
  });
  done.addEventListener("click", () => { void finish(false); });
  cancel.addEventListener("click", () => { void finish(true); });

  try {
    state.port = chrome.runtime.connect({ name: "kiritori-selector" });
    state.port.onDisconnect.addListener(() => { if (!state.settled) state.restore(); });
    state.port.postMessage({ type: "hello", jobId });
    state.timer = setInterval(() => { try { state.port.postMessage({ type: "heartbeat" }); } catch (_) { state.restore(); } }, 20_000);
  } catch (_) {
    // A missing extension connection means the picker can no longer be controlled.
    state.restore();
  }

  if (window.__kiritoriManualCancelJob === jobId) void finish(true);
  return selection;
}

function cancelManualSelection(jobId) {
  window.__kiritoriManualCancelJob = jobId;
  if (window.__kiritoriManualHide?.jobId === jobId) void window.__kiritoriManualHide.cancel();
  if (window.__kiritoriScrollSelector?.jobId === jobId) void window.__kiritoriScrollSelector.cancel();
}

async function restoreStaleScrollAreaState() {
  await cancelStaleScrollAreaPicker();
  restoreAreaMarkers();
  restoreStickyMarkers();
  restoreInteractionStyles();
  restoreStaleCapture();

  async function cancelStaleScrollAreaPicker() {
    if (!window.__kiritoriScrollSelector?.cancel) return;
    window.__kiritoriScrollSelector.cancel();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function restoreAreaMarkers() {
    document.querySelectorAll("[data-kiritori-scroll-state]").forEach(restoreAreaMarker);
  }

  function restoreAreaMarker(element) {
    const saved = parseSavedMarker(element.dataset.kiritoriScrollState);
    if (!isKiritoriMarker(saved)) return;
    element.scrollTop = saved.originalTop;
    element.scrollLeft = saved.originalLeft;
    restoreInlineStyle(element, "scroll-behavior", "auto", saved.scrollBehavior, saved.scrollPriority, saved.hadStyle);
    restoreSavedMarker(element, "kiritoriScrollState", saved.previousMarker);
  }

  function restoreStickyMarkers() {
    document.querySelectorAll("[data-kiritori-scroll-sticky]").forEach(restoreStickyMarker);
  }

  function restoreStickyMarker(element) {
    const saved = parseSavedMarker(element.dataset.kiritoriScrollSticky);
    if (!isKiritoriMarker(saved)) return;
    restoreInlineStyle(element, "visibility", "hidden", saved.visibility, saved.visibilityPriority, saved.hadStyle);
    restoreSavedMarker(element, "kiritoriScrollSticky", saved.previousMarker);
  }

  function restoreInteractionStyles() {
    document.querySelectorAll("style[data-kiritori-scroll-interaction]").forEach((style) => {
      const saved = parseSavedMarker(style.dataset.kiritoriScrollInteraction);
      if (isKiritoriMarker(saved)) style.remove();
    });
  }

  function restoreStaleCapture() {
    const staleCapture = window.__kiritoriScrollCapture;
    if (!staleCapture) return;
    const element = staleCapture.element;
    if (element?.isConnected && !Object.hasOwn(element.dataset, "kiritoriScrollState")) {
      element.scrollTop = staleCapture.originalTop;
      element.scrollLeft = staleCapture.originalLeft;
      restoreInlineStyle(element, "scroll-behavior", "auto", staleCapture.scrollBehavior, staleCapture.scrollPriority, staleCapture.hadStyle);
    }
    delete window.__kiritoriScrollCapture;
  }

  function parseSavedMarker(value) {
    try {
      return JSON.parse(value || "null");
    } catch (_) {
      // Ignore malformed marker data left by a page or an interrupted capture.
      return null;
    }
  }

  function isKiritoriMarker(saved) {
    return saved?.owner === "kiritori" && saved.version === 1;
  }

  function restoreInlineStyle(element, property, currentValue, savedValue, savedPriority, hadStyle) {
    if (element.style.getPropertyValue(property) !== currentValue || element.style.getPropertyPriority(property) !== "important") return;
    if (savedValue) element.style.setProperty(property, savedValue, savedPriority);
    else element.style.removeProperty(property);
    if (!hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
  }

  function restoreSavedMarker(element, key, previousMarker) {
    if (previousMarker === null) delete element.dataset[key];
    else element.dataset[key] = previousMarker;
  }
}
function selectScrollableArea(jobId, labels) {
  if (window.__kiritoriScrollSelector?.cancel) void window.__kiritoriScrollSelector.cancel();
  restoreSelectionMarkers();
  return createScrollableAreaPicker(jobId, labels);

  function restoreSelectionMarkers() {
    document.querySelectorAll("[data-kiritori-scroll-sticky]").forEach(restoreStickyMarker);
    document.querySelectorAll("[data-kiritori-scroll-state]").forEach(restoreAreaMarker);
    restoreStaleSelectionCapture();
  }

  function restoreStickyMarker(element) {
    const saved = parseMarker(element.dataset.kiritoriScrollSticky);
    if (!isOwnedMarker(saved)) return;
    restoreInlineStyle(element, "visibility", "hidden", saved.visibility, saved.visibilityPriority, saved.hadStyle);
    restoreMarker(element, "kiritoriScrollSticky", saved.previousMarker);
  }

  function restoreAreaMarker(element) {
    const saved = parseMarker(element.dataset.kiritoriScrollState);
    if (!isOwnedMarker(saved)) return false;
    element.scrollTop = saved.originalTop;
    element.scrollLeft = saved.originalLeft;
    restoreInlineStyle(element, "scroll-behavior", "auto", saved.scrollBehavior, saved.scrollPriority, saved.hadStyle);
    restoreMarker(element, "kiritoriScrollState", saved.previousMarker);
    return true;
  }

  function restoreStaleSelectionCapture() {
    const staleCapture = window.__kiritoriScrollCapture;
    if (!staleCapture) return;
    const element = staleCapture.element;
    if (element?.isConnected && !restoreAreaMarker(element)) {
      element.scrollTop = staleCapture.originalTop;
      element.scrollLeft = staleCapture.originalLeft;
      restoreInlineStyle(element, "scroll-behavior", "auto", staleCapture.scrollBehavior, staleCapture.scrollPriority, staleCapture.hadStyle);
    }
    delete window.__kiritoriScrollCapture;
  }

  function parseMarker(value) {
    try {
      return JSON.parse(value || "null");
    } catch (_) {
      // Ignore malformed marker data left by a page or an interrupted capture.
      return null;
    }
  }

  function isOwnedMarker(saved) {
    return saved?.owner === "kiritori" && saved.version === 1;
  }

  function restoreInlineStyle(element, property, currentValue, savedValue, savedPriority, hadStyle) {
    if (element.style.getPropertyValue(property) !== currentValue || element.style.getPropertyPriority(property) !== "important") return;
    if (savedValue) element.style.setProperty(property, savedValue, savedPriority);
    else element.style.removeProperty(property);
    if (!hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
  }

  function restoreMarker(element, key, previousMarker) {
    if (previousMarker === null) delete element.dataset[key];
    else element.dataset[key] = previousMarker;
  }

  function createScrollableAreaPicker(jobId, labels) {
    function getWheelScale(deltaMode) {
      if (deltaMode === 1) return 16;
      if (deltaMode === 2) return window.innerHeight;
      return 1;
    }

    const markerName = "data-kiritori-scroll-state";
    return new Promise((resolve) => {
      const host = document.createElement("div");
      host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
      const shadow = host.attachShadow({ mode: "closed" });
      const glass = document.createElement("div");
      const highlight = document.createElement("div");
      const bar = document.createElement("div");
      const instruction = document.createElement("span");
      const status = document.createElement("span");
      const choose = document.createElement("button");
      const cancel = document.createElement("button");
      Object.assign(glass.style, { position: "fixed", inset: "0", cursor: "crosshair", pointerEvents: "auto", zIndex: "0" });
      Object.assign(highlight.style, { boxSizing: "border-box", position: "fixed", pointerEvents: "none", zIndex: "1", border: "3px solid #1a73e8", background: "rgba(26,115,232,.14)", display: "none" });
      Object.assign(bar.style, { boxSizing: "border-box", position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)", maxWidth: "calc(100vw - 24px)", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", flexWrap: "wrap", padding: "10px 12px", borderRadius: "10px", background: "#202124", color: "white", font: "13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif", boxShadow: "0 3px 14px #0005", pointerEvents: "auto", zIndex: "2" });
      bar.setAttribute("role", "toolbar");
      bar.setAttribute("aria-label", labels.label);
      instruction.textContent = labels.instruction;
      status.textContent = labels.empty;
      for (const button of [choose, cancel]) {
        button.type = "button";
        Object.assign(button.style, { appearance: "none", border: "1px solid #9ca9bc", borderRadius: "6px", padding: "6px 10px", background: "white", color: "#202124", font: "inherit", cursor: "pointer" });
      }
      choose.textContent = labels.choose;
      choose.disabled = true;
      choose.style.opacity = ".5";
      Object.assign(choose.style, { background: "#8ab4f8", borderColor: "#8ab4f8", color: "#102a50", fontWeight: "700" });
      cancel.textContent = labels.cancel;
      bar.append(instruction, status, choose, cancel);
      shadow.append(glass, highlight, bar);

      const state = { jobId, host, port: null, timer: null, settled: false, cancel: () => { void finish(null); } };
      let hovered = null;
      let selected = null;
      let parentHistory = [];
      const resolveSelection = resolve;

      function isScrollable(element) {
        if (!(element instanceof HTMLElement) || element === document.body || element === document.documentElement) return false;
        if (element.clientWidth < 40 || element.clientHeight < 40 || element.scrollHeight <= element.clientHeight + 2) return false;
        const overflow = getComputedStyle(element).overflowY;
        return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
      }

      function nearestScrollable(element) {
        let current = element instanceof Element ? element : null;
        while (current && current !== document.body && current !== document.documentElement) {
          if (isScrollable(current)) return current;
          current = current.parentElement;
        }
        return null;
      }

      function elementAt(x, y) {
        glass.style.pointerEvents = "none";
        const element = document.elementFromPoint(x, y);
        glass.style.pointerEvents = "auto";
        return nearestScrollable(element);
      }

      function showHighlight(element) {
        hovered = element;
        if (!element?.isConnected) {
          highlight.style.display = "none";
          if (!selected) {
            status.textContent = labels.empty;
            choose.disabled = true;
            choose.style.opacity = ".5";
          }
          return;
        }
        const rect = element.getBoundingClientRect();
        const scaleX = element.offsetWidth ? rect.width / element.offsetWidth : 1;
        const scaleY = element.offsetHeight ? rect.height / element.offsetHeight : 1;
        const left = rect.left + element.clientLeft * scaleX;
        const top = rect.top + element.clientTop * scaleY;
        const width = element.clientWidth * scaleX;
        const height = element.clientHeight * scaleY;
        Object.assign(highlight.style, { display: "block", left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
        status.textContent = `${Math.round(element.clientWidth)} × ${Math.round(element.clientHeight)} px · ${Math.round(element.scrollHeight)} px`;
        choose.disabled = false;
        choose.style.opacity = "1";
      }

      async function finish(value) {
        if (state.settled) return;
        state.settled = true;
        clearInterval(state.timer);
        window.removeEventListener("keydown", onKey, true);
        try { state.port?.disconnect(); } catch (_) {}
        host.remove();
        if (window.__kiritoriScrollSelector === state) delete window.__kiritoriScrollSelector;
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        resolveSelection(value);
      }

      function onKey(event) {
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); void finish(null);
        } else if (event.key === "ArrowUp") {
          let parent = hovered?.parentElement;
          while (parent && parent !== document.body && parent !== document.documentElement && !isScrollable(parent)) parent = parent.parentElement;
          if (parent && parent !== document.body && parent !== document.documentElement) {
            event.preventDefault(); event.stopPropagation(); parentHistory.push(hovered); showHighlight(parent);
          }
        } else if (event.key === "ArrowDown" && parentHistory.length) {
          event.preventDefault(); event.stopPropagation(); showHighlight(parentHistory.pop());
        } else if (["PageDown", "PageUp", "Home", "End", " "].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
        }
      }

      window.__kiritoriScrollSelector = state;
      document.documentElement.appendChild(host);
      glass.addEventListener("mousemove", (event) => {
        parentHistory = [];
        if (!selected) showHighlight(elementAt(event.clientX, event.clientY));
      });
      glass.addEventListener("click", (event) => {
        event.preventDefault(); event.stopPropagation();
        selected = hovered || elementAt(event.clientX, event.clientY);
        showHighlight(selected);
      });
      glass.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
      choose.addEventListener("click", async () => {
        if (!selected?.isConnected || !isScrollable(selected)) {
          selected = null;
          showHighlight(null);
          return;
        }
        const element = selected;
        const scrollBehavior = element.style.getPropertyValue("scroll-behavior");
        const scrollPriority = element.style.getPropertyPriority("scroll-behavior");
        const hadStyle = element.hasAttribute("style");
        const originalTop = element.scrollTop;
        const originalLeft = element.scrollLeft;
        const previousMarker = element.dataset.kiritoriScrollState ?? null;
        element.dataset.kiritoriScrollState = JSON.stringify({
          owner: "kiritori", version: 1, originalTop, originalLeft,
          scrollBehavior, scrollPriority, hadStyle, previousMarker
        });
        element.style.setProperty("scroll-behavior", "auto", "important");
        const captureState = { jobId, element, originalTop, originalLeft, scrollBehavior, scrollPriority, hadStyle, markerName };
        window.__kiritoriScrollCapture = captureState;
        element.scrollTop = 0;
        await finish(true);
      });
      cancel.addEventListener("click", () => { void finish(null); });
      window.addEventListener("keydown", onKey, true);
      try {
        state.port = chrome.runtime.connect({ name: "kiritori-selector" });
        state.port.onDisconnect.addListener(() => { if (!state.settled) void state.cancel(); });
        state.port.postMessage({ type: "hello", jobId });
        state.timer = setInterval(() => { try { state.port.postMessage({ type: "heartbeat" }); } catch (_) { void state.cancel(); } }, 20_000);
      } catch (_) {
        // A missing extension connection means the picker can no longer be controlled.
        void state.cancel();
      }
    });
  }
}

function getPaginationAreaLocator(jobId) {
  const el = window.__kiritoriScrollCapture?.jobId === jobId && window.__kiritoriScrollCapture.element;
  if (!el?.isConnected) return null;
  const parts = [];
  for (let node = el; node?.nodeType === 1; node = node.parentElement) {
    if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
    let index = 1;
    for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.tagName === node.tagName) index++;
    parts.unshift(`${node.localName}:nth-of-type(${index})`);
  }
  const label = el.getAttribute("aria-label");
  const fallback = label ? `${el.localName}[aria-label=${JSON.stringify(label)}]` : null;
  return { selector: parts.join(" > "), fallback: fallback && document.querySelectorAll(fallback).length === 1 ? fallback : null, tag: el.localName, label, id: el.id || null, classes: [...el.classList] };
}

function activatePaginationArea(jobId, locator) {
  let el;
  const matches = element => element instanceof HTMLElement && element.localName === locator.tag && (!locator.id || element.id === locator.id) && (!locator.label || element.getAttribute("aria-label") === locator.label) && (locator.classes || []).every(name => element.classList.contains(name));
  try {
    el = document.querySelector(locator.selector);
    if (!matches(el) && locator.fallback) {
      const candidates = document.querySelectorAll(locator.fallback);
      el = candidates.length === 1 ? candidates[0] : null;
    }
  } catch (_) {
    // Page-provided selectors may become invalid after client-side navigation.
    return false;
  }
  if (!matches(el) || el.clientWidth < 40 || el.clientHeight < 40 || !["auto", "scroll", "overlay"].includes(getComputedStyle(el).overflowY)) return false;
  const markerName = "data-kiritori-scroll-state";
  const scrollBehavior = el.style.getPropertyValue("scroll-behavior");
  const scrollPriority = el.style.getPropertyPriority("scroll-behavior");
  const hadStyle = el.hasAttribute("style");
  const originalTop = el.scrollTop, originalLeft = el.scrollLeft, previousMarker = el.dataset.kiritoriScrollState ?? null;
  el.dataset.kiritoriScrollState = JSON.stringify({ owner: "kiritori", version: 1, originalTop, originalLeft, scrollBehavior, scrollPriority, hadStyle, previousMarker });
  el.style.setProperty("scroll-behavior", "auto", "important");
  window.__kiritoriScrollCapture = { jobId, element: el, originalTop, originalLeft, scrollBehavior, scrollPriority, hadStyle, markerName };
  el.scrollTop = 0;
  return true;
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
    const result = await capturePaginatedScrollFrame(tab, job, scope, page, scrollWaitMs, timing, index, targetY, previousY);
    if (result.completed) return true;
    targetY = result.targetY;
    previousY = result.actualY;
  }
  return false;
}

async function capturePaginatedScrollFrame(tab, job, scope, page, scrollWaitMs, timing, index, targetY, previousY) {
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
function scrollScrollableArea(jobId, y) {
  const state = window.__kiritoriScrollCapture;
  if (!state || state.jobId !== jobId || !state.element?.isConnected) return null;
  const element = state.element;
  const bounds = element.getBoundingClientRect();
  const scaleY = element.offsetHeight ? bounds.height / element.offsetHeight : 1;
  element.scrollTop = y / (scaleY || 1);
  const readMetrics = () => {
    const rect = element.getBoundingClientRect();
    const currentScaleX = element.offsetWidth ? rect.width / element.offsetWidth : 1;
    const currentScaleY = element.offsetHeight ? rect.height / element.offsetHeight : 1;
    return {
      scrollTop: element.scrollTop * currentScaleY,
      scrollHeight: element.scrollHeight * currentScaleY,
      clientHeight: element.clientHeight * currentScaleY,
      clientWidth: element.clientWidth * currentScaleX,
      rect: {
        x: rect.left + element.clientLeft * currentScaleX,
        y: rect.top + element.clientTop * currentScaleY,
        width: element.clientWidth * currentScaleX,
        height: element.clientHeight * currentScaleY
      }
    };
  };
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(readMetrics()), 160))));
}

function readScrollableAreaMetrics(jobId) {
  const state = window.__kiritoriScrollCapture;
  const element = state?.element;
  if (!element || state.jobId !== jobId || !element.isConnected) return null;
  const bounds = element.getBoundingClientRect();
  const scaleX = element.offsetWidth ? bounds.width / element.offsetWidth : 1;
  const scaleY = element.offsetHeight ? bounds.height / element.offsetHeight : 1;
  return {
    scrollTop: element.scrollTop * scaleY,
    scrollHeight: element.scrollHeight * scaleY,
    clientHeight: element.clientHeight * scaleY,
    clientWidth: element.clientWidth * scaleX,
    rect: {
      x: bounds.left + element.clientLeft * scaleX,
      y: bounds.top + element.clientTop * scaleY,
      width: element.clientWidth * scaleX,
      height: element.clientHeight * scaleY
    }
  };
}

function hideScrollableAreaSticky(jobId) {
  const state = window.__kiritoriScrollCapture;
  if (!state || state.jobId !== jobId || !state.element?.isConnected) return 0;
  const markerName = "data-kiritori-scroll-sticky";
  let hidden = 0;
  for (const element of state.element.querySelectorAll("*")) {
    const position = getComputedStyle(element).position;
    if ((position !== "fixed" && position !== "sticky") || element.dataset.kiritoriScrollSticky !== undefined) continue;
    const saved = {
      owner: "kiritori", version: 1, jobId,
      visibility: element.style.getPropertyValue("visibility"),
      visibilityPriority: element.style.getPropertyPriority("visibility"),
      hadStyle: element.hasAttribute("style"),
      previousMarker: element.dataset.kiritoriScrollSticky ?? null
    };
    element.dataset.kiritoriScrollSticky = JSON.stringify(saved);
    element.style.setProperty("visibility", "hidden", "important");
    hidden += 1;
  }
  return hidden;
}

function suppressScrollableAreaHover(jobId) {
  const state = window.__kiritoriScrollCapture;
  if (!state || state.jobId !== jobId || !state.element?.isConnected || state.interactionStyle) return false;
  const style = document.createElement("style");
  style.dataset.kiritoriScrollInteraction = JSON.stringify({ owner: "kiritori", version: 1, jobId });
  style.textContent = "body, body * { pointer-events: none !important; }";
  document.documentElement.appendChild(style);
  state.interactionStyle = style;
  return true;
}

async function waitForScrollableAreaStable(jobId) {
  const readMetrics = () => {
    const state = window.__kiritoriScrollCapture;
    const element = state?.element;
    if (!element || state.jobId !== jobId || !element.isConnected) return null;
    const rect = element.getBoundingClientRect();
    const scaleX = element.offsetWidth ? rect.width / element.offsetWidth : 1;
    const scaleY = element.offsetHeight ? rect.height / element.offsetHeight : 1;
    return {
      scrollTop: element.scrollTop * scaleY,
      scrollHeight: element.scrollHeight * scaleY,
      clientHeight: element.clientHeight * scaleY,
      clientWidth: element.clientWidth * scaleX,
      rect: {
        x: rect.left + element.clientLeft * scaleX,
        y: rect.top + element.clientTop * scaleY,
        width: element.clientWidth * scaleX,
        height: element.clientHeight * scaleY
      }
    };
  };
  let metrics = readMetrics();
  if (!metrics) return null;
  let stableChecks = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    const next = readMetrics();
    if (!next) return null;
    stableChecks = next.scrollHeight === metrics.scrollHeight ? stableChecks + 1 : 0;
    metrics = next;
    if (stableChecks >= 2) break;
  }
  return metrics;
}

function restoreScrollableArea(jobId) {
  const state = window.__kiritoriScrollCapture;
  if (!state || state.jobId !== jobId) return false;
  if (state.interactionStyle?.isConnected) state.interactionStyle.remove();
  document.querySelectorAll("style[data-kiritori-scroll-interaction]").forEach(restoreInteractionStyle);
  document.querySelectorAll("[data-kiritori-scroll-sticky]").forEach(restoreStickyElement);
  restoreSelectedArea(state);
  delete window.__kiritoriScrollCapture;
  return true;

  function restoreInteractionStyle(style) {
    const saved = parseMarker(style.dataset.kiritoriScrollInteraction);
    if (isOwnedMarker(saved) && saved.jobId === jobId) style.remove();
  }

  function restoreStickyElement(element) {
    const saved = parseMarker(element.dataset.kiritoriScrollSticky);
    if (!isOwnedMarker(saved) || saved.jobId !== jobId) return;
    restoreInlineStyle(element, "visibility", "hidden", saved.visibility, saved.visibilityPriority, saved.hadStyle);
    restoreMarker(element, "kiritoriScrollSticky", saved.previousMarker);
  }

  function restoreSelectedArea(captureState) {
    const element = captureState.element;
    if (!element?.isConnected) return;
    element.scrollTop = captureState.originalTop;
    element.scrollLeft = captureState.originalLeft;
    restoreInlineStyle(element, "scroll-behavior", "auto", captureState.scrollBehavior, captureState.scrollPriority, captureState.hadStyle);
    if (!captureState.markerName) return;
    const saved = parseMarker(element.dataset.kiritoriScrollState);
    if (!isOwnedMarker(saved)) return;
    restoreMarker(element, "kiritoriScrollState", saved.previousMarker);
  }

  function parseMarker(value) {
    try {
      return JSON.parse(value || "null");
    } catch (_) {
      // Ignore malformed marker data left by a page or an interrupted capture.
      return null;
    }
  }

  function isOwnedMarker(saved) {
    return saved?.owner === "kiritori" && saved.version === 1;
  }

  function restoreInlineStyle(element, property, currentValue, savedValue, savedPriority, hadStyle) {
    if (element.style.getPropertyValue(property) !== currentValue || element.style.getPropertyPriority(property) !== "important") return;
    if (savedValue) element.style.setProperty(property, savedValue, savedPriority);
    else element.style.removeProperty(property);
    if (!hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
  }

  function restoreMarker(element, key, previousMarker) {
    if (previousMarker === null) delete element.dataset[key];
    else element.dataset[key] = previousMarker;
  }
}
function restoreManualHiddenElements(jobId) {
  if (window.__kiritoriManualHide?.jobId === jobId) window.__kiritoriManualHide.restore();
  if (window.__kiritoriManualCancelJob === jobId) delete window.__kiritoriManualCancelJob;
}

async function hideBackToTopButtons() {
  if (window.__localCaptureBackToTopStyle) return;
  const selectors = [
    ".to-top", ".to-top-button", "#to-top",
    ".back-to-top", "#back-to-top", ".backtotop", "#backtotop",
    ".scroll-to-top", "#scroll-to-top", ".scrolltop", "#scrolltop",
    ".pagetop", "#pagetop", ".page-top-button", "#page-top-button",
    "[aria-label*='ページトップ']", "[title*='ページトップ']",
    "[aria-label*='ページ上部へ']", "[title*='ページ上部へ']",
    "[aria-label*='先頭へ戻']", "[title*='先頭へ戻']",
    "[aria-label*='トップへ戻']", "[title*='トップへ戻']",
    "[aria-label*='上へ戻']", "[title*='上へ戻']",
    "[aria-label*='back to top' i]", "[title*='back to top' i]",
    "[aria-label*='scroll to top' i]", "[title*='scroll to top' i]"
  ];
  const selector = selectors.join(",");
  const style = document.createElement("style");
  style.textContent = `:is(${selector}), :is(${selector}) * { visibility: hidden !important; }`;
  window.__localCaptureBackToTopStyle = style;
  document.documentElement.appendChild(style);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function restoreBackToTopButtons() {
  const style = window.__localCaptureBackToTopStyle;
  if (!style) return;
  style.remove();
  delete window.__localCaptureBackToTopStyle;
}

async function applyAdFilter() {
  if (window.__localCaptureAdFilter) return window.__localCaptureAdFilter.elements.length;

  const selectors = [
    "[data-ad]",
    "[data-ad-client]",
    "[data-ad-slot]",
    "[data-ad-unit]",
    "[data-google-query-id]",
    "ins.adsbygoogle",
    "iframe[id*='google_ads_iframe' i]",
    "iframe[src*='doubleclick.net' i]",
    "iframe[src*='googlesyndication.com' i]",
    "iframe[src*='adservice.google' i]",
    "iframe[title*='advert' i]",
    "iframe[title*='sponsor' i]",
    "[aria-label*='広告']",
    "[aria-label*='スポンサー']",
    "[aria-label*='sponsored' i]"
  ];
  const selectorText = selectors.join(",");
  const state = {
    elements: [],
    style: document.createElement("style"),
    observer: null
  };
  state.style.textContent = "[data-localcapture-ad-hidden='1']{display:none!important;visibility:hidden!important}";
  (document.head || document.documentElement).appendChild(state.style);
  window.__localCaptureAdFilter = state;

  const isNamedAd = (element) => {
    const className = typeof element.className === "string" ? element.className : "";
    const label = `${element.id || ""} ${className}`;
    return /(^|[^a-z0-9])(?:ad|ads|advert|advertising|advertisement|advertorial|sponsor|sponsored|sponsorship|promo|promotion|promoted|pr)(?=$|[^a-z0-9])/i.test(label)
      || /広告|スポンサー/.test(label);
  };

  const markAd = (element) => {
    if (!(element instanceof Element) || /^(HTML|HEAD|BODY|SCRIPT|STYLE)$/.test(element.tagName)) return;
    if (element.dataset.localcaptureAdHidden !== undefined) return;
    if (!element.matches(selectorText) && !isNamedAd(element)) return;
    element.dataset.localcaptureAdHidden = "1";
    state.elements.push(element);
  };

  const scanAddedNode = (node) => {
    if (!(node instanceof Element)) return;
    markAd(node);
    for (const child of node.querySelectorAll("*")) markAd(child);
  };

  for (const element of document.querySelectorAll("body *")) markAd(element);
  state.observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        markAd(record.target);
      } else {
        for (const node of record.addedNodes) scanAddedNode(node);
      }
    }
  });
  state.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["id", "class", "data-ad", "data-ad-client", "data-ad-slot", "data-ad-unit", "aria-label"]
  });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return state.elements.length;
}

function restoreAdFilter() {
  const state = window.__localCaptureAdFilter;
  if (!state) return false;
  state.observer.disconnect();
  for (const element of state.elements) delete element.dataset.localcaptureAdHidden;
  state.style.remove();
  delete window.__localCaptureAdFilter;
  return true;
}

function selectRegion(hintText) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    const box = document.createElement("div");
    const hint = document.createElement("div");
    let startX = 0;
    let startY = 0;
    let selecting = false;

    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.18);touch-action:none;";
    box.style.cssText = "position:fixed;border:2px solid #1a73e8;background:rgba(26,115,232,.16);display:none;pointer-events:none;";
    hint.textContent = hintText;
    hint.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:8px 12px;border-radius:8px;background:#202124;color:white;font:13px sans-serif;box-shadow:0 2px 8px #0004;pointer-events:none;";
    overlay.append(box, hint);

    const finish = (value) => {
      overlay.remove();
      window.removeEventListener("keydown", onKeyDown, true);
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") finish(null);
    };
    overlay.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      selecting = true;
      startX = event.clientX;
      startY = event.clientY;
      box.style.display = "block";
      box.style.left = `${startX}px`;
      box.style.top = `${startY}px`;
      box.style.width = "0px";
      box.style.height = "0px";
    });
    overlay.addEventListener("mousemove", (event) => {
      if (!selecting) return;
      const left = Math.min(startX, event.clientX);
      const top = Math.min(startY, event.clientY);
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${Math.abs(event.clientX - startX)}px`;
      box.style.height = `${Math.abs(event.clientY - startY)}px`;
    });
    overlay.addEventListener("mouseup", (event) => {
      if (!selecting) return;
      selecting = false;
      const left = Math.min(startX, event.clientX);
      const top = Math.min(startY, event.clientY);
      const width = Math.abs(event.clientX - startX);
      const height = Math.abs(event.clientY - startY);
      if (width < 4 || height < 4) return finish(null);
      finish({ x: left, y: top, width, height });
    });
    window.addEventListener("keydown", onKeyDown, true);
    document.documentElement.appendChild(overlay);
  });
}

async function prepareFullPage() {
  const state = {
    x: window.scrollX,
    y: window.scrollY,
    hidden: [],
    style: document.createElement("style")
  };
  state.style.textContent = "html{scroll-behavior:auto!important}[data-localcapture-hidden='1']{visibility:hidden!important}";
  document.documentElement.appendChild(state.style);
  window.__localCaptureState = state;

  const hideFixedElements = () => {
    for (const element of document.querySelectorAll("body *")) {
      const position = getComputedStyle(element).position;
      if ((position === "fixed" || position === "sticky") && element.dataset.localcaptureHidden === undefined) {
        element.dataset.localcaptureHidden = "1";
        state.hidden.push(element);
      }
    }
  };

  const dimensions = () => ({
    viewportWidth: document.documentElement.clientWidth,
    viewportHeight: document.documentElement.clientHeight,
    pageHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
  });

  hideFixedElements();
  const size = dimensions();
  return {
    title: document.title || "screenshot",
    url: location.href,
    viewportWidth: size.viewportWidth,
    viewportHeight: size.viewportHeight,
    pageHeight: size.pageHeight,
    originalScrollX: state.x,
    originalScrollY: state.y
  };
}

async function scrollFullPage(y) {
  const state = window.__localCaptureState;
  window.scrollTo(state?.x || 0, y);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 140));

  const captureState = window.__localCaptureState;
  for (const element of document.querySelectorAll("body *")) {
    const position = getComputedStyle(element).position;
    if ((position === "fixed" || position === "sticky") && element.dataset.localcaptureHidden === undefined) {
      element.dataset.localcaptureHidden = "1";
      captureState?.hidden.push(element);
    }
  }

  return {
    scrollY: window.scrollY,
    viewportHeight: document.documentElement.clientHeight,
    pageHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
  };
}

function readFullPageMetrics() {
  return {
    scrollY: window.scrollY,
    viewportHeight: document.documentElement.clientHeight,
    pageHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
  };
}

async function waitForPageHeightStable() {
  const readMetrics = () => ({
    scrollY: window.scrollY,
    viewportHeight: document.documentElement.clientHeight,
    pageHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
  });
  let metrics = readMetrics();
  let stableChecks = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    const next = readMetrics();
    stableChecks = next.pageHeight === metrics.pageHeight ? stableChecks + 1 : 0;
    metrics = next;
    if (stableChecks >= 2) break;
  }
  return metrics;
}

function restoreFullPage() {
  const state = window.__localCaptureState;
  if (!state) return false;
  for (const element of state.hidden) delete element.dataset.localcaptureHidden;
  state.style.remove();
  window.scrollTo(state.x, state.y);
  delete window.__localCaptureState;
  return true;
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
