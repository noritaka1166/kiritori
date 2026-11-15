export function shouldShowCaptureProgress(captureStatus) {
  const progressModes = ["full", "scroll-area", "pagination"];
  const progressPhases = ["editing", "selecting", "countdown"];
  return Boolean(captureStatus?.active) && (progressModes.includes(captureStatus.mode) || progressPhases.includes(captureStatus.phase));
}

export function getProgressMessage(captureStatus, kiriT) {
  if (captureStatus.cancelRequested || captureStatus.phase === "cancelling") return kiriT("撮影をキャンセルしています…");
  if (captureStatus.phase === "countdown") return kiriT("$1秒後に撮影を開始します…", captureStatus.countdownRemaining);
  if (captureStatus.phase === "selecting") return getSelectionMessage(captureStatus.selectionKind, kiriT);
  if (captureStatus.phase === "editing") return kiriT("プレビュー画面で画像を確認・編集してください。");
  if (captureStatus.phase === "processing") return kiriT("$1画面を撮影し、画像をまとめています…", captureStatus.currentFrame);
  if (captureStatus.phase === "saving") return kiriT("撮影した画像を出力しています…");
  if (captureStatus.currentFrame > 0) return getFrameProgressMessage(captureStatus, kiriT);
  return kiriT("撮影を準備しています…");
}

function getSelectionMessage(selectionKind, kiriT) {
  const messages = {
    pagination: "ページ上の「次へ」ボタンを選んでください。",
    "scroll-area": "ページ内の表など、縦にスクロールする領域を選んでください。"
  };
  return kiriT(messages[selectionKind] || "ページ上で隠す要素を選び、「選択完了」を押してください。");
}

function getFrameProgressMessage(captureStatus, kiriT) {
  if (captureStatus.mode === "pagination") return kiriT("現在$1ページ目を撮影中…", captureStatus.currentFrame);
  return kiriT("現在$1画面目を撮影中…", captureStatus.currentFrame);
}

