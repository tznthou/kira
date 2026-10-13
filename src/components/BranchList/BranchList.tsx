import { useEffect, useMemo, useRef, useState } from "react";
import { useRepoStore } from "@/stores/repoStore";
import { useNoticeStore } from "@/stores/noticeStore";
import { useShellBusy } from "@/hooks/useShellBusy";
import { byName, type RouteMap } from "@/lib/routeMap";
import { legendRoundel } from "@/lib/rowRefs";
import type { AheadBehindInfo, BranchInfo, BranchStats, HeadInfo } from "@/lib/tauri";
import { checkoutBranch, createBranch, deleteBranch } from "@/lib/tauri";
import { Roundel, RoundelSkeleton } from "@/components/ui/Roundel";
import { CheckoutConfirmDialog, CreateBranchDialog, DeleteConfirmDialog } from "./dialogs";
import { branchOpNotice, type BranchOp } from "./branchOpNotice";

type DialogSpec = { kind: "checkout"; branch: string } | { kind: "delete"; branch: string } | { kind: "create" };
type ActiveDialog = { kind: "none" } | (DialogSpec & { id: number });

/** 開 repo、分支清單還沒回來：四列骨架（基準 renderBranches 的寬度） */
const SKELETON_WIDTHS = [54, 38, 66, 47];

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const unpushed = (n: number) => `${plural(n, "commit")} not pushed`;
const unpulled = (n: number, remote: string) => `${plural(n, "commit")} on ${remote} not pulled`;

/** upstream 在哪裡：repo 的 remote 裡，`<名稱>/` 開頭對得上的最長那個（remote 名稱可以含 `/`；本機名也不一定
 *  跟遠端分支同名，feature 追蹤 origin/sub/feature 是 origin）。都對不上就是追蹤本機分支，寫它的名字 */
const remoteOf = (upstream: string, remotes: readonly string[]) =>
  remotes.filter((r) => upstream.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0] ?? upstream;

const NO_REMOTES: string[] = [];

/** 側欄那一列的按鈕（站牌提示的 × 把焦點還給它；列會重畫，關的時候才找） */
const rowButton = (list: HTMLElement | null, name: string) =>
  [...(list?.querySelectorAll<HTMLElement>(".branch-btn") ?? [])].find((b) => b.dataset.branch === name) ?? null;

/**
 * 側欄的分支清單（v8 基準 `renderBranches`，Phase 5 5a）：本機在前、遠端在後，各自依名稱排（同 graph 的
 * `byName`，後端不排）；圓標照路線圖（`legendRoundel`，graph 還沒回來是骨架圓點）；目前分支的 ↑↓ 跟工具列
 * 同源（aheadBehind），其他本機分支灰字（branchStats）。點列 checkout、× 刪除，舊的 Safe / Force 對話框照用
 * （P6 換）。忙碌時（refresh / commit / push / pull，含 watcher 的背景 refresh）列不變淡，aria-disabled +
 * title 說原因。detached HEAD 不畫虛擬列：站牌已經寫了。
 *
 * 分支操作失敗：checkout / 刪除關掉對話框、站牌提示、× 後焦點回那一列；建立失敗留在對話框裡（Q-C）。
 * 操作進行中對話框關不掉（Escape、點遮罩；Cancel 本來就停用），結果一定有地方說。
 * await 之後 repo 或對話框換了，晚到的結果不碰新的畫面（Codex #5）。
 * 清單讀不到（Q-B）：一行錯誤 + Retry；Retry 後焦點留在清單上，再失敗交給新的 Retry（Q-F）
 */
export function BranchList({ routes, head }: { routes: RouteMap | null; head: HeadInfo | null }) {
  const repoId = useRepoStore((s) => s.repoId);
  const branches = useRepoStore((s) => s.branches);
  const branchesError = useRepoStore((s) => s.branchesError);
  const branchStats = useRepoStore((s) => s.branchStats);
  const aheadBehind = useRepoStore((s) => s.aheadBehind);
  const remotes = useRepoStore((s) => s.repoInfo?.remotes ?? NO_REMOTES);
  const hasRemote = remotes.length > 0;
  const refreshBranchStats = useRepoStore((s) => s.refreshBranchStats);
  const refreshBranches = useRepoStore((s) => s.refreshBranches);
  const runBranchOp = useRepoStore((s) => s.runBranchOp);
  const refreshing = useRepoStore((s) => s.refreshing);
  const busy = useShellBusy(repoId);
  const blocked = busy ? `Disabled while ${busy}` : null;

  const [dialog, setDialog] = useState<ActiveDialog>({ kind: "none" });
  const [createError, setCreateError] = useState<{ title: string; detail?: string } | null>(null);
  // 開著的對話框代號（0 = 沒有）：await 之後拿來比，確認還是同一個對話框
  const activeDialog = useRef(0);
  const dialogSeq = useRef(0);
  // 操作還在跑的對話框代號（0 = 沒有）：它關不掉，否則之後的失敗沒有地方說——對話框不在了，歸屬檢查又把
  // 結果當成別人的。記代號不記布林：換 repo 時對話框直接關（不經 cancelDialog），舊操作還在跑也不擋新 repo
  // 開的對話框
  const running = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  const [retried, setRetried] = useState(0);

  const openDialog = (spec: DialogSpec) => {
    const id = ++dialogSeq.current;
    activeDialog.current = id;
    setCreateError(null);
    setDialog({ ...spec, id });
  };
  const closeDialog = () => {
    activeDialog.current = 0;
    setDialog({ kind: "none" });
  };
  // Cancel、Escape、點遮罩都走這裡
  const cancelDialog = () => {
    if (running.current !== 0 && running.current === activeDialog.current) return;
    closeDialog();
  };

  // 換 repo：關掉對話框——舊 repo 的對話框不能拿新的 repoId 確認
  useEffect(() => {
    activeDialog.current = 0;
    setDialog({ kind: "none" });
    setCreateError(null);
  }, [repoId]);

  const { local, remote } = useMemo(() => {
    const all = branches ?? [];
    const sorted = (list: BranchInfo[]) => [...list].sort((a, b) => byName(a.name, b.name));
    return { local: sorted(all.filter((b) => !b.is_remote)), remote: sorted(all.filter((b) => b.is_remote)) };
  }, [branches]);

  // 其他本機分支的 ↑↓：一次最多 20 個，沒有的才讀
  useEffect(() => {
    if (local.length === 0) return;
    const missing = local.filter((b) => branchStats[b.name] === undefined).map((b) => b.name);
    if (missing.length === 0) return;
    void refreshBranchStats(missing.slice(0, 20));
  }, [local, branchStats, refreshBranchStats]);

  // Retry 之後（Q-F）：再失敗、焦點還在清單上 → 新的 Retry；讀取中使用者把焦點移走了就不動
  useEffect(() => {
    if (retried === 0) return;
    if (useRepoStore.getState().branchesError && document.activeElement === listRef.current) {
      listRef.current?.querySelector<HTMLElement>("#branches-retry")?.focus();
    }
  }, [retried]);

  const retry = async () => {
    listRef.current?.focus();
    await refreshBranches({ source: "user" });
    setRetried((n) => n + 1);
  };

  const runOp = async (op: BranchOp, branch: string | null, call: (repoId: string) => Promise<unknown>) => {
    const myRepo = repoId;
    const myDialog = activeDialog.current;
    if (!myRepo) return;
    // 同一個對話框的操作已經在跑：不再送一次。按鈕看的是全域的 refreshing，那個旗標被提早清掉時按鈕按得到；
    // 第二次的結果又會因為對話框已經被第一次關掉而沒有地方說
    if (running.current !== 0 && running.current === myDialog) return;
    const stillOurs = () => useRepoStore.getState().repoId === myRepo && activeDialog.current === myDialog;
    // 按了才失敗的操作：開始時清掉站牌上的提示（殼層規則延伸，0b P5 §3.1）
    useNoticeStore.getState().clear();
    setCreateError(null);
    running.current = myDialog;
    try {
      await runBranchOp(() => call(myRepo));
      if (stillOurs()) closeDialog();
    } catch (err) {
      console.error(`[kira] ${op} failed:`, err);
      if (!stillOurs()) return;
      const text = branchOpNotice(op, err);
      if (op === "create" || branch === null) {
        setCreateError(text);
        return;
      }
      closeDialog();
      useNoticeStore.getState().show({
        ...text,
        // 只在同一個 repo 裡找；那一列不在了（分支在外面被刪、watcher 重讀拿掉它）就給清單本身（同 Retry
        // 之後，Q-F）——提示關掉時 × 會重掛，焦點原地不動就是掉到 body
        from: () =>
          useRepoStore.getState().repoId === myRepo ? (rowButton(listRef.current, branch) ?? listRef.current) : null,
      });
    } finally {
      if (running.current === myDialog) running.current = 0;
    }
  };

  const loading = branches === null && !branchesError;
  const headBranch = head?.branch ?? null;
  const tracked = aheadBehind !== null && aheadBehind.has_upstream && aheadBehind.tracking_ref_exists;

  const row = (b: BranchInfo) => {
    const look = legendRoundel(routes, b, headBranch);
    const pruned = !b.is_remote && b.upstream !== null && !b.upstream.tracking_ref_exists;
    const title = b.is_remote
      ? "Remote branch (read-only)"
      : (blocked ?? (b.is_current ? `Current branch: ${b.name}` : `Switch to ${b.name}`));
    return (
      <li
        key={`${b.is_remote ? "r" : "l"}:${b.name}`}
        className={`branch${b.is_current ? " current" : ""}${b.is_remote ? " remote" : ""}`}
      >
        <button
          type="button"
          className="branch-btn"
          data-branch={b.name}
          aria-current={b.is_current ? "true" : undefined}
          aria-disabled={b.is_remote || blocked ? "true" : undefined}
          title={title}
          onClick={() => {
            if (!b.is_remote && !b.is_current && !blocked) openDialog({ kind: "checkout", branch: b.name });
          }}
        >
          {look ? <Roundel {...look} /> : <RoundelSkeleton />}
          <span className="b-name">{b.name}</span>
          {pruned && (
            <span className="b-tag" title={`Upstream is set, but ${b.upstream?.name} no longer exists`}>
              pruned
            </span>
          )}
          {!b.is_remote &&
            (b.is_current ? (
              <YourCounts aheadBehind={tracked ? aheadBehind : null} />
            ) : (
              <OtherCounts stats={hasRemote ? branchStats[b.name] : undefined} branch={b} remotes={remotes} />
            ))}
        </button>
        {!b.is_remote && !b.is_current && (
          <button
            type="button"
            className="b-del"
            aria-label={`Delete branch ${b.name}`}
            title={`Delete ${b.name}`}
            aria-disabled={blocked ? "true" : undefined}
            onClick={() => {
              if (!blocked) openDialog({ kind: "delete", branch: b.name });
            }}
          >
            <svg aria-hidden="true">
              <use href="#i-x" />
            </svg>
          </button>
        )}
      </li>
    );
  };

  return (
    <>
      <div className="sec-head">
        <h2 className="sec-title">Branches</h2>
        <span className="rule" />
        <button
          className="text-btn"
          id="create-branch"
          type="button"
          disabled={busy !== null}
          title={blocked ?? "Create branch"}
          onClick={() => openDialog({ kind: "create" })}
        >
          + New branch
        </button>
      </div>
      <ul
        className="side-list"
        id="branch-list"
        ref={listRef}
        tabIndex={-1}
        aria-label={loading ? "Loading branches" : "Branches"}
      >
        {branchesError ? (
          <li className="empty-line">
            <span role="alert">
              <b>Couldn&apos;t read branches.</b>
            </span>{" "}
            <button className="text-btn" type="button" id="branches-retry" onClick={() => void retry()}>
              Retry
            </button>
          </li>
        ) : loading ? (
          SKELETON_WIDTHS.map((w) => (
            <li key={w} className="sk sk-branch" aria-hidden="true">
              <i />
              <i style={{ width: `${w}%` }} />
            </li>
          ))
        ) : (
          <>
            {local.length > 0 ? local.map(row) : <li className="empty-line">No branches yet</li>}
            {remote.length > 0 && (
              <>
                <li className="group-label">Remote</li>
                {remote.map(row)}
              </>
            )}
          </>
        )}
      </ul>
      {dialog.kind === "checkout" && (
        <CheckoutConfirmDialog
          branchName={dialog.branch}
          busy={refreshing}
          onConfirm={(force) => {
            const name = dialog.branch;
            void runOp("checkout", name, (id) => checkoutBranch(id, name, force));
          }}
          onCancel={cancelDialog}
        />
      )}
      {dialog.kind === "delete" && (
        <DeleteConfirmDialog
          branchName={dialog.branch}
          busy={refreshing}
          onConfirm={(force) => {
            const name = dialog.branch;
            void runOp("delete", name, (id) => deleteBranch(id, name, force));
          }}
          onCancel={cancelDialog}
        />
      )}
      {dialog.kind === "create" && (
        <CreateBranchDialog
          busy={refreshing}
          error={createError}
          onConfirm={(name) => void runOp("create", null, (id) => createBranch(id, name, null))}
          onCancel={cancelDialog}
        />
      )}
    </>
  );
}

/** 你所在的分支：↑ 金箔、↓ 空心（同工具列；基準 `yours()`）。上游不可得時不畫 */
function YourCounts({ aheadBehind }: { aheadBehind: AheadBehindInfo | null }) {
  if (!aheadBehind) return null;
  const { ahead, behind } = aheadBehind;
  const remote = aheadBehind.upstream_remote ?? "origin";
  return (
    <>
      {ahead > 0 && (
        <span className="b-stats" title={unpushed(ahead)}>
          ↑{ahead}
        </span>
      )}
      {behind > 0 && (
        <span className="b-stats in" title={unpulled(behind, remote)}>
          ↓{behind}
        </span>
      )}
    </>
  );
}

/** 其他本機分支：只有灰字，金箔留給你所在的線（0b Q4 (b)；基準 `others()`）。沒有 remote 就沒得比 */
function OtherCounts({
  stats,
  branch,
  remotes,
}: {
  stats: BranchStats | undefined;
  branch: BranchInfo;
  remotes: readonly string[];
}) {
  const a = stats?.ahead ?? 0;
  const d = stats?.behind ?? 0;
  if (!a && !d) return null;
  const remote = branch.upstream ? remoteOf(branch.upstream.name, remotes) : "origin";
  const title = [a && unpushed(a), d && unpulled(d, remote)].filter(Boolean).join(" · ");
  return (
    <span className="b-stats plain" title={title}>
      {[a && `↑${a}`, d && `↓${d}`].filter(Boolean).join(" ")}
    </span>
  );
}
