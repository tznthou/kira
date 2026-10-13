import { create } from "zustand";
import { getRecentRepos, type RecentRepo } from "@/lib/tauri";

// Disk source of truth + frontend mirror。**不用 zustand persist**——若同時用
// localStorage 持久化會與 disk JSON 不一致；refresh() 永遠以 IPC 回傳為準。
// requestId 防 boot race：refresh 慢回覆覆蓋剛 open 後的新 list
//（同 repoStore.aheadBehindRequestId pattern）。
interface RecentReposState {
  recent: RecentRepo[];
  requestId: number;
}

interface RecentReposActions {
  refresh: () => Promise<void>;
}

type RecentReposStore = RecentReposState & RecentReposActions;

export const useRecentReposStore = create<RecentReposStore>((set, get) => ({
  recent: [],
  requestId: 0,

  refresh: async () => {
    const myRequestId = get().requestId + 1;
    set({ requestId: myRequestId });
    try {
      const recent = await getRecentRepos();
      // 較新請求已啟動 → 丟棄這次回傳（避免 boot/open race 覆蓋）
      if (get().requestId !== myRequestId) return;
      set({ recent });
    } catch (err) {
      if (get().requestId !== myRequestId) return;
      console.error("[kira] refresh recent repos failed:", err);
    }
  },
}));
