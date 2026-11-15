export function validateScrollableAreaBounds(area, page, missingMessage = "スクロール領域がページ内から見つかりません。もう一度選択してください。") {
  if (!area) throw new Error(missingMessage);
  const outsideViewport = area.rect.x < 0 || area.rect.y < 0 ||
    area.rect.x + area.rect.width > page.viewportWidth + 1 ||
    area.rect.y + area.rect.height > page.viewportHeight + 1;
  if (outsideViewport) throw new Error("スクロール領域全体が画面に表示されるようにしてから撮影してください。");
}

export function validatePaginatedScrollPosition(actualY, previousY, index) {
  if (Number.isFinite(actualY) && (index === 0 || actualY > previousY + 1)) return;
  throw new Error("ページを縦にスクロールできませんでした。表示範囲か選択範囲で撮影してください。");
}

