import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

type Tab = "changes" | "prs";

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "prs", label: "Pull Requests" },
];

/**
 * 右欄的 tabs（Phase 5c step 3，照基準 `activate()`）：tablist + 兩個 tab（roving tabIndex：Tab 鍵進來落在選中的
 * 那個）+ 兩個 tabpanel（`tabindex=-1`：Retry 之後焦點落在這裡，Q-F；`focusBack` 也靠 tabpanel 找回 tab）。
 * ←→ 換 tab、焦點跟著走、到頭繞回（選了就換，同基準）；換進來的那格重播 `.enter`，第一次畫不算。
 * 兩格一直掛著、藏起來用 `hidden`：PR 面板不 unmount（§4，換 tab 不重抓 GitHub）
 */
export function PaneTabs({ changes, prs }: { changes: ReactNode; prs: ReactNode }) {
  const [selected, setSelected] = useState<Tab>("changes");
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ changes: null, prs: null });
  const panelRefs = useRef<Record<Tab, HTMLDivElement | null>>({ changes: null, prs: null });
  // 比上一次選的那格，不用「第一次畫」旗標：StrictMode 開發時 effect 會跑兩次，旗標會讓開頭那格也重播
  const shown = useRef<Tab>(selected);

  useLayoutEffect(() => {
    if (shown.current === selected) return;
    shown.current = selected;
    const el = panelRefs.current[selected];
    if (!el) return;
    el.classList.remove("enter");
    void el.offsetWidth;
    el.classList.add("enter");
  }, [selected]);

  // 基準掛在 .tabs 上；按鍵只會落在有焦點的那顆 tab，掛在 tab 上一樣，tablist 也不用變成可聚焦（jsx-a11y）
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = TABS.findIndex((t) => tabRefs.current[t.id] === document.activeElement);
    if (i < 0) return;
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length].id;
    tabRefs.current[next]?.focus();
    setSelected(next);
  };

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Working tree and pull requests">
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            type="button"
            className="tab"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={selected === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={selected === t.id ? 0 : -1}
            onClick={() => setSelected(t.id)}
            onKeyDown={onKeyDown}
          >
            {t.label}
          </button>
        ))}
      </div>
      {TABS.map((t) => (
        <div
          key={t.id}
          ref={(el) => {
            panelRefs.current[t.id] = el;
          }}
          className="tabpanel"
          id={`panel-${t.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${t.id}`}
          tabIndex={-1}
          hidden={selected !== t.id}
        >
          {t.id === "changes" ? changes : prs}
        </div>
      ))}
    </>
  );
}
