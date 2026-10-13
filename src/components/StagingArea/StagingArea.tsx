import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { useRepoStore } from "@/stores/repoStore";
import { useNoticeStore } from "@/stores/noticeStore";
import { useUserBusy } from "@/hooks/useShellBusy";
import { stageFile, unstageFile, stageAll, unstageAll, commit, commitNotice } from "@/lib/tauri";
import type { ConflictType, ConflictedFile, FileStatus, FileStatusType } from "@/lib/tauri";
import { isMacOS } from "@/lib/platform";
import { Strip, plural } from "@/components/DiffViewer/Strips";

interface StagingAreaProps {
  repoId: string;
  onCommitSuccess?: () => void;
}

type StageOp = "stage" | "unstage" | "stage-all" | "unstage-all";

/** 按了才失敗 → 站牌提示（0b P5 規格 §3）：只有結論 */
const STAGE_FAILED: Record<StageOp, string> = {
  stage: "Stage failed.",
  unstage: "Unstage failed.",
  "stage-all": "Stage all failed.",
  "unstage-all": "Unstage all failed.",
};

/** 徽章：git 的狀態字母（基準 fileRow） */
const BADGE: Record<FileStatusType, { code: string; title: string }> = {
  Modified: { code: "M", title: "Modified" },
  New: { code: "A", title: "Added" },
  Deleted: { code: "D", title: "Deleted" },
};

/** 衝突徽章：git short status 的兩個字（基準 CONFLICT）。RenamedByBoth 後端保留著、不產生（diff.rs） */
const CONFLICT: Record<ConflictType, { code: string; title: string }> = {
  BothModified: { code: "UU", title: "Both modified" },
  BothAdded: { code: "AA", title: "Both added" },
  DeletedByUs: { code: "DU", title: "Deleted by us" },
  DeletedByThem: { code: "UD", title: "Deleted by them" },
  RenamedByBoth: { code: "UU", title: "Renamed by both" },
};

/** status 還沒讀到時的骨架列（基準 skFiles 的寬度） */
const SKELETON = { staged: [58, 44], unstaged: [66, 38, 52] };

/** 路徑拆成目錄與檔名（基準 fileRow）：目錄含結尾的 / */
function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

function FileName({ path }: { path: string }) {
  const { dir, base } = splitPath(path);
  return (
    <span className="fname" title={path}>
      <span className="dir">{dir}</span>
      <span className="base">{base}</span>
    </span>
  );
}

/**
 * Changes 分頁（Phase 5 5c step 5–7，照基準 renderStaging）：衝突區段 / Staged / Unstaged 兩個 `.files` 清單 +
 * commit 表單。status 還沒讀到畫骨架（C1）；讀不到（Q-S）清單藏起來、`.pane-empty` 一行錯誤 + Retry；
 * 按了才失敗的（stage / unstage / 全部 / commit）進站牌提示、× 後焦點回那顆按鈕（0b P5 §3）。
 * 開 repo 時的第一次讀在 App 的 applyOpenResult（跟 graph 並行）；這裡只在使用者操作之後重讀
 */
export function StagingArea({ repoId, onCommitSuccess }: StagingAreaProps) {
  const workingTreeStatus = useRepoStore((s) => s.workingTreeStatus);
  const statusError = useRepoStore((s) => s.statusError);
  const refreshStatus = useRepoStore((s) => s.refreshStatus);
  const setCommitLoading = useRepoStore((s) => s.setCommitLoading);
  // 只有使用者發起的忙碌擋 Commit 與全部 stage；watcher 的背景 refresh 不擋
  const busy = useUserBusy(repoId);
  const [message, setMessage] = useState("");
  // bulk stage/unstage 進行中時鎖住 commit 與其他 batch button：
  // backend write_lock 不保證 IPC 順序，避免 commit 在 stage_all/unstage_all 中途搶 lock 提交意料外的 index。
  const [stagingBusy, setStagingBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageAllRef = useRef<HTMLButtonElement>(null);
  const unstageAllRef = useRef<HTMLButtonElement>(null);
  const commitRef = useRef<HTMLButtonElement>(null);
  // 「Committed <7 碼>」在 Commit 旁亮 2.4 秒（基準 commit-note：字留著，只有 .show 退掉）；再 commit 一次就重新計時
  const [note, setNote] = useState<{ text: string; shown: boolean } | null>(null);
  const noteTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    },
    [],
  );
  const showNote = (text: string) => {
    setNote({ text, shown: true });
    if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => {
      noteTimer.current = null;
      setNote((n) => (n ? { ...n, shown: false } : n));
    }, 2400);
  };
  // 換 repo：上一個 repo 的「Committed …」不帶過去（草稿照舊留在表單裡，同舊 CommitForm）
  useEffect(() => {
    if (noteTimer.current !== null) {
      window.clearTimeout(noteTimer.current);
      noteTimer.current = null;
    }
    setNote(null);
  }, [repoId]);

  // Retry 之後（Q-F）：焦點移到 Changes 那一格（tabpanel），讀取中與讀完都在那；再失敗、焦點還在 → 新的 Retry；
  // 讀取中使用者把焦點移走了就不動
  const [retried, setRetried] = useState(0);
  const pane = () => scrollRef.current?.closest<HTMLElement>("[role=tabpanel]") ?? null;
  useEffect(() => {
    if (retried === 0) return;
    const p = pane();
    if (useRepoStore.getState().statusError && p !== null && document.activeElement === p) {
      scrollRef.current?.querySelector<HTMLElement>("#changes-retry")?.focus();
    }
  }, [retried]);
  const retry = async () => {
    pane()?.focus();
    await refreshStatus({ source: "user" });
    setRetried((n) => n + 1);
  };

  // 提示關掉時那一列重畫過了：關的時候才去找按鈕（同基準 stageBtn）
  const stageButton = (path: string, op: "stage" | "unstage") =>
    [...(scrollRef.current?.querySelectorAll<HTMLElement>(".stage-btn") ?? [])].find(
      (b) => b.dataset.path === path && b.dataset.op === op,
    ) ?? null;

  // 按了才失敗：開始時清掉站牌上的提示（0b P5 §3.1），失敗進站牌、× 後焦點回那顆按鈕；換了 repo 就都不做
  const runStageOp = async (op: StageOp, call: () => Promise<unknown>, from: () => HTMLElement | null) => {
    const myRepo = repoId;
    const bulk = op === "stage-all" || op === "unstage-all";
    if (!bulk && stagingBusy) return;
    useNoticeStore.getState().clear();
    if (bulk) setStagingBusy(true);
    try {
      await call();
      await refreshStatus({ source: "user" });
    } catch (err) {
      console.error(`[kira] ${op} failed:`, err);
      if (useRepoStore.getState().repoId !== myRepo) return;
      useNoticeStore.getState().show({
        title: STAGE_FAILED[op],
        from: () => (useRepoStore.getState().repoId === myRepo ? from() : null),
      });
    } finally {
      if (bulk) setStagingBusy(false);
    }
  };

  const loading = workingTreeStatus === null && !statusError;
  const staged = workingTreeStatus?.staged ?? [];
  const unstaged = workingTreeStatus?.unstaged ?? [];
  const conflicted = workingTreeStatus?.conflicted ?? [];
  const unstagedCut = workingTreeStatus?.unstaged_truncated ?? false;
  const blocked = busy !== null || stagingBusy;
  // a half-resolved merge must not be committed; nor can anything be while the status is unknown（基準 syncCommitButton）
  const commitDisabled =
    staged.length === 0 || message.trim() === "" || blocked || conflicted.length > 0 || loading || statusError;

  const handleCommit = async () => {
    if (commitDisabled) return;
    const myRepo = repoId;
    const sent = message;
    useNoticeStore.getState().clear();
    setCommitLoading(true);
    let oid: string;
    try {
      try {
        ({ oid } = await commit(myRepo, sent));
      } catch (err) {
        console.error("[kira] commit failed:", err);
        // 失敗：草稿整份留著（同舊 CommitForm：成功才清）；換了 repo 就不說
        if (useRepoStore.getState().repoId === myRepo) {
          useNoticeStore.getState().show({
            ...commitNotice(err),
            from: () => (useRepoStore.getState().repoId === myRepo ? commitRef.current : null),
          });
        }
        return;
      }
      // commit 存進去了。草稿只清送出的那份：等待期間新打的字留著（textarea 在 commit 進行中照基準不停用）。換了 repo
      // 也照清——textarea 是兩個 repo 共用的，已經提交的訊息留著，在新 repo 按 ⌘↩ 就拿它去提交（第二輪 CL-3）。
      // flushSync：這裡不在事件裡，React 給這個更新 DefaultLane（下一個 task 才畫），而下面 finally 解除忙碌走 zustand 的
      // SyncLane（microtask 內就畫）——不先畫掉草稿，中間那幀 Commit 可按、textarea 還是已提交的訊息（第三輪 CL3-1）
      flushSync(() => setMessage((m) => (m === sent ? "" : m)));
      // 換了 repo 才回來：新 repo 的畫面（note、清單、選取）不該被另一個 repo 的 commit 改寫
      if (useRepoStore.getState().repoId !== myRepo) return;
      // 忙碌撐到重讀回來：在那之前清單還是 commit 之前那份（staged 還在），等待期間新打的訊息一按就會再送一次
      // （後端回 NOTHING_TO_COMMIT，站牌在剛成功的 commit 之後說 Commit failed.）。重讀與之後的重載 graph 自己處理
      // 失敗（Changes 區、站牌），不會回頭說成 commit 失敗
      await refreshStatus({ source: "user" });
    } finally {
      setCommitLoading(false);
    }
    // 重讀期間換了 repo：App 的 graph 重載讀的是當下的 repo，不能拿這次 commit 去重載新 repo 的路線圖、重選它的 HEAD
    if (useRepoStore.getState().repoId !== myRepo) return;
    // 「Committed …」跟 Commit 鈕回到可按、清單換成 commit 之後的同一刻亮（基準：清單、setBusy(null)、note 同一段）；
    // 重讀還在飛時亮的話，旁邊的按鈕還寫 Committing…
    showNote(`Committed ${oid.slice(0, 7)}`);
    onCommitSuccess?.();
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void handleCommit();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void handleCommit();
    }
  };

  const fileRow = (f: FileStatus, isStaged: boolean) => {
    const op = isStaged ? "unstage" : "stage";
    const badge = BADGE[f.status];
    return (
      <li key={f.path} className="file">
        <FileName path={f.path} />
        <span className={`badge ${badge.code}`} title={badge.title}>
          {badge.code}
        </span>
        <button
          type="button"
          className="stage-btn"
          data-path={f.path}
          data-op={op}
          aria-label={`${isStaged ? "Unstage" : "Stage"} ${f.path}`}
          onClick={() =>
            void runStageOp(
              op,
              () => (isStaged ? unstageFile(repoId, f.path) : stageFile(repoId, f.path)),
              () => stageButton(f.path, op),
            )
          }
        >
          <svg aria-hidden="true">
            <use href={`#i-${isStaged ? "minus" : "plus"}`} />
          </svg>
        </button>
      </li>
    );
  };
  // a conflicted file has no stage button: Kira has no resolver, and staging it here would mark it resolved
  const conflictRow = (f: ConflictedFile) => {
    const c = CONFLICT[f.conflict_type];
    return (
      <li key={f.path} className="file">
        <FileName path={f.path} />
        <span className="badge C" title={c.title}>
          {c.code}
        </span>
        <span className="stage-gap" aria-hidden="true" />
      </li>
    );
  };
  const skeleton = (widths: number[]) =>
    widths.map((w) => (
      <li key={w} className="sk sk-file" aria-hidden="true">
        <i style={{ width: `${w}%` }} />
        <i />
      </li>
    ));

  return (
    <>
      <div className="stage-scroll" ref={scrollRef}>
        <div id="conflicted">
          {!loading && !statusError && conflicted.length > 0 && (
            <>
              <div className="stage-head">
                <h3>
                  Conflicted <span className="n">{conflicted.length}</span>
                </h3>
                <span className="rule" />
              </div>
              <Strip
                title={`${plural(conflicted.length, "file")} ${conflicted.length === 1 ? "has" : "have"} conflicts.`}
                detail={
                  <>
                    Fix them in your editor, then <code>git add</code> them.
                  </>
                }
              />
              <ul className="files">{conflicted.map(conflictRow)}</ul>
            </>
          )}
        </div>
        {/* a status read that failed lists nothing: the old list would say a file you just staged is not staged */}
        <div id="stage-lists" hidden={statusError}>
          <div className="stage-head">
            <h3>
              Staged{" "}
              <span className="n" id="n-staged">
                {loading ? "" : staged.length}
              </span>
            </h3>
            <span className="rule" />
            <button
              type="button"
              className="text-btn"
              id="unstage-all"
              ref={unstageAllRef}
              disabled={staged.length === 0 || blocked || loading}
              onClick={() => void runStageOp("unstage-all", () => unstageAll(repoId), () => unstageAllRef.current)}
            >
              Unstage all
            </button>
          </div>
          <ul className="files" id="staged">
            {loading
              ? skeleton(SKELETON.staged)
              : staged.length > 0
                ? staged.map((f) => fileRow(f, true))
                : <li className="empty-line">No staged changes</li>}
          </ul>
          <div className="stage-head">
            <h3>
              Unstaged{" "}
              <span className="n" id="n-unstaged">
                {loading ? "" : unstagedCut ? "5,000+" : unstaged.length}
              </span>
            </h3>
            <span className="rule" />
            {/* staging all would stage files the list does not show */}
            <button
              type="button"
              className="text-btn"
              id="stage-all"
              ref={stageAllRef}
              disabled={unstaged.length === 0 || blocked || loading || unstagedCut}
              title={unstagedCut ? "Not every file is listed, so not all at once" : undefined}
              onClick={() => void runStageOp("stage-all", () => stageAll(repoId), () => stageAllRef.current)}
            >
              Stage all
            </button>
          </div>
          <div id="unstaged-note">
            {!loading && unstagedCut && (
              <Strip title="Only the first 5,000 files are listed." detail="Add a .gitignore to leave out build output." />
            )}
          </div>
          <ul className="files" id="unstaged">
            {loading
              ? skeleton(SKELETON.unstaged)
              : unstaged.length > 0
                ? unstaged.map((f) => fileRow(f, false))
                : <li className="empty-line">No changes</li>}
          </ul>
        </div>
        {statusError && (
          <div className="pane-empty" id="changes-state" role="alert">
            <svg className="mark" aria-hidden="true">
              <use href="#i-bad" />
            </svg>
            <p>
              <b>Couldn&apos;t read your changes.</b>
            </p>
            <p className="hint">Nothing is listed until a read works.</p>
            <button className="btn" type="button" id="changes-retry" onClick={() => void retry()}>
              Retry
            </button>
          </div>
        )}
      </div>
      <form className="commit-form" id="commit-form" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="msg">
          Commit message
        </label>
        <textarea
          id="msg"
          rows={3}
          placeholder={`Commit message… (${isMacOS() ? "⌘↩" : "Ctrl+↩"} to commit)`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="commit-row">
          <button
            className="btn primary"
            id="commit"
            type="submit"
            ref={commitRef}
            disabled={commitDisabled}
            title={conflicted.length > 0 ? "Resolve conflicts first" : undefined}
          >
            {busy === "committing" ? "Committing…" : "Commit"}
          </button>
          <span className={note?.shown ? "commit-note show" : "commit-note"} id="commit-note" role="status">
            {note?.text ?? ""}
          </span>
        </div>
      </form>
    </>
  );
}
