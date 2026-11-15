// The arrays keep the same representation used by persisted drafts.
export function appendHistory(history, next) {
  history.push(next);
  return [];
}

export function navigateHistoryStacks(history, redoStack, direction) {
  if (direction === "undo" && history.length > 1) redoStack.push(history.pop());
  else if (direction === "redo" && redoStack.length) history.push(redoStack.pop());
}

export function historyForDraft(history, inlineEdit, text) {
  const saved = structuredClone(history);
  if (!inlineEdit) return saved;
  const value = text.trim().slice(0, 200);
  const operations = saved[saved.length - 1].operations;
  if (inlineEdit.index === null && value) operations.push({ ...inlineEdit.item, text: value });
  else if (inlineEdit.index !== null && operations[inlineEdit.index]) {
    if (value) operations[inlineEdit.index].text = value;
    else operations.splice(inlineEdit.index, 1);
  }
  return saved;
}
