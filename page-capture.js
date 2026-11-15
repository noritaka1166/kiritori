// These functions are serialized by chrome.scripting.executeScript.
// Each function must remain self-contained and use only its arguments and page globals.

export function scrollScrollableArea(jobId, y) {
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

export function readScrollableAreaMetrics(jobId) {
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

export function hideScrollableAreaSticky(jobId) {
  const state = window.__kiritoriScrollCapture;
  if (!state || state.jobId !== jobId || !state.element?.isConnected) return 0;
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

export function suppressScrollableAreaHover(jobId) {
  const state = window.__kiritoriScrollCapture;
  if (!state || state.jobId !== jobId || !state.element?.isConnected || state.interactionStyle) return false;
  const style = document.createElement("style");
  style.dataset.kiritoriScrollInteraction = JSON.stringify({ owner: "kiritori", version: 1, jobId });
  style.textContent = "body, body * { pointer-events: none !important; }";
  document.documentElement.appendChild(style);
  state.interactionStyle = style;
  return true;
}

export async function waitForScrollableAreaStable(jobId) {
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

export function restoreScrollableArea(jobId) {
  const state = window.__kiritoriScrollCapture;
  if (!state || state.jobId !== jobId) return false;
  if (state.interactionStyle?.isConnected) state.interactionStyle.remove();
  document.querySelectorAll("style[data-kiritori-scroll-interaction]").forEach(restoreInteractionStyle);
  document.querySelectorAll("[data-kiritori-scroll-sticky]").forEach(restoreStickyElement);
  restoreSelectedArea();
  delete window.__kiritoriScrollCapture;
  return true;

  function restoreInteractionStyle(style) {
    if (parseMarker(style, "kiritoriScrollInteraction", true)) style.remove();
  }

  function restoreStickyElement(element) {
    const saved = parseMarker(element, "kiritoriScrollSticky", true);
    if (!saved) return;
    if (element.style.getPropertyValue("visibility") === "hidden" && element.style.getPropertyPriority("visibility") === "important") {
      if (saved.visibility) element.style.setProperty("visibility", saved.visibility, saved.visibilityPriority);
      else element.style.removeProperty("visibility");
      if (!saved.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    if (saved.previousMarker === null) delete element.dataset.kiritoriScrollSticky;
    else element.dataset.kiritoriScrollSticky = saved.previousMarker;
  }

  function restoreSelectedArea() {
    const captureState = state;
    const element = captureState.element;
    if (!element?.isConnected) return;
    element.scrollTop = captureState.originalTop;
    element.scrollLeft = captureState.originalLeft;
    if (element.style.getPropertyValue("scroll-behavior") === "auto" && element.style.getPropertyPriority("scroll-behavior") === "important") {
      if (captureState.scrollBehavior) element.style.setProperty("scroll-behavior", captureState.scrollBehavior, captureState.scrollPriority);
      else element.style.removeProperty("scroll-behavior");
      if (!captureState.hadStyle && !element.getAttribute("style")?.trim()) element.removeAttribute("style");
    }
    if (!captureState.markerName) return;
    const saved = parseMarker(element, "kiritoriScrollState", false);
    if (!saved) return;
    if (saved.previousMarker === null) delete element.dataset.kiritoriScrollState;
    else element.dataset.kiritoriScrollState = saved.previousMarker;
  }

  function parseMarker(element, key, requireJob) {
    let saved;
    try {
      saved = JSON.parse(element.dataset[key] || "null");
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Ignore malformed marker data left by a page or an interrupted capture.
      return null;
    }
    if (saved?.owner !== "kiritori" || saved.version !== 1) return null;
    if (requireJob && saved.jobId !== jobId) return null;
    return saved;
  }
}
export function restoreManualHiddenElements(jobId) {
  if (window.__kiritoriManualHide?.jobId === jobId) window.__kiritoriManualHide.restore();
  if (window.__kiritoriManualCancelJob === jobId) delete window.__kiritoriManualCancelJob;
}

export async function hideBackToTopButtons() {
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

export function restoreBackToTopButtons() {
  const style = window.__localCaptureBackToTopStyle;
  if (!style) return;
  style.remove();
  delete window.__localCaptureBackToTopStyle;
}

export async function applyAdFilter() {
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

export function restoreAdFilter() {
  const state = window.__localCaptureAdFilter;
  if (!state) return false;
  state.observer.disconnect();
  for (const element of state.elements) delete element.dataset.localcaptureAdHidden;
  state.style.remove();
  delete window.__localCaptureAdFilter;
  return true;
}

export function selectRegion(hintText) {
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

export async function prepareFullPage() {
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

export async function scrollFullPage(y) {
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

export function readFullPageMetrics() {
  return {
    scrollY: window.scrollY,
    viewportHeight: document.documentElement.clientHeight,
    pageHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)
  };
}

export async function waitForPageHeightStable() {
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

export function restoreFullPage() {
  const state = window.__localCaptureState;
  if (!state) return false;
  for (const element of state.hidden) delete element.dataset.localcaptureHidden;
  state.style.remove();
  window.scrollTo(state.x, state.y);
  delete window.__localCaptureState;
  return true;
}

