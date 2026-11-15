// These functions are serialized by chrome.scripting.executeScript.
// Each function must remain self-contained and use only its arguments and page globals.

// Executed in the page's isolated world. The overlay never receives pointer input.
export async function updateCountdownOverlay(jobId, remaining, label) {
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

export function selectPaginationButton(jobId, instruction, cancelText) {
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
      const target = event.target;
      if (!(target instanceof Element)) return;
      const element = target.closest('button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"], [tabindex][aria-label]');
      if (!element) return;
      const parts = [];
      for (let node = element; node?.nodeType === 1; node = node.parentElement) {
        if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
        const siblings = [...(node.parentElement?.children || [node])].filter(sibling => sibling.tagName === node.tagName);
        const position = siblings.indexOf(node) + 1;
        parts.unshift(`${node.localName}:nth-of-type(${position})`);
      }
      let fallback = null;
      for (const name of ["aria-label", "data-tooltip", "title"]) {
        const value = name === "data-tooltip" ? element.dataset.tooltip : element.getAttribute(name);
        if (!value) continue;
        const candidate = `${element.localName}[${name}=${JSON.stringify(value)}]`;
        if (document.querySelectorAll(candidate).length === 1) { fallback = candidate; break; }
      }
      const label = (element.getAttribute("aria-label") || element.dataset.tooltip || element.getAttribute("title") || element.textContent || element.value || "").trim().slice(0, 120);
      finish({ selector: parts.join(" > "), fallback, tag: element.localName, label });
    };
    globalThis.__kiritoriPaginationPicker = { jobId, cancel: () => finish(null) };
    document.addEventListener("click", onClick, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
  });
}

export function cancelPaginationSelection(jobId) {
  if (globalThis.__kiritoriPaginationPicker?.jobId === jobId) void globalThis.__kiritoriPaginationPicker.cancel();
}

export function paginationSnapshot() {
  const root = document.body;
  const text = (root?.innerText || "").slice(0, 200000);
  let hash = 2166136261;
  for (const character of text) hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  return { signature: `${location.href}|${text.length}|${hash >>> 0}`, ready: document.readyState === "complete" };
}

export function clickPaginationButton(button) {
  const findPaginationTarget = () => {
    try {
      const direct = document.querySelector(button.selector);
      if (direct && direct.localName === button.tag) {
        const label = (direct.getAttribute("aria-label") || direct.dataset.tooltip || direct.getAttribute("title") || direct.textContent || direct.value || "").trim().slice(0, 120);
        if (label === button.label) return direct;
      }
      if (!button.fallback) return null;
      const candidates = document.querySelectorAll(button.fallback);
      const fallback = candidates.length === 1 ? candidates[0] : null;
      if (!fallback || fallback.localName !== button.tag) return null;
      const label = (fallback.getAttribute("aria-label") || fallback.dataset.tooltip || fallback.getAttribute("title") || fallback.textContent || fallback.value || "").trim().slice(0, 120);
      return label === button.label ? fallback : null;
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "SyntaxError") throw error;
      // Page-provided selectors may become invalid after client-side navigation.
      return null;
    }
  };
  const element = findPaginationTarget();
  if (!element) return "missing";
  const isDisabledPaginationTarget = () => element.matches(":disabled, [disabled], [aria-disabled=true], .disabled") ||
    element.closest('[aria-disabled="true"], [inert], .disabled') ||
    !element.getClientRects().length ||
    getComputedStyle(element).visibility !== "visible";
  if (isDisabledPaginationTarget()) return "end";
  const hasSafePaginationLink = () => {
    if (element.localName !== "a") return true;
    if (element.target && element.target.toLowerCase() !== "_self") return false;
    const href = element.getAttribute("href");
    if (!href) return true;
    try {
      const url = new URL(href, location.href);
      return ["http:", "https:"].includes(url.protocol) && url.origin === location.origin;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      // Ignore malformed page-provided href values.
      return false;
    }
  };
  if (!hasSafePaginationLink()) return "missing";
  const dispatchPaginationClick = () => {
    if (!element.isConnected) return;
    const rect = element.getBoundingClientRect();
    const eventOptions = {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
    };
    if (typeof PointerEvent === "function") {
      element.dispatchEvent(new PointerEvent("pointerdown", { ...eventOptions, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
    }
    if (!element.isConnected) return;
    element.dispatchEvent(new MouseEvent("mousedown", { ...eventOptions, buttons: 1, detail: 1 }));
    if (!element.isConnected) return;
    if (typeof PointerEvent === "function") {
      element.dispatchEvent(new PointerEvent("pointerup", { ...eventOptions, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
    }
    element.dispatchEvent(new MouseEvent("mouseup", { ...eventOptions, buttons: 0, detail: 1 }));
    if (element.isConnected) element.dispatchEvent(new MouseEvent("click", { ...eventOptions, buttons: 0, detail: 1 }));
  };
  setTimeout(dispatchPaginationClick, 0);
  return "clicked";
}
export function readPageInfo() {
  return {
    title: document.title || "screenshot",
    url: location.href,
    viewportWidth: document.documentElement.clientWidth,
    viewportHeight: document.documentElement.clientHeight
  };
}

export async function selectElementsToHide(jobId, labels) {
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
    const scale = [1, 16, window.innerHeight][event.deltaMode] ?? 1;
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
    state.timer = setInterval(() => {
      try {
        state.port.postMessage({ type: "heartbeat" });
      } catch (error) {
        console.warn("手動選択用の拡張機能接続が切断されました。", error);
        state.restore();
      }
    }, 20_000);
  } catch (error) {
    // A missing extension connection means the picker can no longer be controlled.
    console.warn("手動選択用の拡張機能接続を初期化できませんでした。", error);
    state.restore();
  }

  if (window.__kiritoriManualCancelJob === jobId) void finish(true);
  return selection;
}

export function cancelManualSelection(jobId) {
  window.__kiritoriManualCancelJob = jobId;
  if (window.__kiritoriManualHide?.jobId === jobId) void window.__kiritoriManualHide.cancel();
  if (window.__kiritoriScrollSelector?.jobId === jobId) void window.__kiritoriScrollSelector.cancel();
}

export async function restoreStaleScrollAreaState() {
  const markerOwner = "kiritori";
  const markerVersion = 1;
  const emptyMarker = "null";
  if (window.__kiritoriScrollSelector?.cancel) {
    window.__kiritoriScrollSelector.cancel();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function restoreAreaMarkers() {
    document.querySelectorAll("[data-kiritori-scroll-state]").forEach(restoreAreaMarker);
  }

  function restoreAreaMarker(element) {
    const saved = parseSavedMarker(element.dataset.kiritoriScrollState);
    if (!saved) return;
    element.scrollTop = saved.originalTop;
    element.scrollLeft = saved.originalLeft;
    if (element.style.getPropertyValue("scroll-behavior") === "auto" && element.style.getPropertyPriority("scroll-behavior") === "important") {
      if (saved.scrollBehavior) element.style.setProperty("scroll-behavior", saved.scrollBehavior, saved.scrollPriority);
      else element.style.removeProperty("scroll-behavior");
      if (!saved.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    if (saved.previousMarker === null) delete element.dataset.kiritoriScrollState;
    else element.dataset.kiritoriScrollState = saved.previousMarker;
  }

  function restoreStickyMarkers() {
    document.querySelectorAll("[data-kiritori-scroll-sticky]").forEach(restoreStickyMarker);
  }

  function restoreStickyMarker(element) {
    const saved = parseSavedMarker(element.dataset.kiritoriScrollSticky);
    if (!saved) return;
    if (element.style.getPropertyValue("visibility") === "hidden" && element.style.getPropertyPriority("visibility") === "important") {
      if (saved.visibility) element.style.setProperty("visibility", saved.visibility, saved.visibilityPriority);
      else element.style.removeProperty("visibility");
      if (!saved.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    if (saved.previousMarker === null) delete element.dataset.kiritoriScrollSticky;
    else element.dataset.kiritoriScrollSticky = saved.previousMarker;
  }

  function restoreInteractionStyles() {
    document.querySelectorAll("style[data-kiritori-scroll-interaction]").forEach((style) => {
      const saved = parseSavedMarker(style.dataset.kiritoriScrollInteraction);
      if (saved) style.remove();
    });
  }

  function restoreStaleCapture() {
    const staleCapture = window.__kiritoriScrollCapture;
    if (!staleCapture) return;
    const element = staleCapture.element;
    if (element?.isConnected && !Object.hasOwn(element.dataset, "kiritoriScrollState")) {
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

  const parseSavedMarker = (value) => {
    try {
      const saved = JSON.parse(value || emptyMarker);
      return saved?.owner === markerOwner && saved.version === markerVersion ? saved : null;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Ignore malformed marker data left by a page or an interrupted capture.
      return null;
    }
  };

  restoreAreaMarkers();
  restoreStickyMarkers();
  restoreInteractionStyles();
  restoreStaleCapture();
}
export function selectScrollableArea(jobId, labels) {
  const markerOwner = "kiritori";
  const markerVersion = 1;
  const emptyMarker = "null";
  if (window.__kiritoriScrollSelector?.cancel) void window.__kiritoriScrollSelector.cancel();

  function restoreSelectionMarkers() {
    document.querySelectorAll("[data-kiritori-scroll-sticky]").forEach(restoreStickyMarker);
    document.querySelectorAll("[data-kiritori-scroll-state]").forEach(restoreAreaMarker);
    restoreStaleSelectionCapture();
  }

  function restoreStickyMarker(element) {
    const saved = parseMarker(element.dataset.kiritoriScrollSticky);
    if (!saved) return;
    if (element.style.getPropertyValue("visibility") === "hidden" && element.style.getPropertyPriority("visibility") === "important") {
      if (saved.visibility) element.style.setProperty("visibility", saved.visibility, saved.visibilityPriority);
      else element.style.removeProperty("visibility");
      if (!saved.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    if (saved.previousMarker === null) delete element.dataset.kiritoriScrollSticky;
    else element.dataset.kiritoriScrollSticky = saved.previousMarker;
  }

  function restoreAreaMarker(element) {
    const saved = parseMarker(element.dataset.kiritoriScrollState);
    if (!saved) return false;
    element.scrollTop = saved.originalTop;
    element.scrollLeft = saved.originalLeft;
    if (element.style.getPropertyValue("scroll-behavior") === "auto" && element.style.getPropertyPriority("scroll-behavior") === "important") {
      if (saved.scrollBehavior) element.style.setProperty("scroll-behavior", saved.scrollBehavior, saved.scrollPriority);
      else element.style.removeProperty("scroll-behavior");
      if (!saved.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    if (saved.previousMarker === null) delete element.dataset.kiritoriScrollState;
    else element.dataset.kiritoriScrollState = saved.previousMarker;
    return true;
  }

  function restoreStaleSelectionCapture() {
    const staleCapture = window.__kiritoriScrollCapture;
    if (!staleCapture) return;
    const element = staleCapture.element;
    if (element?.isConnected && !restoreAreaMarker(element)) {
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

  const parseMarker = (value) => {
    let saved;
    try {
      saved = JSON.parse(value || emptyMarker);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Ignore malformed marker data left by a page or an interrupted capture.
      return null;
    }
    if (saved?.owner !== markerOwner || saved.version !== markerVersion) return null;
    return saved;
  };

  restoreSelectionMarkers();
  return createScrollableAreaPicker(jobId, labels);

  function createScrollableAreaPicker(jobId, labels) {
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
        await new Promise((done) => requestAnimationFrame(done));
        await new Promise((done) => requestAnimationFrame(done));
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
        state.port.onDisconnect.addListener(() => { if (!state.settled) state.cancel(); });
        state.port.postMessage({ type: "hello", jobId });
        state.timer = setInterval(() => { try { state.port.postMessage({ type: "heartbeat" }); } catch (_) { state.cancel(); } }, 20_000);
      } catch (error) {
        // A connection setup failure leaves the picker uncontrollable, so cancel it and log the cause.
        state.cancel();
        console.warn("Could not initialize the scroll area picker connection; cancelling the picker.", error);
      }
    });
  }
}

export function getPaginationAreaLocator(jobId) {
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

export function activatePaginationArea(jobId, locator) {
  let el;
  const matches = element => element instanceof HTMLElement && element.localName === locator.tag && (!locator.id || element.id === locator.id) && (!locator.label || element.getAttribute("aria-label") === locator.label) && (locator.classes || []).every(name => element.classList.contains(name));
  try {
    el = document.querySelector(locator.selector);
    if (!matches(el) && locator.fallback) {
      const candidates = document.querySelectorAll(locator.fallback);
      el = candidates.length === 1 ? candidates[0] : null;
    }
  } catch (error) {
    if (error?.name !== "SyntaxError") throw error;
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

