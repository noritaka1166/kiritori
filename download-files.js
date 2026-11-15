// Listen before starting the download, then check its current state to close the
// gap between download() resolving and receiving its completion notification.
export async function downloadFile(downloads, options) {
  let id;
  let resolveEvent;
  const earlyStates = new Map();
  const completion = new Promise(resolve => { resolveEvent = resolve; });
  const listener = delta => {
    const state = delta.state?.current;
    if (state !== "complete" && state !== "interrupted") return;
    const result = { state, error: delta.error?.current };
    if (id === undefined) earlyStates.set(delta.id, result);
    else if (delta.id === id) resolveEvent(result);
  };
  downloads.onChanged.addListener(listener);
  try {
    id = await downloads.download(options);
    const early = earlyStates.get(id);
    const items = await downloads.search({ id });
    const item = items[0];
    if (!item) throw new Error("ダウンロードの状態を確認できませんでした。");
    const result = early || (item.state === "complete" || item.state === "interrupted" ? item : await completion);
    if (result.state !== "complete") throw new Error(`ダウンロードに失敗しました。${result.error ? ` (${result.error})` : ""}`);
  } finally {
    downloads.onChanged.removeListener(listener);
  }
}
