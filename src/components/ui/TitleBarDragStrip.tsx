// macOS Overlay 標題列下，只有標了 data-tauri-drag-region 的地方能拖視窗。沒有站牌的畫面（首頁）
// 與蓋住站牌的全窗遮罩（對話框）要自己在頂端給一條拖曳帶，高度同站牌（v8 grid 的 60px 頂列），
// 否則視窗拖不動。deep = 子樹裡非互動的地方都能拖、雙擊 zoom（空元素時與無值相同）。
// 放在哪由呼叫端決定：父層要是定位元素，對話框裡要疊在 Dismiss 鈕上、卡片下
export function TitleBarDragStrip() {
  return <div data-tauri-drag-region="deep" className="absolute inset-x-0 top-0 h-[60px]" />;
}
