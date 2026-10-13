import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup, act, fireEvent } from "@testing-library/react";
import App from "@/App";
import { useRepoStore } from "@/stores/repoStore";
import { useGraphStore } from "@/stores/graphStore";
import { useNoticeStore } from "@/stores/noticeStore";
import { useRecentReposStore } from "@/stores/recentReposStore";
import type { WorkingTreeStatus } from "@/lib/tauri";

// working tree 讀不到走到 App 的路（Phase 5 5c step 4，Codex #1 + Q-S）：watcher 與視窗 focus 是背景重讀（留著舊清單、
// 不說讀不到），按 Refresh 是使用者操作（清掉、說讀不到，站牌不說 Refresh failed）；開回同一個 repo 時舊的讀晚到不寫入
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
const CLEAN: WorkingTreeStatus = { staged: [], unstaged: [], conflicted: [], unstaged_truncated: false };
const DIRTY: WorkingTreeStatus = {
  staged: [{ path: "a.ts", status: "Modified" }],
  unstaged: [],
  conflicted: [],
  unstaged_truncated: false,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("App: a working tree status that cannot be read", () => {
  beforeEach(() => {
    h.externalChange = null;
    Object.values(mocked).forEach((m) => m.mockReset());
    mocked.githubGetAuthStatus.mockResolvedValue({ authenticated: false, username: null });
    mocked.getStatus.mockResolvedValue(CLEAN);
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
    mocked.listBranches.mockResolvedValue({ branches: [], detached_head_oid: null });
    mocked.getBranchStats.mockResolvedValue({});
    mocked.getRecentRepos.mockResolvedValue([]);
    mocked.homeDir.mockResolvedValue("/Users/x");

    useRepoStore.setState({
      repoId: REPO,
      repoInfo: INFO,
      workingTreeStatus: DIRTY,
      statusError: false,
      statusRequestId: 0,
      statusWrittenId: 0,
      statusUserPendingId: null,
      loading: false,
      commitLoading: false,
      refreshing: false,
      pushPull: { op: null, repoId: null, percent: null },
      aheadBehind: null,
      aheadBehindRequestId: 0,
      branches: [],
      detachedHeadOid: null,
      branchesError: false,
      branchStats: {},
      branchOpRequestId: 0,
    });
    useNoticeStore.setState({ notice: null });
    useRecentReposStore.setState({ recent: [] });
    useGraphStore.getState().actions.setRepoId(REPO);
    useGraphStore.getState().actions.setGraphData(EMPTY_GRAPH);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // watcher 的背景 refresh 讀不到 status → 留著舊清單、不說讀不到
  it("test_externalChange_statusReadFails_keepsTheList", async () => {
    render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    mocked.getStatus.mockRejectedValue(new Error("boom"));

    await act(async () => {
      h.externalChange!({ payload: { repo_id: REPO } });
    });
    await waitFor(() => expect(mocked.getStatus).toHaveBeenCalledWith(REPO));
    await waitFor(() => expect(useRepoStore.getState().refreshing).toBe(false));
    expect(useRepoStore.getState().workingTreeStatus).toEqual(DIRTY);
    expect(useRepoStore.getState().statusError).toBe(false);
  });

  // 視窗 regains focus 的補刷同樣是背景重讀
  it("test_windowFocus_statusReadFails_keepsTheList", async () => {
    render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    mocked.getStatus.mockRejectedValue(new Error("boom"));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(mocked.getStatus).toHaveBeenCalledWith(REPO));
    await act(async () => undefined);
    // 讀真的走過 refreshStatus（序號推進了），不是沒讀所以沒變
    expect(useRepoStore.getState().statusRequestId).toBe(1);
    expect(useRepoStore.getState().workingTreeStatus).toEqual(DIRTY);
    expect(useRepoStore.getState().statusError).toBe(false);
  });

  // 同一個路徑重開、舊的讀晚到的是失敗：新 A 的清單與沒有錯誤的狀態都不動（守門）
  it("test_repoSwitch_backToTheSameRepo_anOldStatusFailureLandingLate_isIgnored", async () => {
    const old = deferred<WorkingTreeStatus>();
    let firstA = true;
    mocked.getStatus.mockImplementation((id: string) => {
      if (id === REPO && firstA) {
        firstA = false;
        return old.promise;
      }
      return Promise.resolve(CLEAN);
    });
    const recent = [
      { path: OTHER_INFO.path, last_opened: 1715731200 },
      { path: INFO.path, last_opened: 1715644800 },
    ];
    mocked.getRecentRepos.mockResolvedValue(recent);
    useRecentReposStore.setState({ recent });
    mocked.openRecentRepo.mockImplementation((path: string) =>
      Promise.resolve(path === INFO.path ? { repo_id: REPO, info: INFO } : { repo_id: OTHER, info: OTHER_INFO }),
    );
    const { container } = render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(mocked.getStatus).toHaveBeenCalledWith(REPO));
    for (const [path, id] of [
      [OTHER_INFO.path, OTHER],
      [INFO.path, REPO],
    ] as const) {
      await act(async () => {
        fireEvent.click(container.querySelector<HTMLElement>(`.repo-item[title="${path}"]`)!);
      });
      await waitFor(() => expect(useRepoStore.getState().repoId).toBe(id));
      await waitFor(() => expect(useRepoStore.getState().workingTreeStatus).not.toBeNull());
    }
    await act(async () => {
      old.reject(new Error("boom"));
      await old.promise.catch(() => undefined);
    });
    expect(useRepoStore.getState().workingTreeStatus).toEqual(CLEAN);
    expect(useRepoStore.getState().statusError).toBe(false);
  });

  // 按 Refresh 是使用者操作：讀不到就清掉清單、Changes 說讀不到；站牌不說 Refresh failed（status 的失敗由那一區自己說）
  it("test_refreshButton_statusReadFails_saysTheListCannotBeRead", async () => {
    const { getByRole } = render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    mocked.getStatus.mockRejectedValue(new Error("boom"));

    await act(async () => {
      getByRole("button", { name: "Refresh" }).click();
    });
    await waitFor(() => expect(useRepoStore.getState().statusError).toBe(true));
    expect(useRepoStore.getState().workingTreeStatus).toBeNull();
    await waitFor(() => expect(useRepoStore.getState().refreshing).toBe(false));
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  // 同一個路徑重開拿回同一個 repoId（後端照路徑登記）：A 的讀還在等、換到 B、再開回 A，舊的那次這時才回來，
  // 不能蓋掉新 A 讀到的清單——只比 repoId 擋不住
  it("test_repoSwitch_backToTheSameRepo_anOldStatusReadLandingLate_isIgnored", async () => {
    const old = deferred<WorkingTreeStatus>();
    let firstA = true;
    mocked.getStatus.mockImplementation((id: string) => {
      if (id === REPO && firstA) {
        firstA = false;
        return old.promise;
      }
      return Promise.resolve(CLEAN);
    });
    const recent = [
      { path: OTHER_INFO.path, last_opened: 1715731200 },
      { path: INFO.path, last_opened: 1715644800 },
    ];
    mocked.getRecentRepos.mockResolvedValue(recent);
    useRecentReposStore.setState({ recent });
    mocked.openRecentRepo.mockImplementation((path: string) =>
      Promise.resolve(path === INFO.path ? { repo_id: REPO, info: INFO } : { repo_id: OTHER, info: OTHER_INFO }),
    );
    const { container } = render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    const openRecent = async (path: string, id: string) => {
      await act(async () => {
        fireEvent.click(container.querySelector<HTMLElement>(`.repo-item[title="${path}"]`)!);
      });
      await waitFor(() => expect(useRepoStore.getState().repoId).toBe(id));
      await waitFor(() => expect(useRepoStore.getState().workingTreeStatus).not.toBeNull());
    };

    // A：視窗 focus 的補刷還在等；換到 B、再開回 A（新 A 的讀回來了）
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(mocked.getStatus).toHaveBeenCalledWith(REPO));
    await openRecent(OTHER_INFO.path, OTHER);
    await openRecent(INFO.path, REPO);
    expect(useRepoStore.getState().workingTreeStatus).toEqual(CLEAN);

    // 舊的 A 讀這時才回來
    await act(async () => {
      old.resolve(DIRTY);
      await old.promise;
    });
    expect(useRepoStore.getState().workingTreeStatus).toEqual(CLEAN);
    expect(useRepoStore.getState().statusError).toBe(false);
  });
});
