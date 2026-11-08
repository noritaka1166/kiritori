kiriLocalizeDocument();
const jobId = new URLSearchParams(location.search).get("job");
const pages = document.querySelector("#pages");
const status = document.querySelector("#status");
const warning = document.querySelector("#warning");
const save = document.querySelector("#save");
const cancel = document.querySelector("#cancel");
const previous = document.querySelector("#previous");
const next = document.querySelector("#next");
const single = document.querySelector("#single");
const stacked = document.querySelector("#stacked");
const pager = document.querySelector("#pager");
const counter = document.querySelector("#counter");
let port, heartbeat, data, current = 0, mode = "single", submitted = false, terminal = false;

function render() {
  if (!data) return;
  single.setAttribute("aria-pressed", String(mode === "single"));
  stacked.setAttribute("aria-pressed", String(mode === "stacked"));
  pager.hidden = mode !== "single";
  previous.disabled = current === 0;
  next.disabled = current >= data.pagination.count - 1;
  counter.textContent = `${current + 1} / ${data.pagination.count}`;
  const indices = mode === "single" ? [current] : Array.from({ length: data.pagination.count }, (_, index) => index);
  const fragment = document.createDocumentFragment();
  for (const index of indices) {
    const figure = document.createElement("figure"); figure.className = "page";
    const caption = document.createElement("figcaption"); caption.textContent = kiriT("$1ページ目", index + 1);
    const viewport = document.createElement("div"); viewport.className = "page-window";
    viewport.style.aspectRatio = `${data.pagination.width} / ${data.pagination.pageHeight}`;
    const image = document.createElement("img"); image.src = data.url; image.alt = kiriT("$1ページ目", index + 1);
    image.style.top = `${-index * 100}%`;
    viewport.append(image); figure.append(caption, viewport); fragment.append(figure);
  }
  pages.replaceChildren(fragment);
}

single.addEventListener("click", () => { mode = "single"; render(); });
stacked.addEventListener("click", () => { mode = "stacked"; render(); });
previous.addEventListener("click", () => { current = Math.max(0, current - 1); render(); });
next.addEventListener("click", () => { if (data) { current = Math.min(data.pagination.count - 1, current + 1); render(); } });
save.addEventListener("click", async () => {
  if (!data || submitted || terminal) return;
  submitted = true; save.disabled = true; cancel.disabled = true;
  status.textContent = kiriT("撮影した画像を出力しています…");
  try {
    const response = await chrome.runtime.sendMessage({ type: "capture:pagination:accept", jobId });
    if (!response?.ok) throw new Error(response?.error || kiriT("画像を出力できませんでした。"));
  } catch (error) {
    submitted = false; save.disabled = false; cancel.disabled = false;
    status.textContent = kiriT(error?.message || "画像を出力できませんでした。");
  }
});
cancel.addEventListener("click", async () => {
  if (terminal) {
    if (Number.isInteger(data?.sourceTabId)) {
      try {
        const source = await chrome.tabs.update(data.sourceTabId, { active: true });
        if (source?.windowId != null) await chrome.windows.update(source.windowId, { focused: true });
      } catch (_) { /* The source tab may have been closed. */ }
    }
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id) await chrome.tabs.remove(tab.id);
      else window.close();
    } catch (_) { window.close(); }
    return;
  }
  cancel.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "capture:cancel", jobId });
    if (!response?.ok) throw new Error(response?.error || kiriT("キャンセルできませんでした。"));
  } catch (error) { cancel.disabled = false; status.textContent = kiriT(error?.message || "キャンセルできませんでした。"); }
});
chrome.runtime.onMessage.addListener(message => {
  const state = message?.type === "capture:progress" && message.status;
  if (!state || state.jobId !== jobId || state.active) return;
  terminal = true; clearInterval(heartbeat); save.disabled = true; cancel.disabled = false;
  cancel.textContent = kiriT("閉じる");
  status.textContent = state.message || (state.phase === "completed" ? kiriT("出力しました。") : kiriT("撮影を終了しました。"));
});
window.addEventListener("beforeunload", () => clearInterval(heartbeat));
async function initialize() {
  if (!jobId) throw new Error(kiriT("編集する画像が見つかりません。"));
  port = chrome.runtime.connect({ name: "kiritori-editor" });
  port.onDisconnect.addListener(() => {
    if (terminal) return;
    terminal = true; clearInterval(heartbeat); save.disabled = true; cancel.disabled = false; cancel.textContent = kiriT("閉じる");
    status.textContent = kiriT("プレビューの接続が切れました。もう一度撮影してください。");
  });
  port.postMessage({ type: "hello", jobId });
  heartbeat = setInterval(() => { try { port.postMessage({ type: "heartbeat" }); } catch (_) {} }, 20_000);
  const response = await chrome.runtime.sendMessage({ type: "capture:editor:load", jobId });
  if (!response?.ok || !response.pagination?.count || !response.pagination.pageHeight || !response.pagination.width) throw new Error(response?.error || kiriT("画像を読み込めませんでした。"));
  const image = new Image(); image.src = response.url; await image.decode();
  if (terminal) return;
  data = response;
  if (response.meta?.paginationWarning) { warning.textContent = response.meta.paginationWarning; warning.hidden = false; }
  status.textContent = kiriT("画像を確認して保存してください。");
  save.disabled = false; render();
}
initialize().catch(error => {
  status.textContent = kiriT(error?.message || "画像を読み込めませんでした。");
  terminal = true; clearInterval(heartbeat); cancel.disabled = false; cancel.textContent = kiriT("閉じる");
  if (jobId) chrome.runtime.sendMessage({ type: "capture:cancel", jobId }).catch(() => undefined);
});
