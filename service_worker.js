import "./i18n.js";

let offscreenCreation;
let activeCapture = null;
let lastCaptureStatus = null;
let captureRevision = 0;
const badgeTimers = new Map();
const failureHistoryKey = "captureFailureHistory";
let failureHistoryWrite = Promise.resolve();

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
  if (message?.type === "capture:editor:load" || message?.type === "capture:editor:commit") {
    const job = activeCapture;
    const validSender = sender?.url?.startsWith(chrome.runtime.getURL("editor.html")) && sender.tab?.id;
    if (!job || job.id !== message.jobId || job.phase !== "editing" || !validSender ||
        (job.editorTabId && sender.tab.id !== job.editorTabId)) {
      sendResponse({ ok: false, error: kiriT("編集する画像が見つかりません。") });
      return false;
    }
    job.editorTabId = sender.tab.id;
    if (message.type === "capture:editor:load") {
      sendResponse({ ok: true, url: job.previewUrl, format: job.editorOptions.format, destination: job.editorOptions.destination });
      return false;
    }
    if (job.editorCommitted || typeof message.url !== "string" || !message.url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) {
      sendResponse({ ok: false, error: kiriT("編集画像を受け取れませんでした。") });
      return false;
    }
    job.editorCommitted = true;
    reportCapture(job, { phase: "processing", cancellable: false });
    job.editorResolve?.({ url: message.url });
    sendResponse({ ok: true });
    return false;
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
  port.onMessage.addListener((message) => {
    if (message?.type === "hello" && activeCapture?.id === message.jobId) linkedJob = activeCapture;
  });
  port.onDisconnect.addListener(() => {
    if (linkedJob && activeCapture === linkedJob && linkedJob.phase === "editing" && !linkedJob.editorCommitted) {
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
  });
}
chrome.runtime.onInstalled.addListener(registerContextMenus);
chrome.runtime.onStartup.addListener(registerContextMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const modeByMenuId = {
    "local-capture-viewport": "viewport",
    "local-capture-region": "region",
    "local-capture-full": "full"
  };
  const mode = modeByMenuId[info.menuItemId];
  if (!mode || !tab?.id) return;
  await runQuickCapture(tab, mode);
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
  if (job.mode === "full" && job.tabId) {
    const text = job.active ? (job.currentFrame ? String(job.currentFrame) : "…") : "";
    chrome.action.setBadgeText({ text, tabId: job.tabId }).catch(() => undefined);
    chrome.action.setBadgeBackgroundColor({ color: "#1a73e8", tabId: job.tabId }).catch(() => undefined);
    const description = job.cancelRequested ? kiriT("撮影をキャンセル中") : job.phase === "selecting" ? kiriT("隠す要素を選択中") : job.phase === "editing" ? kiriT("プレビューで編集中") : job.phase === "processing" ? kiriT("画像をまとめています") : job.phase === "saving" ? kiriT("画像を出力中") : job.currentFrame ? kiriT("$1画面目を撮影中", job.currentFrame) : kiriT("撮影を準備中");
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
    cancellable: options?.mode === "full", cancelRequested: false,
    tabId: targetTab?.id, offscreenStarted: false, revision: 0
  };
  activeCapture = job;
  if (job.tabId && badgeTimers.has(job.tabId)) {
    clearTimeout(badgeTimers.get(job.tabId));
    badgeTimers.delete(job.tabId);
  }
  reportCapture(job);
  try {
    const result = await handleCapture(options, targetTab, job);
    reportCapture(job, { active: false, phase: "completed", cancellable: false, message: result.message });
    return result;
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
  if (!options || !["viewport", "region", "full"].includes(options.mode)) {
    throw new Error("撮影範囲を選び直してください。");
  }
  if (!["png", "jpeg", "pdf", "md"].includes(options.format)) {
    throw new Error("出力形式を選び直してください。");
  }
  if (!["save", "copy", "both"].includes(options.destination)) {
    throw new Error("出力先を選び直してください。");
  }
  if (options.format === "pdf" && options.destination !== "save") {
    throw new Error("PDFはファイル保存のみ対応しています。");
  }

  const tabs = targetTab ? [] : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = targetTab || tabs[0];
  if (!tab?.id || !tab.windowId) throw new Error("撮影するChromeタブが見つかりません。");
  job.tabId = tab.id;
  if (badgeTimers.has(tab.id)) {
    clearTimeout(badgeTimers.get(tab.id));
    badgeTimers.delete(tab.id);
  }
  reportCapture(job);
  throwIfCancelled(job);

  await ensureOffscreenDocument();
  throwIfCancelled(job);
  let meta;
  let adFilterApplied = false;
  let backToTopFilterRequested = false;
  let manualHideRequested = false;

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
      reportCapture(job, { phase: "preparing", cancellable: options.mode === "full" });
    }

    if (options.mode === "full") {
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
        for (let index = 0; index < 80; index += 1) {
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
          if (index > 0) await delay(600);
          throwIfCancelled(job);
          await assertTabStillActive(tab.id, tab.windowId);
          const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
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
        if (!completed) throw new Error("ページが長すぎて一度に撮影できません（80画面まで）。");
      } finally {
        await executeInTab(tab.id, restoreFullPage).catch(() => undefined);
      }
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
      const edited = await openCaptureEditor(job, options, preview.url);
      throwIfCancelled(job);
      await offscreenMessage({ type: "replace-image", url: edited.url });
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

  return { message: successMessage(options, saved, copied) };
}

async function openCaptureEditor(job, options, previewUrl) {
  const choice = new Promise((resolve) => { job.editorResolve = resolve; });
  job.previewUrl = previewUrl;
  job.editorOptions = { format: options.format, destination: options.destination };
  job.editorCommitted = false;
  reportCapture(job, { phase: "editing", cancellable: true });
  const editorTab = await chrome.tabs.create({ url: `${chrome.runtime.getURL("editor.html")}?job=${encodeURIComponent(job.id)}` });
  job.editorTabId = editorTab.id;
  reportCapture(job);
  if (job.cancelRequested) job.editorResolve(null);
  const result = await choice;
  job.editorResolve = null;
  throwIfCancelled(job);
  if (!result?.url) throw new Error("編集した画像を受け取れませんでした。");
  return result;
}

async function runQuickCapture(tab, modeOverride) {
  if (!tab?.id) return;
  let captureStarted = false;
  try {
    const { captureSettings } = await chrome.storage.local.get("captureSettings");
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
      ...(captureSettings || {})
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
  if (/ページが長すぎ|ページ画像が大きすぎ|編集画像が大きすぎ/i.test(message)) {
    return { reason: "ページまたは画像が大きすぎます。", advice: "表示中の範囲や選択範囲で分けて撮影してください。全ページ撮影は最大80画面・8,000万画素です。" };
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
    mode: ["viewport", "region", "full"].includes(context.mode) ? context.mode : null,
    phase: ["preparing", "selecting", "capturing", "processing", "editing", "saving"].includes(context.phase) ? context.phase : null,
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
