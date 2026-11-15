// Restore the source when possible, then close the editor or preview tab.
export async function closeCaptureView(sourceTabId) {
  if (Number.isInteger(sourceTabId)) {
    try {
      const source = await chrome.tabs.update(sourceTabId, { active: true });
      if (source?.windowId != null) await chrome.windows.update(source.windowId, { focused: true });
    } catch (_) {
      // The source tab or window may already have been closed.
    }
  }
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) await chrome.tabs.remove(tab.id);
    else window.close();
  } catch (error) {
    console.warn("タブを閉じられないため、ウィンドウを閉じます。", error);
    window.close();
  }
}
