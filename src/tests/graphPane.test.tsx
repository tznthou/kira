import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { GraphPane } from "@/components/Graph/GraphPane";
import { computeRoutes } from "@/lib/routeMap";
import { useGraphStore } from "@/stores/graphStore";
import type { CommitNode, GraphData, HeadInfo } from "@/lib/tauri";

// 路線圖的互動（Phase 4 計畫 §3 PR 4b step 3；基準 select / keydown / tooltip）：點選、鍵盤、
// Esc 之後的 tab stop、tooltip 的計時與隱藏、漣漪只在 HEAD 換了時重播

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
const ids = ["d", "c", "b", "a"].map((ch) => ch.repeat(40));
const [D, C, B, A] = ids;
const TIME = 1_759_478_520; // 2025-10-03 前後；期望值用本地時間的 getter 組，不依賴時區

const node = (oid: string, parents: string[], message = `feat: commit ${oid.slice(0, 7)}`): CommitNode => ({
  oid: oid.slice(0, 7),
  full_oid: oid,
  message,
  author: { name: "Kira Author", email: "k@example.com", timestamp: TIME },
  parents,
  refs: [],
});

const graphOf = (head: HeadInfo = { oid: D, branch: "main" }): GraphData => ({
  commits: [node(D, [C], "feat(graph): the newest\n\nbody"), node(C, [B]), node(B, [A]), node(A, [])],
  branches: [{ name: "main", target: D, is_remote: false, upstream: null, name_on_remote: null }],
  tags: [],
  truncated: false,
  head,
  default_branch: null,
});

function renderPane(graph = graphOf()) {
  const ui = (g: GraphData) => (
    <section className="graph-pane">
      <GraphPane graph={g} routes={computeRoutes(g)} repoId={REPO} />
    </section>
  );
  const view = render(ui(graph));
  return { ...view, rerenderWith: (g: GraphData) => view.rerender(ui(g)) };
}

const row = (c: HTMLElement, oid: string) => c.querySelector<HTMLElement>(`[data-oid="${oid}"]`)!;
const selected = () => useGraphStore.getState().selectedCommit?.full_oid ?? null;
const tabStops = (c: HTMLElement) =>
  [...c.querySelectorAll<HTMLElement>('[role="option"]')].filter((r) => r.tabIndex === 0).map((r) => r.dataset.oid);
const tip = (c: HTMLElement) => c.querySelector<HTMLElement>(".tip")!;

describe("GraphPane: selecting", () => {
  beforeEach(() => {
    useGraphStore.setState({ graphData: null, selectedCommit: null, repoId: REPO });
  });
  afterEach(() => cleanup());

  it("test_graphPane_nothingSelected_firstRowIsTheTabStop", () => {
    const { container } = renderPane();
    expect(tabStops(container)).toEqual([D]);
  });

  it("test_graphPane_click_selectsAndFocusesTheRow", () => {
    const { container } = renderPane();
    fireEvent.click(row(container, B));
    expect(selected()).toBe(B);
    expect(document.activeElement).toBe(row(container, B));
    expect(row(container, B).getAttribute("aria-selected")).toBe("true");
    expect(tabStops(container)).toEqual([B]);
  });

  it("test_graphPane_keys_moveTheSelection", () => {
    const { container } = renderPane();
    fireEvent.click(row(container, C));
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });

    press("ArrowDown");
    expect([selected(), document.activeElement]).toEqual([B, row(container, B)]);
    press("ArrowUp");
    press("ArrowUp");
    expect(selected()).toBe(D);
    press("ArrowUp"); // 第一列再往上不動
    expect(selected()).toBe(D);
    press("End");
    expect([selected(), document.activeElement]).toEqual([A, row(container, A)]);
    press("ArrowDown"); // 最後一列再往下不動
    expect(selected()).toBe(A);
    press("Home");
    expect(selected()).toBe(D);
  });

  // 基準漏洞的修正（計畫 §2.9）：Esc 清掉選取，焦點那列仍是 tab stop；Enter / Space 再選回來
  it("test_graphPane_escape_clearsTheSelectionButKeepsTheFocusedRowAsTheTabStop", () => {
    const { container } = renderPane();
    fireEvent.click(row(container, B));

    fireEvent.keyDown(row(container, B), { key: "Escape" });

    expect(selected()).toBeNull();
    expect(container.querySelector('[aria-selected="true"]')).toBeNull();
    expect(document.activeElement).toBe(row(container, B));
    expect(tabStops(container)).toEqual([B]);

    fireEvent.keyDown(row(container, B), { key: " " });
    expect(selected()).toBe(B);
    fireEvent.keyDown(row(container, B), { key: "Escape" });
    fireEvent.keyDown(row(container, B), { key: "Enter" });
    expect(selected()).toBe(B);
  });

  // 按住方向鍵的自動重複另外標起來：diff 區對大 diff 等放開才畫（DiffViewer），小 diff 照樣即時預覽
  it("test_graphPane_heldArrowKey_marksTheSelectionAsAutoRepeat", () => {
    const { container } = renderPane();
    const fromRepeat = () => useGraphStore.getState().selectionFromRepeat;
    fireEvent.click(row(container, D));
    expect(fromRepeat()).toBe(false);
    fireEvent.keyDown(row(container, D), { key: "ArrowDown", repeat: true });
    expect([selected(), fromRepeat()]).toEqual([C, true]);
    fireEvent.keyDown(row(container, C), { key: "ArrowDown" });
    expect([selected(), fromRepeat()]).toEqual([B, false]);
    fireEvent.keyDown(row(container, B), { key: "ArrowDown", repeat: true });
    fireEvent.click(row(container, D));
    expect([selected(), fromRepeat()]).toEqual([D, false]);
  });

  it("test_graphPane_selectionRing_followsTheSelectedStation", () => {
    const { container } = renderPane();
    const ring = () => container.querySelector("svg.lanes > g:last-child circle");
    expect(ring()).toBeNull();
    fireEvent.click(row(container, D));
    // HEAD 的金箔外圈比較大
    expect(ring()?.getAttribute("r")).toBe("12.5");
    fireEvent.click(row(container, C));
    expect(ring()?.getAttribute("r")).toBe("9.5");
  });
});

describe("GraphPane: the station board (tooltip)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useGraphStore.setState({ graphData: null, selectedCommit: null, repoId: REPO });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const hover = (el: HTMLElement) => fireEvent.mouseOver(el);
  const shown = (c: HTMLElement) => tip(c).classList.contains("show");

  it("test_graphPane_hover_showsTheBoardAfter300ms", () => {
    const { container } = renderPane();
    hover(row(container, D));
    act(() => vi.advanceTimersByTime(299));
    expect(shown(container)).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(shown(container)).toBe(true);

    const d = new Date(TIME * 1000);
    const p = (n: number) => String(n).padStart(2, "0");
    const date = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    expect(tip(container).querySelector(".tip-subject")?.textContent).toBe("feat(graph): the newest");
    expect([...tip(container).querySelectorAll("dd")].map((dd) => dd.textContent)).toEqual(["Kira Author", date, D]);
    // 頂條是那站的線色
    expect(tip(container).style.getPropertyValue("--tl")).toBe("var(--l-trunk)");
  });

  it("test_graphPane_hugeSubject_entersTheDomCappedNotWhole", () => {
    // 舊 graph 把訊息截在 50 字；v8 交給 CSS 的省略號，repo 裡的超長訊息就會整段進 DOM，每列三份（文字、aria-label、站牌）。
    // 上限 1000 個 UTF-16 單位，畫面上看不出來（列尾省略號、站牌最多 4 行）；跨在上限上的代理對整個不要
    const huge = "x".repeat(999) + "\u{1F600}" + "y".repeat(1_000_000);
    const g = graphOf();
    g.commits[1] = node(C, [B], huge);
    const { container } = renderPane(g);
    const kept = "x".repeat(999);
    expect(row(container, C).querySelector(".subject")?.textContent).toBe(kept);
    expect(row(container, C).getAttribute("aria-label")).toBe(`Commit ${C.slice(0, 7)}: ${kept}`);
    hover(row(container, C));
    act(() => vi.advanceTimersByTime(300));
    expect(tip(container).querySelector(".tip-subject")?.textContent).toBe(kept);
  });

  it("test_graphPane_hoverAnotherRow_restartsTheDelay", () => {
    const { container } = renderPane();
    hover(row(container, D));
    act(() => vi.advanceTimersByTime(300));
    hover(row(container, C));
    expect(shown(container)).toBe(false);
    act(() => vi.advanceTimersByTime(300));
    expect(tip(container).querySelector(".tip-subject")?.textContent).toBe(`feat: commit ${C.slice(0, 7)}`);
    expect(shown(container)).toBe(true);
  });

  it("test_graphPane_leaveScrollOrKeys_hideTheBoard", () => {
    const { container } = renderPane();
    const showOn = (oid: string) => {
      hover(row(container, oid));
      act(() => vi.advanceTimersByTime(300));
      expect(shown(container)).toBe(true);
    };

    showOn(D);
    fireEvent.mouseLeave(container.querySelector('[role="listbox"]')!);
    expect(shown(container)).toBe(false);

    showOn(C);
    fireEvent.scroll(container.querySelector(".graph-scroll")!);
    expect(shown(container)).toBe(false);

    showOn(B);
    fireEvent.click(row(container, B));
    fireEvent.keyDown(row(container, B), { key: "ArrowDown" });
    expect(shown(container)).toBe(false);

    // 離開後還在計時的那次也取消
    hover(row(container, D));
    fireEvent.mouseLeave(container.querySelector('[role="listbox"]')!);
    act(() => vi.advanceTimersByTime(300));
    expect(shown(container)).toBe(false);
  });
});

describe("GraphPane: the ripple round HEAD", () => {
  beforeEach(() => {
    useGraphStore.setState({ graphData: null, selectedCommit: null, repoId: REPO });
  });
  afterEach(() => cleanup());

  const pulse = (c: HTMLElement) => c.querySelector(".here-pulse");

  // 漣漪的動畫在元素掛上時播：同一個 HEAD 的 refresh 不重掛，HEAD 換了（含同一個 commit 換分支）就重掛
  it("test_graphPane_ripple_replaysOnlyWhenHeadChanges", () => {
    const { container, rerenderWith } = renderPane();
    const first = pulse(container);
    expect(first).not.toBeNull();

    rerenderWith(graphOf());
    expect(pulse(container)).toBe(first);

    rerenderWith(graphOf({ oid: D, branch: "feat/new" }));
    const second = pulse(container);
    expect(second).not.toBe(first);

    rerenderWith(graphOf({ oid: C, branch: null }));
    expect(pulse(container)).not.toBe(second);
  });
});
