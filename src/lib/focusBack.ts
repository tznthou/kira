/**
 * 焦點還給某個元素（站牌提示的 ×）：看得見就給它；看不見（所在的分頁藏起來了）就退回那個 tabpanel
 * 的 tab；都不行就不動。焦點落在看不見的元素上，鍵盤使用者就迷路了（Phase 5 計畫 5a step 4，G7）
 */
export function focusBack(el: HTMLElement | null): void {
  if (!el?.isConnected) return;
  if (visible(el)) {
    el.focus();
    return;
  }
  const panel = el.closest<HTMLElement>('[role="tabpanel"]');
  if (!panel?.id) return;
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (t) => t.getAttribute("aria-controls") === panel.id,
  );
  if (tab && visible(tab)) tab.focus();
}

/** `hidden` 屬性（藏起來的分頁）jsdom 也看得到；CSS 造成的看不見交給 checkVisibility（WebKit 有，jsdom 沒有） */
function visible(el: HTMLElement): boolean {
  if (el.closest("[hidden]")) return false;
  return typeof el.checkVisibility === "function" ? el.checkVisibility() : true;
}
