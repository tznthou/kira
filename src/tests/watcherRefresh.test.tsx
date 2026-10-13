import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, act } from "@testing-library/react";
import App from "@/App";
import { useRepoStore } from "@/stores/repoStore";
import { useGraphStore } from "@/stores/graphStore";

// 捕獲 App 掛上的 repo:external-change handler。vi.mock 工廠被 hoist 到檔案頂，
// 不能引用一般外部變數 → 用 vi.hoisted 共享一個 ref。
const h = vi.hoisted(() => ({
  externalChange: null as ((e: { payload: { repo_id: string } }) => void) | null,
}));

vi.mock("@/lib/tauri", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    getRepoInfo: vi.fn(),
    getAheadBehind: vi.fn(),
    getStatus: vi.fn(),
    getGraph: vi.fn(),
    listBranches: vi.fn(),
    githubGetAuthStatus: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (name: string, handler: (e: { payload: { repo_id: string } }) => void) => {
      if (name === "repo:external-change") h.externalChange = handler;
      return Promise.resolve(() => undefined);
    },
  ),
}));

import {
  getRepoInfo,
  getAheadBehind,
  getStatus,
  getGraph,
  listBranches,
  githubGetAuthStatus,
} from "@/lib/tauri";

const mocked = {
  getRepoInfo: vi.mocked(getRepoInfo),
  getAheadBehind: vi.mocked(getAheadBehind),
  getStatus: vi.mocked(getStatus),
  getGraph: vi.mocked(getGraph),
  listBranches: vi.mocked(listBranches),
  githubGetAuthStatus: vi.mocked(githubGetAuthStatus),
};

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBBBBBBB";

describe("App T9d watcher integration", () => {
  beforeEach(() => {
    h.externalChange = null;
    Object.values(mocked).forEach((m) => m.mockReset());
    mocked.githubGetAuthStatus.mockResolvedValue({
      authenticated: false,
      username: null,
    });
    mocked.getStatus.mockResolvedValue({
      staged: [],
      unstaged: [],
      conflicted: [],
      unstaged_truncated: false,
    });
    mocked.getGraph.mockResolvedValue({
      commits: [],
      branches: [],
      tags: [],
      truncated: false,
      head: { oid: null, branch: null },
      default_branch: null,
    });
    mocked.getAheadBehind.mockResolvedValue({
      ahead: 0,
      behind: 0,
      has_upstream: false,
      tracking_ref_exists: false,
      upstream_remote: null,
      upstream_branch: null,
    });
    mocked.getRepoInfo.mockResolvedValue({
      path: "/tmp/repo",
      head_branch: "main",
      branches: [],
      remotes: [],
    });
    mocked.listBranches.mockResolvedValue({
      branches: [],
      detached_head_oid: null,
    });

    useRepoStore.setState({
      repoId: REPO,
      repoInfo: {
        path: "/tmp/repo",
        head_branch: "main",
        branches: [],
        remotes: ["origin"],
      },
      workingTreeStatus: { staged: [], unstaged: [], conflicted: [], unstaged_truncated: false },
      loading: false,
      commitLoading: false,
      pushPull: { op: null, repoId: null, percent: null },
      aheadBehind: {
        ahead: 0,
        behind: 0,
        has_upstream: false,
        tracking_ref_exists: false,
        upstream_remote: null,
        upstream_branch: null,
      },
      aheadBehindRequestId: 0,
    });
    useGraphStore.getState().actions.setRepoId(REPO);
    useGraphStore.getState().actions.setGraphData({
      commits: [],
      branches: [],
      tags: [],
      truncated: false,
      head: { oid: null, branch: null },
      default_branch: null,
    });

    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // matching repo_id 的外部變更 → 觸發全刷（handleRefresh → getGraph）。
  it("test_externalChange_matchingRepoId_triggersRefresh", async () => {
    render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    mocked.getGraph.mockClear();

    await act(async () => {
      h.externalChange!({ payload: { repo_id: REPO } });
    });

    await waitFor(() => expect(mocked.getGraph).toHaveBeenCalledWith(REPO));
  });

  // mismatched repo_id（舊 repo 殘留 event）→ filter 擋下，不刷當前 repo。
  it("test_externalChange_mismatchedRepoId_doesNotRefresh", async () => {
    render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    mocked.getGraph.mockClear();

    await act(async () => {
      h.externalChange!({ payload: { repo_id: OTHER } });
    });
    // 給 microtask / 任何誤觸發的 async 機會跑完，再確認沒刷
    await new Promise((r) => setTimeout(r, 30));
    expect(mocked.getGraph).not.toHaveBeenCalled();
  });

  // Phase 5 Q-B：watcher 的背景 refresh 讀不到分支清單 → 留著舊清單、不說讀不到
  it("test_externalChange_branchReadFails_keepsTheList", async () => {
    const list = [{ name: "main", is_current: true, is_remote: false, upstream: null }];
    useRepoStore.setState({ branches: list, branchesError: false });
    render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    mocked.listBranches.mockRejectedValue(new Error("boom"));
    mocked.getGraph.mockClear();

    await act(async () => {
      h.externalChange!({ payload: { repo_id: REPO } });
    });
    await waitFor(() => expect(mocked.listBranches).toHaveBeenCalled());
    await waitFor(() => expect(useRepoStore.getState().refreshing).toBe(false));
    expect(useRepoStore.getState().branches).toEqual(list);
    expect(useRepoStore.getState().branchesError).toBe(false);
  });

  // 按 Refresh 是使用者操作：讀不到就清掉清單、說讀不到（側欄一行 + Retry）
  it("test_refreshButton_branchReadFails_saysTheListCannotBeRead", async () => {
    const list = [{ name: "main", is_current: true, is_remote: false, upstream: null }];
    useRepoStore.setState({ branches: list, branchesError: false });
    const { getByRole } = render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    mocked.listBranches.mockRejectedValue(new Error("boom"));

    await act(async () => {
      getByRole("button", { name: "Refresh" }).click();
    });
    await waitFor(() => expect(useRepoStore.getState().branchesError).toBe(true));
    expect(useRepoStore.getState().branches).toBeNull();
  });

  // refresh 是誰發起的記進 store（Changes 的 Commit 只被使用者發起的忙碌擋住）：watcher 的是背景、按 Refresh 的是使用者
  it("test_refreshSource_watcherIsBackground_buttonIsUser", async () => {
    let finishGraph!: (g: typeof EMPTY) => void;
    const EMPTY = { commits: [], branches: [], tags: [], truncated: false, head: { oid: null, branch: null }, default_branch: null };
    mocked.getGraph.mockImplementation(() => new Promise((r) => (finishGraph = r)));
    const { getByRole } = render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());

    await act(async () => {
      h.externalChange!({ payload: { repo_id: REPO } });
    });
    expect(useRepoStore.getState().refreshing).toBe(true);
    expect(useRepoStore.getState().refreshSource).toBe("background");
    await act(async () => {
      finishGraph(EMPTY);
    });
    await waitFor(() => expect(useRepoStore.getState().refreshing).toBe(false));
    expect(useRepoStore.getState().refreshSource).toBeNull();

    await act(async () => {
      getByRole("button", { name: "Refresh" }).click();
    });
    expect(useRepoStore.getState().refreshing).toBe(true);
    expect(useRepoStore.getState().refreshSource).toBe("user");
    await act(async () => {
      finishGraph(EMPTY);
    });
    await waitFor(() => expect(useRepoStore.getState().refreshing).toBe(false));
  });

  // 視窗 regains focus → 補刷 working tree status（getStatus），補編輯器改檔盲點。
  it("test_windowFocus_triggersStatusRefresh", async () => {
    render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    mocked.getStatus.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(mocked.getStatus).toHaveBeenCalledWith(REPO));
  });
});
