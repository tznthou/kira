import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, act, fireEvent } from "@testing-library/react";
import App from "@/App";
import { useRepoStore } from "@/stores/repoStore";
import { useGraphStore } from "@/stores/graphStore";
import { useRecentReposStore } from "@/stores/recentReposStore";
import type { BranchInfo, GraphData } from "@/lib/tauri";

// 分支操作還在跑的時候換了 repo：換 repo 讓舊操作不再是最新的那次，它結束時不清 refreshing。
// 新 repo 不能因此一直「Disabled while refreshing」，watcher 也不能因此一直跳過
const h = vi.hoisted(() => ({
  externalChange: null as ((e: { payload: { repo_id: string } }) => void) | null,
}));

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    getRepoInfo: vi.fn(),
    getAheadBehind: vi.fn(),
    getStatus: vi.fn(),
    getGraph: vi.fn(),
    listBranches: vi.fn(),
    getBranchStats: vi.fn(),
    githubGetAuthStatus: vi.fn(),
    getRecentRepos: vi.fn(),
    openRecentRepo: vi.fn(),
    checkoutBranch: vi.fn(),
    homeDir: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (e: { payload: { repo_id: string } }) => void) => {
    if (name === "repo:external-change") h.externalChange = handler;
    return Promise.resolve(() => undefined);
  }),
}));

import {
  getRepoInfo,
  getAheadBehind,
  getStatus,
  getGraph,
  listBranches,
  getBranchStats,
  githubGetAuthStatus,
  getRecentRepos,
  openRecentRepo,
  checkoutBranch,
  homeDir,
} from "@/lib/tauri";

const mocked = {
  getRepoInfo: vi.mocked(getRepoInfo),
  getAheadBehind: vi.mocked(getAheadBehind),
  getStatus: vi.mocked(getStatus),
  getGraph: vi.mocked(getGraph),
  listBranches: vi.mocked(listBranches),
  getBranchStats: vi.mocked(getBranchStats),
  githubGetAuthStatus: vi.mocked(githubGetAuthStatus),
  getRecentRepos: vi.mocked(getRecentRepos),
  openRecentRepo: vi.mocked(openRecentRepo),
  checkoutBranch: vi.mocked(checkoutBranch),
  homeDir: vi.mocked(homeDir),
};

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBBBBBBB";
const INFO = { path: "/tmp/repo", head_branch: "main", branches: [], remotes: ["origin"] };
const OTHER_INFO = { path: "/tmp/other", head_branch: "main", branches: [], remotes: ["origin"] };
const EMPTY_GRAPH = {
  commits: [],
  branches: [],
  tags: [],
  truncated: false,
  head: { oid: null, branch: null },
  default_branch: null,
};
const local = (name: string, extra: Partial<BranchInfo> = {}): BranchInfo => ({
  name,
  is_current: false,
  is_remote: false,
  upstream: null,
  ...extra,
});
const BRANCHES = [local("main", { is_current: true }), local("feature")];

describe("App: switching repo while a branch operation runs", () => {
  beforeEach(() => {
    h.externalChange = null;
    Object.values(mocked).forEach((m) => m.mockReset());
    mocked.githubGetAuthStatus.mockResolvedValue({ authenticated: false, username: null });
    mocked.getStatus.mockResolvedValue({ staged: [], unstaged: [], conflicted: [], unstaged_truncated: false });
    mocked.getGraph.mockResolvedValue(EMPTY_GRAPH);
    mocked.getAheadBehind.mockResolvedValue({
      ahead: 0,
      behind: 0,
      has_upstream: false,
      tracking_ref_exists: false,
      upstream_remote: null,
      upstream_branch: null,
    });
    mocked.getRepoInfo.mockResolvedValue(INFO);
    mocked.listBranches.mockResolvedValue({ branches: BRANCHES, detached_head_oid: null });
    mocked.getBranchStats.mockResolvedValue({});
    mocked.getRecentRepos.mockResolvedValue([{ path: OTHER_INFO.path, last_opened: 1715731200 }]);
    mocked.openRecentRepo.mockResolvedValue({ repo_id: OTHER, info: OTHER_INFO });
    mocked.homeDir.mockResolvedValue("/Users/x");

    useRepoStore.setState({
      repoId: REPO,
      repoInfo: INFO,
      workingTreeStatus: { staged: [], unstaged: [], conflicted: [], unstaged_truncated: false },
      loading: false,
      commitLoading: false,
      refreshing: false,
      pushPull: { op: null, repoId: null, percent: null },
      aheadBehind: null,
      aheadBehindRequestId: 0,
      branches: BRANCHES,
      branchesError: false,
      detachedHeadOid: null,
      branchStats: {},
      branchOpRequestId: 0,
    });
    useRecentReposStore.setState({ recent: [{ path: OTHER_INFO.path, last_opened: 1715731200 }] });
    useGraphStore.getState().actions.setRepoId(REPO);
    useGraphStore.getState().actions.setGraphData(EMPTY_GRAPH);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("test_repoSwitch_duringABranchOp_leavesTheNewRepoUsable", async () => {
    let finish!: (v: { head_branch: string }) => void;
    mocked.checkoutBranch.mockReturnValue(new Promise((r) => (finish = r)));
    const { container, getByText, getByRole } = render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());

    // repo A：checkout 還在跑
    fireEvent.click(container.querySelector<HTMLElement>('.branch-btn[data-branch="feature"]')!);
    fireEvent.click(getByText("Safe"));
    expect(useRepoStore.getState().refreshing).toBe(true);

    // 換到 repo B（jsdom 不管遮罩擋不擋得到點擊；app 裡這條路曾經由 Escape 關掉對話框打開）
    const watcherOfA = h.externalChange;
    await act(async () => {
      fireEvent.click(container.querySelector<HTMLElement>(".repo-item")!);
    });
    await waitFor(() => expect(useRepoStore.getState().repoId).toBe(OTHER));
    await waitFor(() => expect(h.externalChange).not.toBe(watcherOfA));

    // A 的 checkout 這時才結束
    await act(async () => {
      finish({ head_branch: "feature" });
    });

    expect(useRepoStore.getState().refreshing).toBe(false);
    expect((getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(false);
    mocked.getGraph.mockClear();
    await act(async () => {
      h.externalChange!({ payload: { repo_id: OTHER } });
    });
    await waitFor(() => expect(mocked.getGraph).toHaveBeenCalledWith(OTHER));
  });

  // 換 repo 時清掉旗標，新 repo 才能用；之後舊 repo 的 refresh 晚到結束，不能清掉新 repo 正在跑的操作的旗標
  it("test_repoSwitch_anOldRefreshEndingLate_leavesTheNewRepoBusy", async () => {
    let graphOfA!: (g: GraphData) => void;
    mocked.getGraph.mockImplementation((id: string) =>
      id === REPO ? new Promise<GraphData>((r) => (graphOfA = r)) : Promise.resolve(EMPTY_GRAPH),
    );
    mocked.checkoutBranch.mockReturnValue(new Promise(() => undefined));
    const { container, getByText } = render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());

    // repo A：watcher 的 refresh 還在等 graph
    await act(async () => {
      h.externalChange!({ payload: { repo_id: REPO } });
    });
    expect(useRepoStore.getState().refreshing).toBe(true);

    // 換到 repo B，B 開始 checkout
    await act(async () => {
      fireEvent.click(container.querySelector<HTMLElement>(".repo-item")!);
    });
    await waitFor(() => expect(useRepoStore.getState().repoId).toBe(OTHER));
    await waitFor(() => expect(useRepoStore.getState().branches).not.toBeNull());
    fireEvent.click(container.querySelector<HTMLElement>('.branch-btn[data-branch="feature"]')!);
    fireEvent.click(getByText("Safe"));
    expect(useRepoStore.getState().refreshing).toBe(true);

    // A 的 refresh 這時才結束
    await act(async () => {
      graphOfA(EMPTY_GRAPH);
    });
    expect(useRepoStore.getState().refreshing).toBe(true);
  });

  // 同一個路徑重開拿回同一個 repoId（後端照路徑登記）：只比 repoId 擋不住，A → B → A 之後舊的 A refresh 照樣不能清
  it("test_repoSwitch_backToTheSameRepo_anOldRefreshStillLeavesItBusy", async () => {
    let graphOfA!: (g: GraphData) => void;
    let firstA = true;
    mocked.getGraph.mockImplementation((id: string) => {
      if (id === REPO && firstA) {
        firstA = false;
        return new Promise<GraphData>((r) => (graphOfA = r));
      }
      return Promise.resolve(EMPTY_GRAPH);
    });
    mocked.checkoutBranch.mockReturnValue(new Promise(() => undefined));
    const recent = [
      { path: OTHER_INFO.path, last_opened: 1715731200 },
      { path: INFO.path, last_opened: 1715644800 },
    ];
    mocked.getRecentRepos.mockResolvedValue(recent);
    useRecentReposStore.setState({ recent });
    mocked.openRecentRepo.mockImplementation((path: string) =>
      Promise.resolve(path === INFO.path ? { repo_id: REPO, info: INFO } : { repo_id: OTHER, info: OTHER_INFO }),
    );
    const { container, getByText } = render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    const openRecent = async (path: string, id: string) => {
      await act(async () => {
        fireEvent.click(container.querySelector<HTMLElement>(`.repo-item[title="${path}"]`)!);
      });
      await waitFor(() => expect(useRepoStore.getState().repoId).toBe(id));
      await waitFor(() => expect(useRepoStore.getState().branches).not.toBeNull());
    };

    // A 的 watcher refresh 還在等 graph；換到 B、再開回 A，A 開始 checkout
    await act(async () => {
      h.externalChange!({ payload: { repo_id: REPO } });
    });
    await openRecent(OTHER_INFO.path, OTHER);
    await openRecent(INFO.path, REPO);
    fireEvent.click(container.querySelector<HTMLElement>('.branch-btn[data-branch="feature"]')!);
    fireEvent.click(getByText("Safe"));
    expect(useRepoStore.getState().refreshing).toBe(true);

    // 舊的 A refresh 這時才結束
    await act(async () => {
      graphOfA(EMPTY_GRAPH);
    });
    expect(useRepoStore.getState().refreshing).toBe(true);
  });
});
