import { useRepoStore } from "@/stores/repoStore";

export type ShellBusy = "committing" | "pushing" | "pulling" | "refreshing";

function busyOf(
  repoId: string | null,
  s: { commitLoading: boolean; refreshing: boolean; refreshSource: "user" | "background" | null; pushPull: { op: "push" | "pull" | null; repoId: string | null } },
  countBackgroundRefresh: boolean,
): ShellBusy | null {
  const transportOp = s.pushPull.op !== null && s.pushPull.repoId === repoId ? s.pushPull.op : null;
  if (transportOp === "push") return "pushing";
  if (transportOp === "pull") return "pulling";
  if (s.commitLoading) return "committing";
  if (s.refreshing && (countBackgroundRefresh || s.refreshSource !== "background")) return "refreshing";
  return null;
}

function useBusy(repoId: string | null, countBackgroundRefresh: boolean): ShellBusy | null {
  const commitLoading = useRepoStore((s) => s.commitLoading);
  const refreshing = useRepoStore((s) => s.refreshing);
  const refreshSource = useRepoStore((s) => s.refreshSource);
  const pushPull = useRepoStore((s) => s.pushPull);
  return busyOf(repoId, { commitLoading, refreshing, refreshSource, pushPull }, countBackgroundRefresh);
}

/**
 * 殼層操作進行中（工具列與側欄共用；基準的 `busy` / `VERB`）：這個 repo 的 push / pull > commit > refresh。
 * refresh 包含分支操作與 watcher 觸發的背景 refresh（同一個 `refreshing` 旗標）。
 * 標題一律「Disabled while <這個字>」
 */
export function useShellBusy(repoId: string | null): ShellBusy | null {
  return useBusy(repoId, true);
}

/**
 * Changes 的 Commit 與全部 stage 用：只有使用者發起的忙碌擋（commit / push / pull / 按的 Refresh / 分支操作），
 * watcher 與 focus 的背景 refresh 不擋——基準的 busy 沒有背景這回事，而每次 stage 後 400ms watcher 必然 refresh，
 * 擋了的話「stage → 打訊息 → ⌘↩」在大 repo 上每次都有一段被靜默吞掉的窗（獨立審查員 CL-1）。
 * 來源不明的 refresh（null）當作使用者的
 */
export function useUserBusy(repoId: string | null): ShellBusy | null {
  return useBusy(repoId, false);
}
