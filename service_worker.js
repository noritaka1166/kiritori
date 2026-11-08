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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;
  if (message?.type === "capture:failures:list") {
    failureHistoryWrite.then(() => chrome.storage.local.get(failureHistoryKey))
      .then((data) => sendResponse({ ok: true, failures: Array.isArray(data[failureHistoryKey]) ? data[failureHistoryKey] : [] }))
      .catch(() => sendResponse({ ok: false, error: kiriT("失敗履歴を読み込めませんでした。") }));
    return true;
  }
  if (message?.type === "capture:failures:clear") {
    failureHistoryWrite = failureHistoryWrite.catch(() => undefined).then(() => chrome.storage.local.set({ [failureHistoryKey]: [] }));
    failureHistoryWrite.then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, error: kiriT("失敗履歴を削除できませんでした。") }));
    return true;
  }
  if (message?.type === "capture:status") {
    sendResponse({ ok: true, status: activeCapture ? captureStatus(activeCapture) : lastCaptureStatus });
    return false;
  }
  if (message?.type === "capture:cancel") {
    if (!activeCapture || !activeCapture.cancellable || (message.jobId && message.jobId !== activeCapture.id)) {
      sendResponse({ ok: false, error: kiriT("キャンセルできる撮影はありません。") });
      return false;
    }
    const job = activeCapture;
    const wasSelecting = job.phase === "selecting";
    job.cancelRequested = true;
    reportCapture(job, { phase: "cancelling" });
    job.editorResolve?.(null);
    if (wasSelecting && job.tabId) {
      executeInTab(job.tabId, cancelManualSelection, [job.id]).catch(() => undefined);
      if (job.selectionKind === "pagination") executeInTab(job.tabId, cancelPaginationSelection, [job.id]).catch(() => undefined);
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "capture:editor:focus") {
    if (!activeCapture?.editorTabId || activeCapture.phase !== "editing") {
      sendResponse({ ok: false, error: kiriT("編集画面が見つかりません。") });
      return false;
    }
    chrome.tabs.update(activeCapture.editorTabId, { active: true })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false, error: kiriT("編集画面を開けませんでした。") }));
    return true;
  }
  if (message?.type === "capture:editor:retake") {
    const job = activeCapture;
    const valid = sender?.url?.startsWith(chrome.runtime.getURL("editor.html")) && sender.tab?.id === job?.editorTabId;
    if (!valid || !job || job.id !== message.jobId || job.phase !== "editing" || job.editorCommitted || job.editorRetakePending) {
      sendResponse({ ok: false, error: kiriT("撮り直しを開始できませんでした。") }); return false;
    }
    job.editorRetakePending = true;
    (async () => {
      let tab;
      try { tab = await chrome.tabs.get(job.tabId); } catch (_) { throw new Error("撮影元のタブが見つかりません。"); }
      if (!tab?.url || tab.url !== job.editorMeta?.url) throw new Error("撮影元のページが変更されています。元のページを開き直して撮影してください。");
      if (activeCapture !== job || job.phase !== "editing" || job.cancelRequested || job.editorCommitted) throw new Error("撮り直しを開始できませんでした。");
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
      if (activeCapture !== job || job.phase !== "editing" || job.cancelRequested || job.editorCommitted) throw new Error("撮り直しを開始できませんでした。");
      job.editorCommitted = true;
      reportCapture(job, { phase: "processing", cancellable: false });
      job.editorResolve?.({ retry: true, tab });
      return { ok: true };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: kiriT(error.message || "撮り直しを開始できませんでした。") })).finally(() => { job.editorRetakePending = false; });
    return true;
  }
  if (["capture:editor:load", "capture:editor:commit", "capture:pagination:accept"].includes(message?.type)) {
    const job = activeCapture;
    const isPaginationPreview = job?.mode === "pagination" && sender?.url?.startsWith(chrome.runtime.getURL("pagination-preview.html"));
    const validSender = (isPaginationPreview || (job?.mode !== "pagination" && sender?.url?.startsWith(chrome.runtime.getURL("editor.html")))) && sender?.tab?.id;
    if (!job || job.id !== message.jobId || job.phase !== "editing" || !validSender ||
        (job.editorTabId && sender.tab.id !== job.editorTabId)) {
      sendResponse({ ok: false, error: kiriT("編集する画像が見つかりません。") });
      return false;
    }
    job.editorTabId = sender.tab.id;
    if (message.type === "capture:editor:load") {
      sendResponse({ ok: true, url: job.previewUrl, format: job.editorOptions.format, destination: job.editorOptions.destination, meta: job.editorMeta, options: job.editorOptions, pagination: job.previewPages, sourceTabId: job.tabId });
      return false;
    }
    if (message.type === "capture:pagination:accept" && isPaginationPreview && !job.editorCommitted && !job.editorRetakePending) {
      job.editorCommitted = true;
      reportCapture(job, { phase: "processing", cancellable: false });
      job.editorResolve?.({ unchanged: true });
      sendResponse({ ok: true });
      return false;
    }
    if (message.type !== "capture:editor:commit" || isPaginationPreview || job.editorCommitted || job.editorRetakePending || typeof message.url !== "string" || !message.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) {
      sendResponse({ ok: false, error: kiriT("編集画像を受け取れませんでした。") });
      return false;
    }
    job.editorCommitted = true;
    reportCapture(job, { phase: "processing", cancellable: false });
    job.editorResolve?.({ url: message.url });
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "draft:update") {
    const valid = sender?.url?.startsWith(chrome.runtime.getURL("editor.html")) && sender.tab?.id;
    if (!valid || typeof message.id !== "string" || !Array.isArray(message.history) || !Array.isArray(message.redoStack) || ![1, 7, 30].includes(message.retentionDays)) { sendResponse({ ok: false }); return false; }
    const previous = draftUpdateQueues.get(message.id) || Promise.resolve();
    const update = previous.catch(() => undefined).then(() => {
      const now = Date.now();
      return draftStore.update(message.id, { history: message.history, redoStack: message.redoStack, retentionDays: message.retentionDays, updatedAt: now, expiresAt: now + message.retentionDays * 86400000 });
    });
    draftUpdateQueues.set(message.id, update);
    update.then(found => sendResponse({ ok: found })).catch(() => sendResponse({ ok: false })).finally(() => { if (draftUpdateQueues.get(message.id) === update) draftUpdateQueues.delete(message.id); });
    return true;
  }
  if (message?.type === "draft:export") {
    const valid = sender?.url?.startsWith(chrome.runtime.getURL("editor.html")) && sender.tab?.id;
    if (!valid || typeof message.url !== "string" || !message.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) { sendResponse({ ok: false, error: kiriT("画像を出力できませんでした。") }); return false; }
    exportRecoveredDraft(message.id, message.url).then(result => sendResponse({ ok: true, message: result })).catch(error => sendResponse({ ok: false, error: explainError(error) }));
    return true;
  }
  if (message?.type !== "capture:start") return false;

  startCapture(message.options)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, cancelled: error?.name === "CaptureCancelled", error: explainError(error) }));
  return true;
});

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
    const text = job.active ? (job.phase === "countdown" ? String(job.countdownRemaining) : job.currentFrame ? String(job.currentFrame) : "…") : "";
    chrome.action.setBadgeText({ text, tabId: job.tabId }).catch(() => undefined);
    chrome.action.setBadgeBackgroundColor({ color: "#1a73e8", tabId: job.tabId }).catch(() => undefined);
    const description = job.cancelRequested ? kiriT("撮影をキャンセル中") : job.phase === "countdown" ? kiriT("$1秒後に撮影を開始します…", job.countdownRemaining) : job.phase === "selecting" ? (job.mode === "scroll-area" && job.selectionKind === "scroll-area" ? kiriT("スクロール領域を選択中") : kiriT("隠す要素を選択中")) : job.phase === "editing" ? kiriT("プレビューで編集中") : job.phase === "processing" ? kiriT("画像をまとめています") : job.phase === "saving" ? kiriT("画像を出力中") : job.currentFrame ? kiriT("$1画面目を撮影中", job.currentFrame) : kiriT("撮影を準備中");
    const title = job.active ? `KiriTori: ${description}` : "KiriTori";
    chrome.action.setTitle({ title, tabId: job.tabId }).catch(() => undefined);
  }
  chrome.runtime.sendMessage({ type: "capture:progress", status }).catch(() => undefined);
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

  if (options.mode === "pagination") { options = { ...options, destination: "save", removeAds: false, manualHide: false }; }

  const tabs = targetTab ? [] : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = targetTab || tabs[0];
  if (!tab?.id || !tab.windowId) throw new Error("撮影するChromeタブが見つかりません。");
  job.tabId = tab.id;
  if (badgeTimers.has(tab.id)) {
    clearTimeout(badgeTimers.get(tab.id));
    badgeTimers.delete(tab.id);
  }
  const seconds = [3, 5].includes(options.captureDelay) ? options.captureDelay : 0;
  if (seconds) {
    job.hadCountdown = true;
    const deadline = Date.now() + seconds * 1000;
    let previousRemaining = 0;
    try {
      while (true) {
        throwIfCancelled(job);
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const remaining = Math.ceil(remainingMs / 1000);
        if (remaining !== previousRemaining) {
          reportCapture(job, { phase: "countdown", countdownRemaining: remaining, cancellable: true });
          await executeInTab(tab.id, updateCountdownOverlay, [job.id, remaining, kiriT("$1秒後に撮影を開始します…", remaining)]);
          previousRemaining = remaining;
        }
        await delay(Math.min(250, Math.max(0, deadline - Date.now())));
      }
    } finally {
      await executeInTab(tab.id, updateCountdownOverlay, [job.id, 0, ""]);
    }
    throwIfCancelled(job);
    await assertTabStillActive(tab.id, tab.windowId);
    throwIfCancelled(job);
    reportCapture(job, { phase: "preparing", countdownRemaining: 0, cancellable: ["full", "scroll-area", "pagination"].includes(options.mode) });
  } else {
    reportCapture(job);
    throwIfCancelled(job);
  }

  await ensureOffscreenDocument();
  throwIfCancelled(job);
  await executeInTab(tab.id, restoreStaleScrollAreaState);
  throwIfCancelled(job);
  let meta;
  let adFilterApplied = false;
  let backToTopFilterRequested = false;
  let manualHideRequested = false;
  let scrollAreaSelected = false;
  let reachedLimit = false;
  let paginationWarning = "";
  const maxFrames = Math.min(200, Math.max(1, Math.floor(Number(options.maxFrames) || 80)));
  const scrollWaitPresets = { fast: 200, normal: 600, slow: 1500 };
  const customWait = options.scrollWaitMs === null || options.scrollWaitMs === "" ? NaN : Number(options.scrollWaitMs);
  const scrollWaitMs = options.scrollSpeed === "custom" && Number.isFinite(customWait) ? Math.min(10000, Math.max(0, Math.floor(customWait))) : (scrollWaitPresets[options.scrollSpeed] ?? 600);
  let lastFrameCapturedAt = 0;

  try {
    backToTopFilterRequested = true;
    await executeInTab(tab.id, hideBackToTopButtons);
    throwIfCancelled(job);
    if (options.removeAds === true) {
      adFilterApplied = true;
      await executeInTab(tab.id, applyAdFilter);
      throwIfCancelled(job);
    }
    if (options.manualHide === true) {
      manualHideRequested = true;
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

    if (options.mode === "pagination") {
      const page = await executeInTab(tab.id, readPageInfo);
      reportCapture(job, { phase: "selecting", selectionKind: "pagination", cancellable: true });
      const button = await executeInTab(tab.id, selectPaginationButton, [job.id, kiriT("ページ上の「次へ」ボタンを選んでください。"), kiriT("Escでキャンセル")]);
      if (!button) { const error = new Error("撮影をキャンセルしました。"); error.name = "CaptureCancelled"; throw error; }
      throwIfCancelled(job);
      meta = { ...page, mode: "pagination" };
      options.fileStem = makeFileStem(meta, options.filenamePattern);
      await offscreenMessage({ type: "begin", meta, options });
      job.offscreenStarted = true;
      const limit = Math.min(50, Math.max(1, Math.floor(Number(options.paginationLimit) || 20)));
      const waitMs = Math.min(10000, Math.max(500, Math.floor(Number(options.paginationWait) || 1500)));
      const seen = new Set();
      let stopped = false;
      for (let index = 0; index < limit; index += 1) {
        throwIfCancelled(job);
        await assertTabStillActive(tab.id, tab.windowId);
        const snapshot = await executeInTab(tab.id, paginationSnapshot);
        if (seen.has(snapshot.signature)) { paginationWarning = kiriT("同じページが再表示されたため、そこで撮影を終了しました。"); stopped = true; break; }
        seen.add(snapshot.signature);
        reportCapture(job, { phase: "capturing", selectionKind: null, currentFrame: index + 1, cancellable: true });
        if (lastFrameCapturedAt) await delay(Math.max(0, 510 - (Date.now() - lastFrameCapturedAt)));
        throwIfCancelled(job);
        const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        lastFrameCapturedAt = Date.now();
        await assertTabStillActive(tab.id, tab.windowId);
        throwIfCancelled(job);
        try {
          await offscreenMessage({ type: "add-frame", image });
        } catch (error) {
          if (index > 0 && /ページ画像が大きすぎます/.test(error?.message || "")) {
            paginationWarning = kiriT("画像サイズの上限に達したため、そこまでのページを保存しました。");
            stopped = true;
            break;
          }
          throw error;
        }
        if (index === limit - 1) break;
        const click = await executeInTab(tab.id, clickPaginationButton, [button]);
        if (click === "end") { stopped = true; break; }
        if (click !== "clicked") { paginationWarning = kiriT("次へボタンを確認できないため、そこで撮影を終了しました。"); stopped = true; break; }
        let elapsed = 0;
        while (elapsed < waitMs) { const step = Math.min(250, waitMs - elapsed); await delay(step); elapsed += step; throwIfCancelled(job); }
        let next = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          throwIfCancelled(job);
          await assertTabStillActive(tab.id, tab.windowId);
          try { next = await executeInTab(tab.id, paginationSnapshot); } catch (_) { next = null; }
          if (next?.ready && next.signature !== snapshot.signature) break;
          await delay(250);
        }
        if (!next?.ready || next.signature === snapshot.signature) { paginationWarning = kiriT("ページの変化を確認できないため、そこで撮影を終了しました。"); stopped = true; break; }
      }
      if (!stopped) paginationWarning = kiriT("$1ページの上限まで撮影しました。続きは含まれていません。", limit);
    } else if (options.mode === "full") {
      const prepared = await executeInTab(tab.id, prepareFullPage);
      try {
        throwIfCancelled(job);
        meta = { ...prepared, mode: "full" };
        options.fileStem = makeFileStem(meta, options.filenamePattern);
        await offscreenMessage({ type: "begin", meta, options });
        job.offscreenStarted = true;
        throwIfCancelled(job);
        let targetY = 0;
        let previousY = -1;
        let completed = false;
        for (let index = 0; index < maxFrames; index += 1) {
          throwIfCancelled(job);
          reportCapture(job, { phase: "capturing", currentFrame: index + 1 });
          await assertTabStillActive(tab.id, tab.windowId);
          const frameInfo = await executeInTab(tab.id, scrollFullPage, [targetY]);
          throwIfCancelled(job);
          const actualY = frameInfo?.scrollY;
          if (!Number.isFinite(actualY) || (index > 0 && actualY <= previousY + 1)) {
            throw new Error("ページを縦にスクロールできませんでした。表示範囲か選択範囲で撮影してください。");
          }
          previousY = actualY;
          await delay(Math.max(scrollWaitMs, lastFrameCapturedAt ? 510 - (Date.now() - lastFrameCapturedAt) : 0, 0));
          throwIfCancelled(job);
          await assertTabStillActive(tab.id, tab.windowId);
          const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
          lastFrameCapturedAt = Date.now();
          await assertTabStillActive(tab.id, tab.windowId);
          throwIfCancelled(job);
          const pageMetrics = await executeInTab(tab.id, readFullPageMetrics);
          await offscreenMessage({
            type: "add-frame",
            image,
            scrollY: actualY,
            pageHeight: frameInfo.pageHeight,
            currentPageHeight: pageMetrics.pageHeight
          });
          throwIfCancelled(job);

          let latestMetrics = pageMetrics;
          let bottom = Math.max(0, latestMetrics.pageHeight - latestMetrics.viewportHeight);
          if (actualY >= bottom - 1) {
            latestMetrics = await executeInTab(tab.id, waitForPageHeightStable);
            throwIfCancelled(job);
            bottom = Math.max(0, latestMetrics.pageHeight - latestMetrics.viewportHeight);
            if (actualY >= bottom - 1) {
              completed = true;
              break;
            }
          }

          targetY = Math.min(actualY + latestMetrics.viewportHeight, bottom);
          if (targetY <= actualY + 1) {
            throw new Error("ページのスクロール位置を更新できませんでした。表示範囲か選択範囲で撮影してください。");
          }
        }
        if (!completed) { await offscreenMessage({ type: "trim-to-captured" }); reachedLimit = true; }
      } finally {
        await executeInTab(tab.id, restoreFullPage).catch(() => undefined);
      }
    } else if (options.mode === "scroll-area") {
      const page = await executeInTab(tab.id, readPageInfo);
      reportCapture(job, { phase: "selecting", selectionKind: "scroll-area", cancellable: true });
      throwIfCancelled(job);
      const selected = await executeInTab(tab.id, selectScrollableArea, [job.id, {
        label: kiriT("スクロール領域を選択"),
        instruction: kiriT("カーソルを合わせてクリックし、スクロール領域を選びます。↑キーで親の領域を選べます。"),
        choose: kiriT("この領域を撮影"),
        cancel: kiriT("キャンセル"),
        empty: kiriT("縦スクロールできる領域を選んでください。")
      }]);
      if (!selected) {
        const error = new Error("スクロール領域の選択をキャンセルしました。");
        error.name = "CaptureCancelled";
        throw error;
      }
      scrollAreaSelected = true;
      reportCapture(job, { phase: "preparing", selectionKind: null, cancellable: true });
      const area = await executeInTab(tab.id, readScrollableAreaMetrics, [job.id]);
      if (!area) throw new Error("スクロール領域がページ内から見つかりません。もう一度選択してください。");
      if (area.rect.x < 0 || area.rect.y < 0 || area.rect.x + area.rect.width > page.viewportWidth + 1 || area.rect.y + area.rect.height > page.viewportHeight + 1) {
        throw new Error("スクロール領域全体が画面に表示されるようにしてから撮影してください。");
      }
      await executeInTab(tab.id, suppressScrollableAreaHover, [job.id]);
      meta = { ...page, mode: "scroll-area", scrollArea: area };
      options.fileStem = makeFileStem(meta, options.filenamePattern);
      await offscreenMessage({ type: "begin", meta, options });
      job.offscreenStarted = true;
      throwIfCancelled(job);
      let targetY = 0;
      let previousY = -1;
      let completed = false;
      for (let index = 0; index < maxFrames; index += 1) {
        throwIfCancelled(job);
        reportCapture(job, { phase: "capturing", currentFrame: index + 1 });
        await assertTabStillActive(tab.id, tab.windowId);
        const frameInfo = await executeInTab(tab.id, scrollScrollableArea, [job.id, targetY]);
        throwIfCancelled(job);
        const actualY = frameInfo?.scrollTop;
        if (!frameInfo || frameInfo.rect.x < 0 || frameInfo.rect.y < 0 || frameInfo.rect.x + frameInfo.rect.width > page.viewportWidth + 1 || frameInfo.rect.y + frameInfo.rect.height > page.viewportHeight + 1) {
          throw new Error("スクロール領域全体が画面に表示されるようにしてから撮影してください。");
        }
        if (!Number.isFinite(actualY) || (index > 0 && actualY <= previousY + 1)) {
          throw new Error("スクロール領域を縦にスクロールできませんでした。");
        }
        previousY = actualY;
        await delay(Math.max(scrollWaitMs, lastFrameCapturedAt ? 510 - (Date.now() - lastFrameCapturedAt) : 0, 0));
        throwIfCancelled(job);
        await assertTabStillActive(tab.id, tab.windowId);
        const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        lastFrameCapturedAt = Date.now();
        await assertTabStillActive(tab.id, tab.windowId);
        throwIfCancelled(job);
        const metrics = await executeInTab(tab.id, readScrollableAreaMetrics, [job.id]);
        if (!metrics) throw new Error("スクロール領域がページ内から見つかりません。もう一度選択してください。");
        await offscreenMessage({
          type: "add-frame",
          image,
          scrollY: actualY,
          pageHeight: frameInfo.scrollHeight,
          currentPageHeight: metrics.scrollHeight,
          crop: frameInfo.rect
        });
        if (index === 0) await executeInTab(tab.id, hideScrollableAreaSticky, [job.id]);
        throwIfCancelled(job);

        let latestMetrics = metrics;
        let bottom = Math.max(0, latestMetrics.scrollHeight - latestMetrics.clientHeight);
        if (actualY >= bottom - 1) {
          latestMetrics = await executeInTab(tab.id, waitForScrollableAreaStable, [job.id]);
          throwIfCancelled(job);
          bottom = Math.max(0, latestMetrics.scrollHeight - latestMetrics.clientHeight);
          if (actualY >= bottom - 1) {
            completed = true;
            break;
          }
        }

        targetY = Math.min(actualY + latestMetrics.clientHeight, bottom);
        if (targetY <= actualY + 1) {
          throw new Error("スクロール領域を縦にスクロールできませんでした。");
        }
      }
      if (!completed) { await offscreenMessage({ type: "trim-to-captured" }); reachedLimit = true; }
    } else {
      const page = await executeInTab(tab.id, readPageInfo);
      meta = { ...page, mode: options.mode };
      let region;
      if (options.mode === "region") {
        region = await executeInTab(tab.id, selectRegion, [kiriT("ドラッグして範囲を選択 · Escでキャンセル")]);
        if (!region) {
          const error = new Error("範囲選択をキャンセルしました。");
          error.name = "CaptureCancelled";
          throw error;
        }
        meta.region = region;
      }
      options.fileStem = makeFileStem(meta, options.filenamePattern);
      await offscreenMessage({ type: "begin", meta, options });
      job.offscreenStarted = true;
      await assertTabStillActive(tab.id, tab.windowId);
      const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      await assertTabStillActive(tab.id, tab.windowId);
      await offscreenMessage({ type: "add-frame", image, scrollY: 0 });
    }
  } finally {
    if (scrollAreaSelected) await executeInTab(tab.id, restoreScrollableArea, [job.id]).catch(() => undefined);
    if (manualHideRequested) await executeInTab(tab.id, restoreManualHiddenElements, [job.id]).catch(() => undefined);
    if (adFilterApplied) await executeInTab(tab.id, restoreAdFilter).catch(() => undefined);
    if (backToTopFilterRequested) await executeInTab(tab.id, restoreBackToTopButtons).catch(() => undefined);
  }

  throwIfCancelled(job);
  reportCapture(job, { phase: "processing" });
  if (options.preview !== false) {
    const preview = await offscreenMessage({ type: "preview" });
    try {
      throwIfCancelled(job);
      if (options.mode === "pagination") meta.paginationWarning = paginationWarning;
      const edited = await openCaptureEditor(job, options, preview.url, meta, preview);
      throwIfCancelled(job);
      if (edited.retry) {
        await offscreenMessage({ type: "discard" });
        job.offscreenStarted = false;
        return { retry: true, tab: edited.tab };
      }
      if (!edited.unchanged) await offscreenMessage({ type: "replace-image", url: edited.url });
    } finally {
      await offscreenMessage({ type: "release", urls: [preview.url] }).catch(() => undefined);
    }
  }
  throwIfCancelled(job);
  const artifact = await offscreenMessage({ type: "finish" });
  job.offscreenStarted = false;
  if (job.cancelRequested) {
    await offscreenMessage({ type: "release", urls: artifact.files.map((file) => file.url) }).catch(() => undefined);
    throwIfCancelled(job);
  }
  reportCapture(job, { phase: "saving", cancellable: false });
  const stem = options.fileStem;
  let copied = false;
  let saved = 0;

  if (options.destination === "copy" || options.destination === "both") {
    await offscreenMessage({ type: "copy", clipboard: artifact.clipboard });
    copied = true;
  }

  if (options.destination === "save" || options.destination === "both") {
    const folderPath = normalizeFolder(options.folder);
    for (const file of artifact.files) {
      const filename = [folderPath, `${stem}${file.suffix}`].filter(Boolean).join("/");
      const downloadId = await chrome.downloads.download({
        url: file.url,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });
      saved += 1;
      releaseUrlAfterDownload(downloadId, file.url);
    }
  } else {
    await offscreenMessage({ type: "release", urls: artifact.files.map((file) => file.url) });
  }

  return { message: successMessage(options, saved, copied) + (paginationWarning ? " · " + paginationWarning : "") + (reachedLimit ? " · " + kiriT("$1画面の上限まで撮影しました。続きは含まれていません。", maxFrames) : "") };
}

async function openCaptureEditor(job, options, previewUrl, meta, preview = null) {
  const choice = new Promise((resolve) => { job.editorResolve = resolve; });
  job.previewUrl = previewUrl;
  job.previewPages = options.mode === "pagination" ? { width: preview.width, height: preview.height, pageHeight: preview.pageHeight, count: Math.ceil(preview.height / preview.pageHeight) } : null;
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
    let saved = 0; let copied = false;
    if (options.destination === "copy" || options.destination === "both") { await offscreenMessage({ type: "copy", clipboard: artifact.clipboard }); copied = true; }
    if (options.destination === "save" || options.destination === "both") {
      const folder = normalizeFolder(options.folder);
      for (const file of artifact.files) {
        const filename = [folder, `${options.fileStem}${file.suffix}`].filter(Boolean).join("/");
        const downloadId = await chrome.downloads.download({ url: file.url, filename, conflictAction: "uniquify", saveAs: false });
        saved += 1; releaseUrlAfterDownload(downloadId, file.url);
      }
    } else await offscreenMessage({ type: "release", urls: artifact.files.map(file => file.url) });
    return successMessage(options, saved, copied);
  } catch (error) {
    await offscreenMessage({ type: "discard" }).catch(() => undefined);
    throw error;
  } finally { reportCapture(job, { active: false, cancellable: false }); if (activeCapture === job) activeCapture = null; }
}

async function runQuickCapture(tab, modeOverride) {
  if (!tab?.id) return;
  let captureStarted = false;
  try {
    const { captureSettings, siteCaptureSettings } = await chrome.storage.local.get(["captureSettings", "siteCaptureSettings"]);
    let host = null;
    try { const parsed = new URL(tab.url); if (["http:", "https:"].includes(parsed.protocol)) host = parsed.hostname.toLowerCase(); } catch (_) {}
    const siteSettings = host && siteCaptureSettings && Object.prototype.hasOwnProperty.call(siteCaptureSettings, host) ? siteCaptureSettings[host] : null;
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
      ...(captureSettings || {}),
      ...(siteSettings || {})
    };
    if (modeOverride) options.mode = modeOverride;
    captureStarted = true;
    const result = await startCapture(options, tab);
    setQuickFeedback(tab.id, "✓", `KiriTori: ${result.message}`, "#188038");
  } catch (error) {
    if (!captureStarted) await rememberFailure(error, { mode: modeOverride, phase: "preparing" });
    if (activeCapture?.tabId === tab.id) return;
    const cancelled = error?.name === "CaptureCancelled";
    setQuickFeedback(tab.id, cancelled ? "−" : "!", cancelled ? kiriT("KiriTori: 撮影をキャンセルしました") : `KiriTori: ${kiriT(describeFailure(error).reason)} ${kiriT("アイコンを開くと詳細を確認できます。")}`, cancelled ? "#5f6368" : "#d93025", cancelled ? 5000 : 30000);
  }
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
  if (contexts.length) return true;

  if (!offscreenCreation) {
    offscreenCreation = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD", "BLOBS"],
      justification: "画面画像の結合・形式変換と、ユーザーが選んだ場合のクリップボード書き込みに使います。"
    });
  }
  await offscreenCreation;
  offscreenCreation = undefined;
  return true;
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
    const onClick = event => {
      const element = event.target instanceof Element ? event.target.closest('button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"], [tabindex][aria-label]') : null;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!element) return;
      const parts = [];
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
        let position = 1;
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.tagName === node.tagName) position++;
        parts.unshift(`${node.localName}:nth-of-type(${position})`);
      }
      const label = (element.getAttribute("aria-label") || element.getAttribute("data-tooltip") || element.getAttribute("title") || element.textContent || element.value || "").trim().slice(0, 120);
      let fallback = null;
      for (const name of ["aria-label", "data-tooltip", "title"]) {
        const value = element.getAttribute(name);
        if (!value) continue;
        const candidate = `${element.localName}[${name}=${JSON.stringify(value)}]`;
        if (document.querySelectorAll(candidate).length === 1) { fallback = candidate; break; }
      }
      finish({ selector: parts.join(" > "), fallback, tag: element.localName, label });
    };
    globalThis.__kiritoriPaginationPicker = { jobId, cancel: () => finish(null) };
    document.addEventListener("click", onClick, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
  });
}

function cancelPaginationSelection(jobId) {
  if (globalThis.__kiritoriPaginationPicker?.jobId === jobId) globalThis.__kiritoriPaginationPicker.cancel();
}

function paginationSnapshot() {
  const root = document.body;
  const text = (root?.innerText || "").slice(0, 200000);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return { signature: `${location.href}|${text.length}|${hash >>> 0}`, ready: document.readyState === "complete" };
}

function clickPaginationButton(button) {
  const matches = element => {
    if (!element || element.localName !== button.tag) return false;
    const label = (element.getAttribute("aria-label") || element.getAttribute("data-tooltip") || element.getAttribute("title") || element.textContent || element.value || "").trim().slice(0, 120);
    return label === button.label;
  };
  let element;
  try {
    element = document.querySelector(button.selector);
    if (!matches(element) && button.fallback) {
      const candidates = document.querySelectorAll(button.fallback);
      element = candidates.length === 1 ? candidates[0] : null;
    }
  } catch (_) { return "missing"; }
  if (!matches(element)) return "missing";
  if (element.matches(":disabled, [disabled], [aria-disabled=true], .disabled") || element.closest('[aria-disabled="true"], [inert], .disabled') || !element.getClientRects().length || getComputedStyle(element).visibility !== "visible") return "end";
  if (element.localName === "a") {
    const href = element.getAttribute("href");
    if (element.target && element.target.toLowerCase() !== "_self") return "missing";
    if (href) { const url = new URL(href, location.href); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin) return "missing"; }
  }
  setTimeout(() => {
    if (!element.isConnected) return;
    const rect = element.getBoundingClientRect();
    const eventOptions = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    if (typeof PointerEvent === "function") element.dispatchEvent(new PointerEvent("pointerdown", { ...eventOptions, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
    if (!element.isConnected) return;
    element.dispatchEvent(new MouseEvent("mousedown", { ...eventOptions, buttons: 1, detail: 1 }));
    if (!element.isConnected) return;
    if (typeof PointerEvent === "function") element.dispatchEvent(new PointerEvent("pointerup", { ...eventOptions, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...eventOptions, buttons: 0, detail: 1 }));
    if (element.isConnected) element.dispatchEvent(new MouseEvent("click", { ...eventOptions, buttons: 0, detail: 1 }));
  }, 0);
  return "clicked";
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
    if (element.getAttribute("data-kiritori-manual-hide") === jobId) {
      if (record.hadMarker) element.setAttribute("data-kiritori-manual-hide", record.marker);
      else element.removeAttribute("data-kiritori-manual-hide");
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
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish(true); }
    else if (event.key === "Enter" && !shadow.activeElement) { event.preventDefault(); event.stopPropagation(); finish(false); }
    else if (event.key === "ArrowUp" && hovered?.parentElement && hovered.parentElement !== document.body && hovered.parentElement !== document.documentElement) {
      event.preventDefault(); event.stopPropagation(); parentHistory.push(hovered); showHighlight(hovered.parentElement);
    } else if (event.key === "ArrowDown" && parentHistory.length) {
      event.preventDefault(); event.stopPropagation(); showHighlight(parentHistory.pop());
    }
  }

  state.cancel = () => finish(true);
  state.restore = () => {
    if (!state.settled) finish(true);
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
    if (!element || !element.style) return;
    state.records.push({
      element,
      display: element.style.getPropertyValue("display"),
      priority: element.style.getPropertyPriority("display"),
      hadStyle: element.hasAttribute("style"),
      hadMarker: element.hasAttribute("data-kiritori-manual-hide"),
      marker: element.getAttribute("data-kiritori-manual-hide")
    });
    element.setAttribute("data-kiritori-manual-hide", jobId);
    element.style.setProperty("display", "none", "important");
    parentHistory = [];
    showHighlight(null);
    updateCount();
  });
  glass.addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    window.scrollBy({ left: event.deltaX * scale, top: event.deltaY * scale, behavior: "instant" });
    parentHistory = []; showHighlight(null);
  }, { passive: false });
  undo.addEventListener("click", () => { if (state.records.length) restoreRecord(state.records.pop()); updateCount(); });
  done.addEventListener("click", () => finish(false));
  cancel.addEventListener("click", () => finish(true));

  try {
    state.port = chrome.runtime.connect({ name: "kiritori-selector" });
    state.port.onDisconnect.addListener(() => { if (!state.settled) state.restore(); });
    state.port.postMessage({ type: "hello", jobId });
    state.timer = setInterval(() => { try { state.port.postMessage({ type: "heartbeat" }); } catch (_) { state.restore(); } }, 20_000);
  } catch (_) { state.restore(); }

  if (window.__kiritoriManualCancelJob === jobId) finish(true);
  return selection;
}

function cancelManualSelection(jobId) {
  window.__kiritoriManualCancelJob = jobId;
  if (window.__kiritoriManualHide?.jobId === jobId) window.__kiritoriManualHide.cancel();
  if (window.__kiritoriScrollSelector?.jobId === jobId) window.__kiritoriScrollSelector.cancel();
}

async function restoreStaleScrollAreaState() {
  if (window.__kiritoriScrollSelector?.cancel) {
    window.__kiritoriScrollSelector.cancel();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  const areaMarkerName = "data-kiritori-scroll-state";
  for (const element of document.querySelectorAll(`[${areaMarkerName}]`)) {
    let saved;
    try { saved = JSON.parse(element.getAttribute(areaMarkerName) || "null"); } catch (_) { continue; }
    if (saved?.owner !== "kiritori" || saved.version !== 1) continue;
    element.scrollTop = saved.originalTop;
    element.scrollLeft = saved.originalLeft;
    if (element.style.getPropertyValue("scroll-behavior") === "auto" && element.style.getPropertyPriority("scroll-behavior") === "important") {
      if (saved.scrollBehavior) element.style.setProperty("scroll-behavior", saved.scrollBehavior, saved.scrollPriority);
      else element.style.removeProperty("scroll-behavior");
      if (!saved.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    if (saved.previousMarker === null) element.removeAttribute(areaMarkerName);
    else element.setAttribute(areaMarkerName, saved.previousMarker);
  }
  const stickyMarkerName = "data-kiritori-scroll-sticky";
  for (const element of document.querySelectorAll(`[${stickyMarkerName}]`)) {
    let saved;
    try { saved = JSON.parse(element.getAttribute(stickyMarkerName) || "null"); } catch (_) { continue; }
    if (saved?.owner !== "kiritori" || saved.version !== 1) continue;
    if (element.style.getPropertyValue("visibility") === "hidden" && element.style.getPropertyPriority("visibility") === "important") {
      if (saved.visibility) element.style.setProperty("visibility", saved.visibility, saved.visibilityPriority);
      else element.style.removeProperty("visibility");
      if (!saved.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    if (saved.previousMarker === null) element.removeAttribute(stickyMarkerName);
    else element.setAttribute(stickyMarkerName, saved.previousMarker);
  }
  const interactionMarkerName = "data-kiritori-scroll-interaction";
  for (const style of document.querySelectorAll(`style[${interactionMarkerName}]`)) {
    let saved;
    try { saved = JSON.parse(style.getAttribute(interactionMarkerName) || "null"); } catch (_) { continue; }
    if (saved?.owner === "kiritori" && saved.version === 1) style.remove();
  }
  const staleCapture = window.__kiritoriScrollCapture;
  if (staleCapture) {
    const element = staleCapture.element;
    if (element?.isConnected && !element.hasAttribute(areaMarkerName)) {
      element.scrollTop = staleCapture.originalTop;
      element.scrollLeft = staleCapture.originalLeft;
      if (element.style.getPropertyValue("scroll-behavior") === "auto" && element.style.getPropertyPriority("scroll-behavior") === "important") {
        if (staleCapture.scrollBehavior) element.style.setProperty("scroll-behavior", staleCapture.scrollBehavior, staleCapture.scrollPriority);
        else element.style.removeProperty("scroll-behavior");
        if (!staleCapture.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
      }
    }
    delete window.__kiritoriScrollCapture;
  }
}

function selectScrollableArea(jobId, labels) {
  if (window.__kiritoriScrollSelector?.cancel) window.__kiritoriScrollSelector.cancel();
  const markerName = "data-kiritori-scroll-state";
  const stickyMarkerName = "data-kiritori-scroll-sticky";
  for (const element of document.querySelectorAll(`[${stickyMarkerName}]`)) {
    let saved;
    try { saved = JSON.parse(element.getAttribute(stickyMarkerName) || "null"); } catch (_) { continue; }
    if (saved?.owner !== "kiritori" || saved.version !== 1) continue;
    if (element.style.getPropertyValue("visibility") === "hidden" && element.style.getPropertyPriority("visibility") === "important") {
      if (saved.visibility) element.style.setProperty("visibility", saved.visibility, saved.visibilityPriority);
      else element.style.removeProperty("visibility");
      if (!saved.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    if (saved.previousMarker === null) element.removeAttribute(stickyMarkerName);
    else element.setAttribute(stickyMarkerName, saved.previousMarker);
  }
  const restoreMarkedArea = (element) => {
    let saved;
    try { saved = JSON.parse(element.getAttribute(markerName) || "null"); } catch (_) { return false; }
    if (saved?.owner !== "kiritori" || saved.version !== 1) return false;
    element.scrollTop = saved.originalTop;
    element.scrollLeft = saved.originalLeft;
    if (element.style.getPropertyValue("scroll-behavior") === "auto" && element.style.getPropertyPriority("scroll-behavior") === "important") {
      if (saved.scrollBehavior) element.style.setProperty("scroll-behavior", saved.scrollBehavior, saved.scrollPriority);
      else element.style.removeProperty("scroll-behavior");
      if (!saved.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    if (saved.previousMarker === null) element.removeAttribute(markerName);
    else element.setAttribute(markerName, saved.previousMarker);
    return true;
  };
  for (const element of document.querySelectorAll(`[${markerName}]`)) restoreMarkedArea(element);
  const staleCapture = window.__kiritoriScrollCapture;
  if (staleCapture) {
    const element = staleCapture.element;
    if (element?.isConnected && !restoreMarkedArea(element)) {
      element.scrollTop = staleCapture.originalTop;
      element.scrollLeft = staleCapture.originalLeft;
      if (element.style.getPropertyValue("scroll-behavior") === "auto" && element.style.getPropertyPriority("scroll-behavior") === "important") {
        if (staleCapture.scrollBehavior) element.style.setProperty("scroll-behavior", staleCapture.scrollBehavior, staleCapture.scrollPriority);
        else element.style.removeProperty("scroll-behavior");
        if (!staleCapture.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
      }
    }
    delete window.__kiritoriScrollCapture;
  }
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

    const state = { jobId, host, port: null, timer: null, settled: false, cancel: () => finish(null) };
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
        event.preventDefault(); event.stopPropagation(); finish(null);
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
      const previousMarker = element.getAttribute(markerName);
      element.setAttribute(markerName, JSON.stringify({
        owner: "kiritori", version: 1, originalTop, originalLeft,
        scrollBehavior, scrollPriority, hadStyle, previousMarker
      }));
      element.style.setProperty("scroll-behavior", "auto", "important");
      const captureState = { jobId, element, originalTop, originalLeft, scrollBehavior, scrollPriority, hadStyle, markerName };
      window.__kiritoriScrollCapture = captureState;
      element.scrollTop = 0;
      await finish(true);
    });
    cancel.addEventListener("click", () => finish(null));
    window.addEventListener("keydown", onKey, true);
    try {
      state.port = chrome.runtime.connect({ name: "kiritori-selector" });
      state.port.onDisconnect.addListener(() => { if (!state.settled) state.cancel(); });
      state.port.postMessage({ type: "hello", jobId });
      state.timer = setInterval(() => { try { state.port.postMessage({ type: "heartbeat" }); } catch (_) { state.cancel(); } }, 20_000);
    } catch (_) { state.cancel(); }
  });
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
    if ((position !== "fixed" && position !== "sticky") || element.hasAttribute(markerName)) continue;
    const saved = {
      owner: "kiritori", version: 1, jobId,
      visibility: element.style.getPropertyValue("visibility"),
      visibilityPriority: element.style.getPropertyPriority("visibility"),
      hadStyle: element.hasAttribute("style"),
      previousMarker: element.getAttribute(markerName)
    };
    element.setAttribute(markerName, JSON.stringify(saved));
    element.style.setProperty("visibility", "hidden", "important");
    hidden += 1;
  }
  return hidden;
}

function suppressScrollableAreaHover(jobId) {
  const state = window.__kiritoriScrollCapture;
  if (!state || state.jobId !== jobId || !state.element?.isConnected || state.interactionStyle) return false;
  const style = document.createElement("style");
  style.setAttribute("data-kiritori-scroll-interaction", JSON.stringify({ owner: "kiritori", version: 1, jobId }));
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
  const interactionMarkerName = "data-kiritori-scroll-interaction";
  for (const style of document.querySelectorAll(`style[${interactionMarkerName}]`)) {
    let saved;
    try { saved = JSON.parse(style.getAttribute(interactionMarkerName) || "null"); } catch (_) { continue; }
    if (saved?.owner === "kiritori" && saved.version === 1 && saved.jobId === jobId) style.remove();
  }
  const stickyMarkerName = "data-kiritori-scroll-sticky";
  for (const element of document.querySelectorAll(`[${stickyMarkerName}]`)) {
    let saved;
    try { saved = JSON.parse(element.getAttribute(stickyMarkerName) || "null"); } catch (_) { continue; }
    if (saved?.owner !== "kiritori" || saved.version !== 1 || saved.jobId !== jobId) continue;
    if (element.style.getPropertyValue("visibility") === "hidden" && element.style.getPropertyPriority("visibility") === "important") {
      if (saved.visibility) element.style.setProperty("visibility", saved.visibility, saved.visibilityPriority);
      else element.style.removeProperty("visibility");
      if (!saved.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    if (saved.previousMarker === null) element.removeAttribute(stickyMarkerName);
    else element.setAttribute(stickyMarkerName, saved.previousMarker);
  }
  const element = state.element;
  if (element?.isConnected) {
    element.scrollTop = state.originalTop;
    element.scrollLeft = state.originalLeft;
    if (element.style.getPropertyValue("scroll-behavior") === "auto" && element.style.getPropertyPriority("scroll-behavior") === "important") {
      if (state.scrollBehavior) element.style.setProperty("scroll-behavior", state.scrollBehavior, state.scrollPriority);
      else element.style.removeProperty("scroll-behavior");
      if (!state.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    if (state.markerName) {
      let saved;
      try { saved = JSON.parse(element.getAttribute(state.markerName) || "null"); } catch (_) {}
      if (saved?.owner === "kiritori" && saved.version === 1) {
        if (saved.previousMarker === null) element.removeAttribute(state.markerName);
        else element.setAttribute(state.markerName, saved.previousMarker);
      }
    }
  }
  delete window.__kiritoriScrollCapture;
  return true;
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
    if (element.hasAttribute("data-localcapture-ad-hidden")) return;
    if (!element.matches(selectorText) && !isNamedAd(element)) return;
    element.setAttribute("data-localcapture-ad-hidden", "1");
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
  for (const element of state.elements) element.removeAttribute("data-localcapture-ad-hidden");
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
      if ((position === "fixed" || position === "sticky") && !element.hasAttribute("data-localcapture-hidden")) {
        element.setAttribute("data-localcapture-hidden", "1");
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
    if ((position === "fixed" || position === "sticky") && !element.hasAttribute("data-localcapture-hidden")) {
      element.setAttribute("data-localcapture-hidden", "1");
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
  for (const element of state.hidden) element.removeAttribute("data-localcapture-hidden");
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

function makeFileStem(meta, pattern = "title-date", date = new Date()) {
  const sanitize = (value, maxBytes, fallback) => {
    const cleaned = String(value || "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
    const encoder = new TextEncoder();
    let result = "";
    for (const character of cleaned) {
      if (encoder.encode(result + character).length > maxBytes) break;
      result += character;
    }
    return result.replace(/[. ]+$/g, "") || fallback;
  };
  let host = "site";
  try { host = new URL(meta.url).hostname || host; } catch (_) {}
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
  if (/^クリップボードへのコピーに失敗しました/.test(message)) {
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
