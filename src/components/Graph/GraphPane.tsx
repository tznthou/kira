import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from "react";
import type { CommitNode, GraphData } from "@/lib/tauri";
import type { LineColor, RouteMap } from "@/lib/routeMap";
import { LW, ROW, X, Y, computeGeometry } from "@/lib/routeGeometry";
import { rowRefs, type RowRefs } from "@/lib/rowRefs";
import { useGraphStore } from "@/stores/graphStore";
import { Roundel } from "@/components/ui/Roundel";
import { GraphRow, subjectOf } from "./GraphRow";
import { RouteLayer } from "./RouteLayer";

const NO_REFS: RowRefs = { shown: [], folded: [], spoken: [] };

/** 載入骨架的訊息條寬度（%，基準 drawLoading） */
const LOADING_WIDTHS = [64, 47, 72, 55, 68, 41, 59, 74, 50, 62, 45, 70, 53, 66];

/** 開 repo、graph 還沒回來：一條空軌道帶站點短刻，加上幾列骨架（基準 drawLoading） */
function Loading() {
  const H = LOADING_WIDTHS.length * ROW;
  const band = { stroke: "var(--band)", strokeWidth: LW, strokeLinecap: "round" } as const;
  return (
    <div className="graph-loading" aria-label="Loading commits">
      <svg width={X(0) + 12} height={H} aria-hidden="true">
        <path d={`M${X(0)} ${Y(0)}V${H}`} {...band} />
        {LOADING_WIDTHS.map((_, i) => (
          <path key={i} d={`M${X(0)} ${Y(i)}H${X(0) + 7.5}`} {...band} />
        ))}
      </svg>
      {LOADING_WIDTHS.map((w, i) => (
        <div key={i} className="sk-row">
          <i />
          <i style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

/** 空 repo：金箔在起點、點線軌道與三個預定站（基準 .graph-empty） */
function Empty() {
  return (
    <div className="graph-empty">
      <svg viewBox="0 0 176 36" aria-hidden="true">
        <path d="M34 18H166" stroke="var(--line)" strokeWidth="3.25" strokeLinecap="round" strokeDasharray="0 7.5" />
        <circle cx="76" cy="18" r="4.6" fill="var(--sheet-hi)" stroke="var(--line)" strokeWidth="2.2" />
        <circle cx="120" cy="18" r="4.6" fill="var(--sheet-hi)" stroke="var(--line)" strokeWidth="2.2" />
        <circle cx="164" cy="18" r="4.6" fill="var(--sheet-hi)" stroke="var(--line)" strokeWidth="2.2" />
        <use href="#flake" x="4" y="7" width="22" height="22" />
      </svg>
      <p>No commits yet</p>
      <p className="hint">Stage files, then commit. Your first commit opens the line.</p>
    </div>
  );
}

/** 截斷時接在最後一列下：載入了多少；HEAD 比這些都舊時，再一行說你在哪（基準 renderEnd） */
function End({ count, beyond }: { count: number; beyond: { color: LineColor; letter: string; branch: string } | null }) {
  return (
    <div className="graph-end">
      <p>{`Showing the latest ${count.toLocaleString("en-US")} commits · older history isn't loaded`}</p>
      {beyond && (
        <p className="here">
          <svg className="flk" aria-hidden="true">
            <use href="#flake" />
          </svg>
          <span>
            <b>You are further down the line.</b> <Roundel color={beyond.color} letter={beyond.letter} />
          </span>
          <span>{`${beyond.branch} is older than these commits.`}</span>
        </p>
      )}
    </div>
  );
}

/** 站牌上的日期：本地時間 YYYY/MM/DD HH:mm（基準的寫法） */
function boardTime(seconds: number): string {
  const d = new Date(seconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 站牌（tooltip，基準 .tip）：線色頂條、訊息、作者、日期、完整 oid。內容留到下一筆才換，淡出時還是原本那筆 */
function Board({
  commit,
  color,
  show,
  boardRef,
}: {
  commit: CommitNode | null;
  color: LineColor | null;
  show: boolean;
  boardRef: Ref<HTMLDivElement>;
}) {
  const style = color ? ({ "--tl": `var(--l-${color})` } as CSSProperties) : undefined;
  return (
    <div className={show ? "tip show" : "tip"} ref={boardRef} role="tooltip" aria-hidden="true" style={style}>
      <div className="tip-bar" />
      <div className="tip-body">
        <p className="tip-subject">{commit ? subjectOf(commit.message) : ""}</p>
        <dl>
          <dt>Author</dt>
          <dd>{commit?.author.name ?? ""}</dd>
          <dt>Date</dt>
          <dd>{commit ? boardTime(commit.author.timestamp) : ""}</dd>
          <dt>Commit</dt>
          <dd className="mono">{commit?.full_oid ?? ""}</dd>
        </dl>
      </div>
    </div>
  );
}

/** 事件落在哪一列（列裡的 span 也算） */
const optionOf = (target: EventTarget) =>
  target instanceof Element ? target.closest<HTMLElement>('[role="option"]') : null;

/** 捲動層裡那一站的列 */
const rowIn = (scroller: HTMLElement | null, oid: string) =>
  scroller?.querySelector<HTMLElement>(`[data-oid="${oid}"]`) ?? null;

/**
 * 路線圖（v8，基準 `section.graph-pane` 的內容）：捲動層 → listbox（路線層 SVG 疊在列上），旁邊是站牌。
 * 幾何與 ref 都是純模組算好的，這裡只轉成 DOM；算不出來（丟錯）只少畫線或 ref，列照樣在——
 * App 沒有 ErrorBoundary，同 computeRoutes 的處理。互動照基準：點選、↑↓ Home End Enter Space、Esc 清除，
 * roving tabindex；站牌 300ms 意圖延遲，離開列區、捲動、鍵盤移動就收
 */
export function GraphPane({ graph, routes, repoId }: { graph: GraphData | null; routes: RouteMap | null; repoId: string }) {
  const selectedOid = useGraphStore((s) => s.selectedCommit?.full_oid ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  // 焦點最後停的那列：沒有選取時（Esc 之後）它留作 tab stop（計畫 §2.9）
  const [focusOid, setFocusOid] = useState<string | null>(null);
  // 站牌：內容是哪一筆、顯示了沒；shownFor = 顯示中的那列（在同一列裡移動不重新計時，基準 tipFor）
  const [board, setBoard] = useState<{ oid: string; show: boolean } | null>(null);
  const shownFor = useRef<string | null>(null);
  const boardTimer = useRef<ReturnType<typeof setTimeout>>();

  const geometry = useMemo(() => {
    if (!graph || !routes) return null;
    try {
      return computeGeometry(routes, graph);
    } catch (err) {
      console.error("[kira] route geometry failed:", err);
      return null;
    }
  }, [graph, routes]);

  const refsByOid = useMemo(() => {
    const out = new Map<string, RowRefs>();
    if (!graph || !routes) return out;
    try {
      for (const c of graph.commits) out.set(c.full_oid, rowRefs(routes, c.full_oid, graph.head));
    } catch (err) {
      console.error("[kira] row refs failed:", err);
      out.clear();
    }
    return out;
  }, [graph, routes]);

  const indexOf = useMemo(() => new Map((graph?.commits ?? []).map((c, i) => [c.full_oid, i])), [graph]);
  const stationOf = useMemo(() => new Map((geometry?.stations ?? []).map((s) => [s.oid, s])), [geometry]);

  // 選取換了就把那列捲進視野（nearest：已經看得到就不動），開 repo 選 HEAD、commit 後選新 HEAD、
  // 點選與鍵盤都走這裡；同一個選取的 refresh 不捲
  useLayoutEffect(() => {
    if (!selectedOid) return;
    rowIn(scrollRef.current, selectedOid)?.scrollIntoView({ block: "nearest" });
  }, [selectedOid]);

  // 站牌的位置（基準 showTip）：列下方、站的右邊；下面放不下翻到上面，右邊放不下靠右。量站牌自己的大小，
  // 所以等它帶著內容掛上去才算，在繪製前寫好
  useLayoutEffect(() => {
    const el = boardRef.current;
    const pane = el?.parentElement;
    const row = board?.show ? rowIn(scrollRef.current, board.oid) : null;
    if (!el || !pane || !row || !board) return;
    const p = pane.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    let left = r.left - p.left + (stationOf.get(board.oid)?.x ?? 0) + 14;
    let top = r.bottom - p.top + 4;
    el.style.left = "0px";
    el.style.top = "0px";
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    if (top + th > p.height - 8) top = r.top - p.top - th - 4;
    if (left + tw > p.width - 8) left = p.width - tw - 8;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [board, stationOf]);

  useEffect(() => () => clearTimeout(boardTimer.current), []);

  const commits = graph?.commits ?? [];

  const hideBoard = () => {
    clearTimeout(boardTimer.current);
    shownFor.current = null;
    setBoard((b) => (b?.show ? { ...b, show: false } : b));
  };

  /** `fromRepeat`：按住方向鍵的自動重複（diff 區對大 diff 等放開才畫） */
  const select = (commit: CommitNode | null, fromRepeat = false) => {
    useGraphStore.getState().actions.setSelectedCommit(commit, fromRepeat);
    if (commit) rowIn(scrollRef.current, commit.full_oid)?.focus();
  };

  const onClick = (e: React.MouseEvent) => {
    const el = optionOf(e.target);
    const i = el ? indexOf.get(el.dataset.oid ?? "") : undefined;
    if (i !== undefined) select(commits[i]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = optionOf(e.target);
    const i = el ? indexOf.get(el.dataset.oid ?? "") : undefined;
    if (!el || i === undefined) return;
    let next: CommitNode | undefined;
    if (e.key === "ArrowDown") next = commits[Math.min(i + 1, commits.length - 1)];
    else if (e.key === "ArrowUp") next = commits[Math.max(i - 1, 0)];
    else if (e.key === "Home") next = commits[0];
    else if (e.key === "End") next = commits[commits.length - 1];
    else if (e.key === "Enter" || e.key === " ") next = commits[i];
    else if (e.key === "Escape") {
      e.preventDefault();
      select(null);
      el.focus();
      return;
    }
    if (next) {
      e.preventDefault();
      hideBoard();
      select(next, e.repeat);
    }
  };

  const onFocus = (e: React.FocusEvent) => {
    const oid = optionOf(e.target)?.dataset.oid;
    if (oid) setFocusOid(oid);
  };

  const onMouseOver = (e: React.MouseEvent) => {
    const oid = optionOf(e.target)?.dataset.oid;
    if (!oid || oid === shownFor.current) return;
    hideBoard();
    boardTimer.current = setTimeout(() => {
      shownFor.current = oid;
      setBoard({ oid, show: true });
    }, 300);
  };

  const inWindow = (oid: string | null): oid is string => oid !== null && indexOf.has(oid);
  // roving tabindex：選取的列；沒有選取就焦點最後停的那列，再沒有就第一列
  const tabStop = inWindow(selectedOid) ? selectedOid : inWindow(focusOid) ? focusOid : (commits[0]?.full_oid ?? null);
  const ring = (inWindow(selectedOid) && stationOf.get(selectedOid)) || null;
  // HEAD 換了（含同一個 commit 換分支）漣漪才重播
  const pulseKey = `${repoId} ${graph?.head.oid ?? ""} ${graph?.head.branch ?? ""}`;
  const gutter = geometry ? ({ "--gutter": `${geometry.gutter}px` } as CSSProperties) : undefined;
  // HEAD 在分支上、但比載入的 commit 都舊（路線規則 §3）：detached 與 unborn 不算
  const head = graph?.head;
  const beyond =
    routes && head?.oid && head.branch !== null && !indexOf.has(head.oid)
      ? { color: routes.accent, letter: routes.head.letter ?? "?", branch: head.branch }
      : null;
  const boardIndex = board ? indexOf.get(board.oid) : undefined;
  const boardCommit = boardIndex === undefined ? null : commits[boardIndex];

  return (
    <>
      <div className="graph-scroll" ref={scrollRef} style={gutter} onScroll={hideBoard}>
        {commits.length > 0 && (
          // roving tabindex（WAI-ARIA listbox 的一種寫法）：焦點在各列 option 之間移動，容器本身不可聚焦，同基準；
          // 事件委派在容器上，所以這條規則誤判
          // eslint-disable-next-line jsx-a11y/interactive-supports-focus
          <div
            className="graph"
            role="listbox"
            aria-label="Git commit graph history"
            onClick={onClick}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            onMouseOver={onMouseOver}
            onMouseLeave={hideBoard}
          >
            {geometry && <RouteLayer geometry={geometry} pulseKey={pulseKey} selected={ring} />}
            <div>
              {commits.map((c) => (
                <GraphRow
                  key={c.full_oid}
                  commit={c}
                  refs={refsByOid.get(c.full_oid) ?? NO_REFS}
                  selected={c.full_oid === selectedOid}
                  tabStop={c.full_oid === tabStop}
                />
              ))}
            </div>
          </div>
        )}
        {graph?.truncated && commits.length > 0 && <End count={commits.length} beyond={beyond} />}
        {graph === null && <Loading />}
        {graph !== null && commits.length === 0 && <Empty />}
      </div>
      <Board
        commit={boardCommit}
        color={board ? (stationOf.get(board.oid)?.color ?? null) : null}
        show={Boolean(board?.show && boardCommit)}
        boardRef={boardRef}
      />
    </>
  );
}
