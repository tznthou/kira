(() => {
  // 現在的 app（fidelity 入口）：4b 起開 repo 就選 HEAD（同基準），確認選的就是 HEAD 那一列，
  // diff 區才跟基準一樣顯示 HEAD commit 的改動。HEAD 認列表的朗讀（rowRefs / 基準 spokenRefs 同格式）
  const sel = document.querySelector('.graph [role="option"][aria-selected="true"]');
  if (!sel) return "no selected row";
  const label = sel.getAttribute("aria-label") || "";
  return /\(HEAD\)|HEAD \(detached\)/.test(label) ? `head selected: ${label}` : `not HEAD: ${label}`;
})()
