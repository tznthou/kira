import { create } from "zustand";
import type { CommitNode, GraphData } from "../lib/tauri";

interface GraphState {
  graphData: GraphData | null;
  selectedCommit: CommitNode | null;
  /** 這次選取來自按住方向鍵的自動重複：diff 區對大 diff 等放開才畫（小 diff 照樣即時預覽） */
  selectionFromRepeat: boolean;
  repoId: string | null;
  loading: boolean;
  error: string | null;
  actions: {
    setGraphData: (data: GraphData | null) => void;
    /** 採用一份 graph 並同時選取：開 repo 選 HEAD、commit 後選新的 HEAD。同一次 store 更新，
     *  畫面不會先出現新 graph、下一輪才選到 */
    adoptGraph: (data: GraphData, select: CommitNode | null) => void;
    setSelectedCommit: (commit: CommitNode | null, fromRepeat?: boolean) => void;
    setRepoId: (id: string | null) => void;
    setLoading: (loading: boolean) => void;
    setError: (error: string | null) => void;
  };
}

export const useGraphStore = create<GraphState>((set) => ({
  graphData: null,
  selectedCommit: null,
  selectionFromRepeat: false,
  repoId: null,
  loading: false,
  error: null,
  actions: {
    setGraphData: (data) => set({ graphData: data }),
    adoptGraph: (data, select) => set({ graphData: data, selectedCommit: select, selectionFromRepeat: false }),
    setSelectedCommit: (commit, fromRepeat = false) => set({ selectedCommit: commit, selectionFromRepeat: fromRepeat }),
    setRepoId: (id) => set({ repoId: id }),
    setLoading: (loading) => set({ loading }),
    setError: (error) => set({ error }),
  },
}));
