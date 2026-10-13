import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGraphStore } from "@/stores/graphStore";
import { getDiff, isSupersededDiff, type DiffFile } from "@/lib/tauri";
import { hexPoints } from "@/lib/routeGeometry";
import { FileDiff, type ShowAt } from "./FileDiff";
import { LimitStrips } from "./Strips";

interface DiffViewerProps {
  repoId: string | null;
  /** 空 repo（HEAD 在分支上、還沒有 commit）：沒有站可選，空狀態換專用文案、不提鍵盤（E9） */
  unborn: boolean;
}

type ViewerState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; oid: string }
  | { kind: "data"; oid: string; files: DiffFile[]; truncated: boolean };

/** 按住方向鍵時超過這個量的 diff 先不畫：要跟上每 30–90ms 一次的按鍵重複，一次渲染得在約
 *  30–50ms 內（v8 上色器 release 實測，2026-10-11：64 字元的 Rust 行每行 146µs → 50ms ÷ 146µs ≈ 342 行；
 *  上色長行每千字元 1.34ms → × 32 ≈ 43ms）。算字元不算位元組；字元用 JS 的 `.length`（UTF-16 單位，
 *  BMP 內等於字元數，後端數的是 code point） */
const HEAVY_DIFF_LINES = 300;
const HEAVY_DIFF_CHARS = 32 * 1024;
/** 大 diff 延後畫的等待：這段時間內沒有新的選取（放開了）才畫 */
const HEAVY_DIFF_HOLD_MS = 150;
/** 目前的選取回 CANCELLED 時最多重送幾次（見 effect 裡的說明；正常不會用到第二次） */
const MAX_RESENDS = 5;
/** 骨架四條的寬度（基準 renderDiff） */
const SKELETON_WIDTHS = [42, 88, 76, 64];

function isHeavy(files: DiffFile[]): boolean {
  let lines = 0;
  let chars = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        lines += 1;
        chars += line.content.length + 1;
        if (lines > HEAVY_DIFF_LINES || chars > HEAVY_DIFF_CHARS) return true;
      }
    }
  }
  return false;
}

/** diff 區的圖：一條路線、幾個站，你在線的盡頭（基準 DIFF_PICTURE） */
function DiffPicture() {
  return (
    <svg viewBox="0 0 176 36" aria-hidden="true">
      <path d="M10 18H150" stroke="var(--l-rokusho)" strokeWidth="3.25" strokeLinecap="round" />
      <path d="M10 11.5v13" stroke="var(--l-rokusho)" strokeWidth="3.25" strokeLinecap="round" />
      <path d="M48 18v-7.5M86 18v-7.5M124 18v-7.5" stroke="var(--l-rokusho)" strokeWidth="3.25" strokeLinecap="round" />
      <polygon
        points={hexPoints(162, 18, 9)}
        fill="var(--gold-leaf)"
        stroke="var(--flake-edge)"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * diff 區（v8 基準 renderDiff，Phase 5 5b）：`#diff` 是捲動區，也是 Retry 之後焦點停的地方（Q-F，
 * `role=region` + 名字 + `tabindex=-1`，不畫焦點框）。沒有選取 → 空狀態（空 repo 換文案，E9）；讀取中 → 骨架；
 * 讀不到 → 一行結論 + Retry；沒有檔 → E2；有檔 → 條（E3 / E4）+ 每個檔（FileDiff）。換成新的結果時捲回頂端、
 * 重播進場（`.enter`），同基準。
 *
 * B1 照舊：目前的選取回 CANCELLED 重送（最多 5 次）；按住方向鍵時大 diff 等放開才畫；選取換了先畫骨架、
 * 不留上一筆；effect 結束就作廢晚到的結果
 */
export function DiffViewer({ repoId, unborn }: DiffViewerProps) {
  const selectedCommit = useGraphStore((s) => s.selectedCommit);
  const [state, setState] = useState<ViewerState>({ kind: "idle" });
  // Retry 再讀一次同一個選取（effect 看 attempt）。retriedFor 記 Retry 的是哪個 commit：那個 commit 的結果照
  // 使用者操作處理（立即畫、焦點規則）；選取一換到別的 commit 這輪 Retry 就結束——不能等它的結果，Retry 的
  // 請求已被換選取的 cleanup 作廢、結果不會到，留著的話按住方向鍵回到這一站會被當成 Retry、大 diff 不等放開
  const [attempt, setAttempt] = useState(0);
  const retriedFor = useRef<string | null>(null);
  const diffRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!repoId || !selectedCommit) {
      retriedFor.current = null;
      setState({ kind: "idle" });
      return;
    }
    const oid = selectedCommit.full_oid;
    if (retriedFor.current !== null && retriedFor.current !== oid) retriedFor.current = null;
    // 跟選取同一次寫進 store；不列進依賴：同一個 commit 只是旗標變了不必重抓。Retry 是使用者按的，不算按住
    const fromRepeat = retriedFor.current !== oid && useGraphStore.getState().selectionFromRepeat;
    let cancelled = false;
    let hold: ReturnType<typeof setTimeout> | undefined;
    setState({ kind: "loading" });
    const load = (resendsLeft: number): void => {
      getDiff(repoId, oid)
        .then((result) => {
          if (cancelled) return;
          const show = () => setState({ kind: "data", oid, files: result.files, truncated: result.truncated });
          // 按住方向鍵時小 diff 照樣即時預覽；大 diff 等放開（這段時間沒有新的選取）才畫，免得每一站
          // 都卡在渲染上。點選、按一下、開 repo、commit 後一律立即畫
          if (fromRepeat && isHeavy(result.files)) hold = setTimeout(show, HEAVY_DIFF_HOLD_MS);
          else show();
        })
        .catch((err) => {
          if (cancelled) return;
          // 後端的閘看領到號碼的先後，號碼在 task 第一次執行時才領，不保證等於送出的順序：目前的選取
          // 可能被比它舊、卻比它晚領號的請求取代。每個舊請求只領一次號，數量有限也不會再增加，所以
          // 一直重送到它們都領過號就會成功；次數上限是保險（例如以後兩個地方同時抓 diff、互相取代）
          if (resendsLeft > 0 && isSupersededDiff(err)) {
            load(resendsLeft - 1);
            return;
          }
          const code = (err as { code?: string } | null)?.code ?? "unknown";
          console.error("[kira] getDiff failed:", code);
          setState({ kind: "error", oid });
        });
    };
    load(MAX_RESENDS);
    return () => {
      cancelled = true;
      clearTimeout(hold);
    };
  }, [repoId, selectedCommit, attempt]);

  // 新的結果（檔、沒有檔、讀不到）：捲回頂端、重播進場（基準對 #diff 拿掉再加上 .enter）。
  // Retry 之後又讀不到、焦點還在 #diff 上 → 交給新的 Retry；讀取中使用者把焦點移走了就不動（Q-F）
  useLayoutEffect(() => {
    const el = diffRef.current;
    if (!el || (state.kind !== "data" && state.kind !== "error")) return;
    el.scrollTop = 0;
    el.classList.remove("enter");
    void el.offsetWidth;
    el.classList.add("enter");
    const afterRetry = retriedFor.current === state.oid;
    retriedFor.current = null;
    if (afterRetry && state.kind === "error" && document.activeElement === el) {
      el.querySelector<HTMLElement>("#diff-retry")?.focus();
    }
  }, [state]);

  const retry = () => {
    if (state.kind !== "error") return;
    retriedFor.current = state.oid;
    diffRef.current?.focus();
    setAttempt((n) => n + 1);
  };

  // 收合的檔那行指令要知道是哪個 commit。同一個物件給每個 FileDiff：它們是 memo 的，App 重畫（切 tab、對話框、
  // refresh）時 props 沒變就不重新上色
  // (keyed on the count, not the commit object: the same station handed over again as a new object keeps the same at)
  const parentCount = selectedCommit?.parents.length ?? 0;
  const at = useMemo<ShowAt | null>(
    () => (state.kind === "data" ? { oid: state.oid, parentCount } : null),
    [state, parentCount],
  );

  let content;
  // no selection shows the empty state at once, not the skeleton for the one render before the effect sets idle
  // (second review, 2026-10-12: that render carried role=status)
  if (state.kind === "idle" || !selectedCommit) {
    content = unborn ? (
      <div className="diff-empty">
        <DiffPicture />
        <p>Nothing to compare yet</p>
        <p className="hint">Your first commit will show here.</p>
      </div>
    ) : (
      <div className="diff-empty">
        <DiffPicture />
        <p>Select a commit to view its diff</p>
        <p className="hint">
          <kbd>↑</kbd> <kbd>↓</kbd> move between stations · <kbd>Esc</kbd> to clear
        </p>
      </div>
    );
  } else if (
    state.kind === "loading" ||
    ((state.kind === "data" || state.kind === "error") && state.oid !== selectedCommit?.full_oid)
  ) {
    // 選取已經換了、新的還沒畫：不留著上一筆 diff（或上一站讀不到的錯誤）跟選取對不上——只差 effect 之前的那一次
    // render，按鍵與點選的 effect 同步沖掉、看不到，但開 repo / commit 後選新 HEAD 走的是 IPC 回呼，看得到。
    // role=status：aria-label 掛在沒有 role 的 div 上
    // 進不了無障礙樹（main 的 Skeleton 本來就有 role），按 Retry 的螢幕閱讀器使用者才聽得到「在讀」；屬性不改像素
    content = (
      <div className="skeleton" role="status" aria-busy="true" aria-label="Loading diff">
        {SKELETON_WIDTHS.map((w) => (
          <i key={w} style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  } else if (state.kind === "error") {
    content = (
      <div className="diff-empty" role="alert">
        <svg className="mark" aria-hidden="true">
          <use href="#i-bad" />
        </svg>
        <p>
          <b>Couldn&apos;t load this diff.</b>
        </p>
        <p className="hint">Try again, or pick another station.</p>
        <button className="btn" type="button" id="diff-retry" onClick={retry}>
          Retry
        </button>
      </div>
    );
  } else if (state.files.length === 0) {
    content = (
      <div className="diff-empty">
        <DiffPicture />
        <p>No file changes</p>
        <p className="hint">This commit changes no files.</p>
      </div>
    );
  } else {
    content = (
      <>
        <LimitStrips files={state.files} cut={state.truncated} whole="commit" />
        {state.files.map((file, i) => (
          <FileDiff key={i} file={file} at={at} />
        ))}
      </>
    );
  }

  return (
    <div className="diff-scroll" id="diff" role="region" aria-label="Diff" tabIndex={-1} ref={diffRef}>
      {content}
    </div>
  );
}
