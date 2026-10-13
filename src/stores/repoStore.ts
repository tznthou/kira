import { create } from "zustand";
import {
  getAheadBehind,
  getBranchStats,
  getGraph,
  getRepoInfo,
  getStatus,
  listBranches,
} from "@/lib/tauri";
import type {
  AheadBehindInfo,
  BranchInfo,
  BranchStats,
  RepoInfo,
  WorkingTreeStatus,
} from "@/lib/tauri";
import { useGraphStore } from "@/stores/graphStore";

// 失敗不留在這裡：工具列把它寫進站牌的提示（noticeStore），op 隨即清掉
interface PushPullState {
  op: "push" | "pull" | null;
  repoId: string | null;
  percent: number | null;
}

interface RepoState {
  repoId: string | null;
  repoInfo: RepoInfo | null;
  // null = 還沒讀到（開 repo 時清空，Changes 畫骨架）——或，與 statusError 一起，讀不到
  workingTreeStatus: WorkingTreeStatus | null;
  // status 讀不到（Phase 5 5c step 4，Codex #1 + Q-S）：開 repo、使用者操作後的重讀、Retry 失敗時 true，Changes
  // 區畫一行錯誤 + Retry、Commit 停用；watcher / focus 的背景重讀失敗不設，留著舊清單
  statusError: boolean;
  // refreshStatus 的請求序號（每次讀領一個）與「上一次寫進畫面的是哪一次」：
  // - 成功的結果比上一次寫入的新就採用。stage 後的重讀還沒回來，watcher 就再發了一次背景重讀（index 改了，
  //   400ms 後必然觸發）：第一次的清單仍是對的，丟掉的話第二次若失敗，留下的是 stage 之前的清單（側 agent 提醒）
  // - 失敗的結果只有最新一次的算：更早發出的失敗不推翻還在飛的那次（Retry；Codex #1 舊回覆推翻 Retry）
  // 先發後到的舊清單照樣丟（序號比寫入的小）。換 repo 時 applyOpenResult 把兩個都 bump，舊請求作廢
  // （同一個路徑重開拿回同一個 repoId，只比 repoId 不夠）
  // - 使用者還在等的那次（statusUserPendingId）：被背景重讀超車了也算數——兩次都失敗時不能由背景的那次替它
  //   留舊清單（Codex C-1）；反過來背景的失敗先到時先留著，由它自己的結果決定（Retry 成功就寫進來）。
  //   寫進去的成功序號不比它小就不再等
  statusRequestId: number;
  statusWrittenId: number;
  statusUserPendingId: number | null;
  loading: boolean;
  commitLoading: boolean;
  // refresh in-flight 時工具列 disable — 跨 repoInfo / aheadBehind settle 視角
  // 不一致會讓 push 用錯 setUpstream flag。lift 進 store 讓工具列（Topbar/Toolbar）讀得到。
  refreshing: boolean;
  // refreshing 是誰發起的：使用者（按 Refresh、分支操作）或 watcher / focus 的背景 refresh。Changes 的 Commit 與
  // 全部 stage 只被使用者發起的忙碌擋住（useUserBusy）；工具列與側欄照舊兩種都算（useShellBusy）
  refreshSource: "user" | "background" | null;
  pushPull: PushPullState;
  aheadBehind: AheadBehindInfo | null;
  // Monotonic counter to discard stale refreshAheadBehind responses when
  // multiple triggers (commit/push/pull/open) fire in quick succession.
  aheadBehindRequestId: number;
  // T10 branch list + lazy stats. branches=null means "not yet loaded" — or,
  // with branchesError, "could not be read".
  branches: BranchInfo[] | null;
  detachedHeadOid: string | null;
  // 分支清單讀不到（Phase 5 Q-B，比照 Q-S）：開 repo、使用者操作後的重讀、Retry 失敗時 true，側欄畫一行錯誤
  // + Retry；watcher 的背景重讀失敗不設，留著舊清單
  branchesError: boolean;
  // Per-branch ahead/behind. Lazy: populated after listBranches returns by
  // calling refreshBranchStats(visibleNames). null = not yet fetched.
  branchStats: Record<string, BranchStats>;
  // Epoch guard for refreshBranches — rapid branch switches must not let an
  // older list settle over a newer one (async state scoped by an
  // ownership key).
  // 它也是 refreshing 的歸屬：bump 的人要當下清掉 refreshing（applyOpenResult），或接手、結束時若仍是最新就清
  // （runBranchOp）；handleRefresh 不 bump，只在這個值從它開始以來沒變時才清（App.tsx）。新增一處 bump 卻不處理
  // refreshing，進行中的 refresh 結束時就不會清旗標，app 一直停在忙碌中
  branchOpRequestId: number;
}

interface RepoActions {
  setRepoId: (id: string | null) => void;
  setRepoInfo: (info: RepoInfo | null) => void;
  setWorkingTreeStatus: (status: WorkingTreeStatus | null) => void;
  setLoading: (loading: boolean) => void;
  setCommitLoading: (loading: boolean) => void;
  setRefreshing: (refreshing: boolean, source?: "user" | "background") => void;
  /** source：使用者發起（開 repo、stage / unstage / commit / 分支操作後、按 Refresh、Retry；預設）或 watcher /
   *  focus 的背景重讀。失敗時只有使用者發起的、或還沒有清單的，才清掉清單、說讀不到（Q-S） */
  refreshStatus: (opts?: { source?: "user" | "background" }) => Promise<void>;
  refreshAheadBehind: () => Promise<void>;
  /** false：讀取失敗（repoInfo 已 fail closed 成 null）；沒有 repo、讀完已換 repo 都算 true */
  refreshRepoInfo: () => Promise<boolean>;
  /** source：使用者發起（開 repo、按 Refresh、分支操作後、Retry；預設）或 watcher 的背景重讀 */
  refreshBranches: (opts?: { source?: "user" | "background" }) => Promise<void>;
  refreshBranchStats: (names: string[]) => Promise<void>;
  // Run a mutating branch op (create / delete / checkout) and refresh derived
  // state in the canonical serial order: status → branches → ahead/behind →
  // repo_info. Returns whatever the op returned for caller-side notifications.
  runBranchOp: <T>(op: () => Promise<T>) => Promise<T>;
  startPushPull: (op: "push" | "pull", repoId: string) => void;
  updateProgress: (percent: number | null) => void;
  clearPushPull: () => void;
}

type RepoStore = RepoState & RepoActions;

const INITIAL_PUSH_PULL: PushPullState = {
  op: null,
  repoId: null,
  percent: null,
};

export const useRepoStore = create<RepoStore>((set, get) => ({
  // State
  repoId: null,
  repoInfo: null,
  workingTreeStatus: null,
  statusError: false,
  statusRequestId: 0,
  statusWrittenId: 0,
  statusUserPendingId: null,
  loading: false,
  commitLoading: false,
  refreshing: false,
  refreshSource: null,
  pushPull: INITIAL_PUSH_PULL,
  aheadBehind: null,
  aheadBehindRequestId: 0,
  branches: null,
  detachedHeadOid: null,
  branchesError: false,
  branchStats: {},
  branchOpRequestId: 0,

  // Actions
  setRepoId: (id) => set({ repoId: id }),
  setRepoInfo: (info) => set({ repoInfo: info }),
  setWorkingTreeStatus: (status) => set({ workingTreeStatus: status }),
  setLoading: (loading) => set({ loading }),
  setCommitLoading: (commitLoading) => set({ commitLoading }),
  setRefreshing: (refreshing, source) => set({ refreshing, refreshSource: refreshing ? (source ?? null) : null }),

  refreshStatus: async ({ source = "user" } = {}) => {
    const repoIdAtStart = get().repoId;
    if (!repoIdAtStart) return;
    // 每次讀都領新的序號（規則見 statusRequestId 的欄位註解）；使用者的讀記成「還在等的那次」
    const myRequestId = get().statusRequestId + 1;
    set({ statusRequestId: myRequestId, ...(source === "user" ? { statusUserPendingId: myRequestId } : {}) });
    // 使用者再讀一次（Retry）：錯誤先收掉，讀的期間畫骨架（清單本來就是空的）
    if (source === "user" && get().statusError) set({ statusError: false });
    try {
      const status = await getStatus(repoIdAtStart);
      // 成功：比上一次寫進畫面的新就寫（等它的期間又發了一次也一樣）；先發後到的舊清單丟掉。
      // 寫進來的這份序號不比使用者在等的那次小 → 不再等
      if (get().repoId !== repoIdAtStart || myRequestId <= get().statusWrittenId) return;
      set((s) => ({
        workingTreeStatus: status,
        statusError: false,
        statusWrittenId: myRequestId,
        statusUserPendingId:
          s.statusUserPendingId !== null && myRequestId >= s.statusUserPendingId ? null : s.statusUserPendingId,
      }));
    } catch (err) {
      if (get().repoId !== repoIdAtStart) return;
      const s = get();
      // 失敗算數的條件：最新一次，或它就是使用者還在等的那次（被背景重讀超車也算）
      if (s.statusRequestId !== myRequestId && !(source === "user" && s.statusUserPendingId === myRequestId)) return;
      console.error("[kira] refreshStatus failed:", err);
      // 背景重讀失敗：手上有清單就留著、不顯示錯誤（Q-S）；使用者的讀還在飛也先留著，由它自己的結果決定（成功就
      // 寫進來，失敗就清掉）。使用者操作後的重讀、或還沒有清單也沒有人在等（開 repo）：清掉，Changes 說讀不到——
      // stage 成功但重讀失敗時，舊清單會說你剛 stage 的檔還沒 stage。失敗不進站牌：Refresh 的 Promise.all 裡它
      // 自己吞掉（0b P5 §3.1）
      if (source === "background" && (s.workingTreeStatus !== null || s.statusUserPendingId !== null)) return;
      // 只有使用者的失敗蓋寫入序：比它早發出的成功是使用者操作之前的畫面，不能回來蓋掉錯誤。背景的失敗不蓋——
      // 比它早發出、之後才到的使用者讀（Retry）仍是對的清單
      set({
        workingTreeStatus: null,
        statusError: true,
        statusUserPendingId: null,
        ...(source === "user" ? { statusWrittenId: myRequestId } : {}),
      });
    }
  },

  refreshAheadBehind: async () => {
    const repoIdAtStart = get().repoId;
    if (!repoIdAtStart) return;
    // Bump request ID before invoke; settle path discards if a newer request
    // has started or repo has switched.
    const myRequestId = get().aheadBehindRequestId + 1;
    set({ aheadBehindRequestId: myRequestId });
    try {
      const info = await getAheadBehind(repoIdAtStart);
      if (
        get().repoId !== repoIdAtStart ||
        get().aheadBehindRequestId !== myRequestId
      ) {
        return;
      }
      set({ aheadBehind: info });
    } catch (err) {
      if (
        get().repoId !== repoIdAtStart ||
        get().aheadBehindRequestId !== myRequestId
      ) {
        return;
      }
      console.error("[kira] refreshAheadBehind failed:", err);
      set({ aheadBehind: null });
    }
  },

  refreshBranches: async ({ source = "user" } = {}) => {
    const repoIdAtStart = get().repoId;
    if (!repoIdAtStart) return;
    // Read (don't bump) the epoch. refreshBranches is a read-only refresh;
    // bumping here would invalidate runBranchOp's own finally check and
    // strand `refreshing: true` (button stays disabled). Callers that need
    // to invalidate in-flight settles bump branchOpRequestId themselves —
    // applyOpenResult on repo switch, runBranchOp on entry.
    // bump 的同時也接下 refreshing 的歸屬（見 branchOpRequestId 的欄位註解）：當下清掉，或持有到結束自己清
    const myRequestId = get().branchOpRequestId;
    // 使用者再讀一次（Retry）：錯誤先收掉，讀的期間畫骨架（清單本來就是空的）
    if (source === "user" && get().branchesError) set({ branchesError: false });
    try {
      const result = await listBranches(repoIdAtStart);
      if (
        get().repoId !== repoIdAtStart ||
        get().branchOpRequestId !== myRequestId
      ) {
        return;
      }
      set({
        branches: result.branches,
        detachedHeadOid: result.detached_head_oid,
        branchesError: false,
      });
    } catch (err) {
      if (
        get().repoId !== repoIdAtStart ||
        get().branchOpRequestId !== myRequestId
      ) {
        return;
      }
      console.error("[kira] refreshBranches failed:", err);
      // 背景重讀失敗、手上有清單：留著，不顯示錯誤（Q-B，比照 Q-S；舊清單可能指向已刪的 ref，點了是
      // checkout 失敗、進站牌提示）。使用者操作後的重讀、或還沒有清單：清掉，側欄說讀不到——
      // checkout 成功後讀不到時，舊清單的「目前分支」會跟站牌對不上
      if (source === "background" && get().branches !== null) return;
      set({ branches: null, detachedHeadOid: null, branchesError: true });
    }
  },

  refreshBranchStats: async (names) => {
    const repoIdAtStart = get().repoId;
    if (!repoIdAtStart || names.length === 0) return;
    // Reuse branchOpRequestId so a list refresh invalidates any in-flight
    // stats request — keeps "stats apply to current list" invariant.
    const myRequestId = get().branchOpRequestId;
    try {
      const stats = await getBranchStats(repoIdAtStart, names);
      if (
        get().repoId !== repoIdAtStart ||
        get().branchOpRequestId !== myRequestId
      ) {
        return;
      }
      // 後端省略不認得的名字（讀清單與讀 stats 之間被刪掉的分支）：問過的一律記一筆，沒有的記成不知道。
      // 不記的話側欄看它還缺，馬上再問一次，一直問到下次重讀清單（每輪都換新的 branchStats 物件）
      const answered = Object.fromEntries(names.map((n) => [n, stats[n] ?? { ahead: null, behind: null }]));
      set((s) => ({ branchStats: { ...s.branchStats, ...answered } }));
    } catch (err) {
      if (
        get().repoId !== repoIdAtStart ||
        get().branchOpRequestId !== myRequestId
      ) {
        return;
      }
      console.error("[kira] refreshBranchStats failed:", err);
      // Per-branch failure does not clear the whole map — backend already
      // returns null/null for individual branches that can't compute.
    }
  },

  // 失敗 fail closed → null，比保留 stale head_branch 安全（避免用戶對 stale branch
  // 按 Push）。無 epoch counter，只守 repoId 切換。呼叫點：Refresh（使用者按 / watcher）、commit 後
  // 重載、分支操作後——同一個 repo 裡晚到的舊結果會蓋掉新的，等下一次 refresh 修正（graph 寫入同樣
  // 沒有共用 epoch，已知限制）。失敗要不要提示由呼叫端決定（回傳 false）
  refreshRepoInfo: async () => {
    const repoIdAtStart = get().repoId;
    if (!repoIdAtStart) return true;
    try {
      const info = await getRepoInfo(repoIdAtStart);
      if (get().repoId !== repoIdAtStart) return true;
      set({ repoInfo: info });
      return true;
    } catch (err) {
      if (get().repoId !== repoIdAtStart) return true;
      console.error("[kira] refreshRepoInfo failed:", err);
      set({ repoInfo: null });
      return false;
    }
  },

  runBranchOp: async <T,>(op: () => Promise<T>) => {
    const repoIdAtStart = get().repoId;
    // Caller (BranchList dialog handlers) already gates on repoId; this is a
    // belt-and-braces narrowing for the graph reload below.
    if (!repoIdAtStart) {
      return op();
    }
    // Bump the epoch BEFORE the op so any in-flight refreshBranches /
    // refreshBranchStats settles started during the previous op are
    // invalidated by their own ownership guard. Also acts as the per-op
    // identity for the serial fan-out below (Codex review finding).
    const myRequestId = get().branchOpRequestId + 1;
    set({ branchOpRequestId: myRequestId, refreshing: true, refreshSource: "user" });
    try {
      const result = await op();
      if (
        get().repoId !== repoIdAtStart ||
        get().branchOpRequestId !== myRequestId
      ) {
        return result;
      }
      // Serial refresh order: avoid mixed-state
      // window where the BranchList rendered with new HEAD while status / graph
      // still reflect the previous one. Graph reload is included so create /
      // delete don't leave stale branch labels next to commit nodes.
      await get().refreshRepoInfo();
      await get().refreshBranches({ source: "user" });
      await get().refreshStatus({ source: "user" });
      await get().refreshAheadBehind();
      try {
        const graph = await getGraph(repoIdAtStart);
        if (
          get().repoId === repoIdAtStart &&
          get().branchOpRequestId === myRequestId
        ) {
          useGraphStore.getState().actions.setGraphData(graph);
        }
      } catch (err) {
        console.error("[kira] runBranchOp graph reload failed:", err);
      }
      return result;
    } finally {
      // Only clear `refreshing` if this is still the latest op; otherwise a
      // newer op holds the flag.
      if (get().branchOpRequestId === myRequestId) {
        set({ refreshing: false, refreshSource: null });
      }
    }
  },

  startPushPull: (op, repoId) =>
    set({ pushPull: { op, repoId, percent: null } }),
  updateProgress: (percent) =>
    set((s) => ({ pushPull: { ...s.pushPull, percent } })),
  clearPushPull: () => set({ pushPull: INITIAL_PUSH_PULL }),
}));
