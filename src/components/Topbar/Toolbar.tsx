import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useRepoStore } from "@/stores/repoStore";
import { useNoticeStore } from "@/stores/noticeStore";
import { useShellBusy } from "@/hooks/useShellBusy";
import { pushBranch, pullBranch, transportErrorNotice, type GitProgressEvent } from "@/lib/tauri";

// v8 基準站牌的 Pull / Push / Refresh（0b §1–§2）。三顆要是 .tools 的直接子節點（間距靠 .tools 的
// gap），所以回傳 fragment。停用的按鈕在 title 說原因，順序：忙碌 → unborn → detached → 沒 remote →
// 未知 →（Pull）沒 upstream /（Push）沒東西可推。忙碌時三顆一起停，忙碌字樣寫在按下的那顆裡。
interface ToolbarProps {
  repoId: string;
  /** HEAD 指向還沒有 commit 的分支（graph 的 HeadInfo：branch 有值、oid 為 null）。repoInfo.head_branch
   *  此時是 null，不判斷的話理由會寫成 detached */
  unborn: boolean;
  /** 使用者按 Refresh：清提示、全刷（含 PR） */
  onRefresh: () => void;
  /** push / pull 成功後重載 graph */
  onTransportDone: () => void;
}

export function Toolbar({ repoId, unborn, onRefresh, onTransportDone }: ToolbarProps) {
  const repoInfo = useRepoStore((s) => s.repoInfo);
  const pushPull = useRepoStore((s) => s.pushPull);
  const aheadBehind = useRepoStore((s) => s.aheadBehind);
  const startPushPull = useRepoStore((s) => s.startPushPull);
  const updateProgress = useRepoStore((s) => s.updateProgress);
  const clearPushPull = useRepoStore((s) => s.clearPushPull);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<GitProgressEvent>("git-progress", (event) => {
      const payload = event.payload;
      if (payload.repo_id !== repoId) return;
      const currentOp = useRepoStore.getState().pushPull.op;
      if (currentOp === null || payload.op !== currentOp) return;
      updateProgress(payload.percent);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.error("[kira] failed to listen git-progress:", err);
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [repoId, updateProgress]);

  const transportOp = pushPull.op !== null && pushPull.repoId === repoId ? pushPull.op : null;
  const busy = useShellBusy(repoId);

  const branch = repoInfo?.head_branch ?? null;
  const remote = repoInfo?.remotes.find((r) => r === "origin") ?? repoInfo?.remotes[0] ?? null;
  // aheadBehind 為 null = 上游狀態未知（開 repo 載入中、讀取失敗）：兩顆都停、不顯示計數、標籤維持 Push
  const blocked = busy
    ? `Disabled while ${busy}`
    : unborn
      ? "No commits yet"
      : !branch
        ? "Detached HEAD — check out a branch first"
        : !remote
          ? "No remote configured"
          : !aheadBehind
            ? "Upstream status unknown — Refresh to retry"
            : null;

  const hasUpstream = aheadBehind !== null && aheadBehind.has_upstream;
  // 計數照 upstream 算：有 upstream 且追蹤 ref 解析得到。upstream 有設定卻解析不到（被 prune）時計數
  // 不可得：兩顆照常能按、不顯示計數（子超裁定 H；pull 會重新 fetch）
  const tracked = aheadBehind !== null && aheadBehind.has_upstream && aheadBehind.tracking_ref_exists;
  const ahead = tracked ? aheadBehind.ahead : 0;
  const behind = tracked ? aheadBehind.behind : 0;
  // 沒 upstream 的分支：第一次推送順便 track，按鈕改叫 Publish。只有這時才帶 set_upstream——
  // 解析不到或在別處的 upstream 仍是設定好的，不能蓋掉
  const publish = aheadBehind !== null && !aheadBehind.has_upstream && !!branch && !!remote;
  // ⚑ 沒東西可推時 Push 停用——只在計數描述的就是 Push 要去的地方（同一個 remote 的同名分支）時成立。
  // upstream 在別處（fork：追蹤 upstream/main、Push 推 origin；從 origin/main 開的分支）時 ahead 0 不代表
  // origin 那邊沒缺，Push 照常能按，計數同 main 照 upstream 顯示（子超裁定 I）
  const nothingToPush =
    tracked &&
    ahead === 0 &&
    aheadBehind.upstream_remote === remote &&
    aheadBehind.upstream_branch === branch;
  const pullDisabled = blocked !== null || !hasUpstream;
  const pushDisabled = blocked !== null || nothingToPush;

  const from = remote ? ` from ${remote}` : "";
  const to = remote ? ` to ${remote}` : "";

  const pullTitle =
    transportOp === "pull"
      ? `Pulling${from}…`
      : (blocked ?? (hasUpstream ? `Pull${from}` : "No upstream — publish this branch first"));
  const pushTitle =
    transportOp === "push"
      ? `${publish ? "Publishing" : "Pushing"}${to}…`
      : (blocked ??
        (publish ? `Publish ${branch} to ${remote} and track it` : nothingToPush ? "Nothing to push" : `Push${to}`));
  // 推送中標籤是百分比；小 packfile 可能整段都沒有進度事件（percent 一直是 null），照基準第一格寫 0%
  const pushLabel = transportOp === "push" ? `${pushPull.percent ?? 0}%` : publish ? "Publish" : "Push";

  // settle path 共用 guard：repo 切換或新 op 開始後，舊請求 resolve/reject 不能覆蓋新狀態
  const ifStillOurOp = (op: "push" | "pull", action: () => void) => {
    const s = useRepoStore.getState().pushPull;
    if (s.repoId === repoId && s.op === op) action();
  };

  const runOp = async (op: "push" | "pull") => {
    if (!branch || !remote || (op === "pull" ? pullDisabled : pushDisabled)) return;
    const verb = op === "pull" ? "Pull" : publish ? "Publish" : "Push";
    useNoticeStore.getState().clear();
    startPushPull(op, repoId);
    try {
      if (op === "push") {
        const result = await pushBranch(repoId, remote, branch, publish);
        // Partial success: push succeeded but set_upstream attempt failed. The
        // next aheadBehind read sees has_upstream=false again, so the button
        // says Publish and the user can retry; just record it.
        if (result.upstream_set === false) {
          console.warn("[kira] push succeeded but set_upstream failed");
        }
      } else {
        await pullBranch(repoId, remote, branch);
      }
      ifStillOurOp(op, clearPushPull);
      if (useRepoStore.getState().repoId === repoId) onTransportDone();
    } catch (err) {
      // Redact: log only the classified code, not the raw error object,
      // which can carry remote URLs / paths through git2's transparent variant.
      const code =
        typeof err === "object" && err !== null && "code" in err ? (err as { code: string }).code : "UNKNOWN";
      console.error(`[kira] ${op} failed: code=${code}`);
      ifStillOurOp(op, () => {
        clearPushPull();
        useNoticeStore.getState().show({ ...transportErrorNotice(verb, err), from: op });
      });
    }
  };

  return (
    <>
      <button
        className="btn"
        id="pull"
        type="button"
        disabled={pullDisabled}
        title={pullTitle}
        onClick={() => void runOp("pull")}
      >
        <svg aria-hidden="true">
          <use href="#i-down" />
        </svg>
        <span className="label">{transportOp === "pull" ? "Pulling…" : "Pull"}</span>
        {/* 落後的 commit 還不是你的：空心計數（金箔是你的） */}
        {behind > 0 && (
          <span className="count in" id="behind">
            {behind}
          </span>
        )}
      </button>
      <button
        className="btn"
        id="push"
        type="button"
        disabled={pushDisabled}
        title={pushTitle}
        onClick={() => void runOp("push")}
      >
        <svg aria-hidden="true">
          <use href="#i-up" />
        </svg>
        <span className="label">{pushLabel}</span>
        {ahead > 0 && (
          <span className="count" id="ahead">
            {ahead}
          </span>
        )}
      </button>
      <button
        className={busy === "refreshing" ? "btn ghost spin" : "btn ghost"}
        id="refresh"
        type="button"
        disabled={busy !== null}
        title={busy && busy !== "refreshing" ? `Disabled while ${busy}` : "Reload commit graph and working tree status"}
        onClick={onRefresh}
      >
        <svg aria-hidden="true">
          <use href="#i-refresh" />
        </svg>
        <span className="label">{busy === "refreshing" ? "Refreshing…" : "Refresh"}</span>
      </button>
    </>
  );
}
