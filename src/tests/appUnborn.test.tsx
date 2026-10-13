import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import App from "@/App";
import { useRepoStore } from "@/stores/repoStore";
import { useGraphStore } from "@/stores/graphStore";
import { useNoticeStore } from "@/stores/noticeStore";
import { useThemeStore } from "@/stores/themeStore";
import { useAuthStore } from "@/stores/authStore";

// 空 repo（git init 後還沒 commit）：站牌寫「You are on (M) main · No commits yet」、Pull / Push 的理由是
// 「No commits yet」；第一筆 commit 之後兩處馬上換掉，不等 watcher 觸發的 refresh（v8 0b graph 狀態 §1、
// Phase 4 計畫 0.4 #5）。render 整個 App，tauri.ts 只覆寫會碰後端的函式（同 appNotice.test.tsx）
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
    commit: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
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
  commit,
  type AheadBehindInfo,
  type GraphData,
  type RepoInfo,
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
  commit: vi.mocked(commit),
};

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
const FIRST = "1".repeat(40);
// git init：HEAD 指向 main、沒有 commit、沒有 remote；repoInfo.head_branch 在 unborn 時是 null
const UNBORN_INFO: RepoInfo = { path: "/tmp/kira-new", head_branch: null, branches: [], remotes: [] };
const BORN_INFO: RepoInfo = { ...UNBORN_INFO, head_branch: "main", branches: [{ name: "main", oid: FIRST, is_remote: false }] };
const UNBORN_GRAPH: GraphData = {
  commits: [],
  branches: [],
  tags: [],
  truncated: false,
  head: { oid: null, branch: "main" },
  default_branch: null,
};
const BORN_GRAPH: GraphData = {
  commits: [
    {
      oid: FIRST.slice(0, 7),
      full_oid: FIRST,
      message: "Initial commit",
      author: { name: "t", email: "t@example.com", timestamp: 0 },
      parents: [],
      refs: ["main"],
    },
  ],
  branches: [{ name: "main", target: FIRST, is_remote: false, upstream: null, name_on_remote: null }],
  tags: [],
  truncated: false,
  head: { oid: FIRST, branch: "main" },
  default_branch: null,
};
// 後端 ahead_behind：沒 upstream / unborn 一律 no_upstream
const NO_UPSTREAM: AheadBehindInfo = {
  ahead: 0,
  behind: 0,
  has_upstream: false,
  tracking_ref_exists: false,
  upstream_remote: null,
  upstream_branch: null,
};

function openUnbornRepo() {
  useRepoStore.setState({
    repoId: REPO,
    repoInfo: UNBORN_INFO,
    workingTreeStatus: {
      staged: [{ path: "README.md", status: "New" }],
      unstaged: [],
      conflicted: [],
      unstaged_truncated: false,
    },
    loading: false,
    commitLoading: false,
    refreshing: false,
    pushPull: { op: null, repoId: null, percent: null },
    aheadBehind: NO_UPSTREAM,
    aheadBehindRequestId: 0,
  });
  useGraphStore.getState().actions.setRepoId(REPO);
  useGraphStore.getState().actions.setGraphData(UNBORN_GRAPH);
}

const title = (c: HTMLElement, id: string) => c.querySelector(`#${id}`)?.getAttribute("title") ?? null;

describe("App: an unborn repository", () => {
  beforeEach(() => {
    Object.values(mocked).forEach((m) => m.mockReset());
    mocked.githubGetAuthStatus.mockResolvedValue({ authenticated: false, username: null });
    mocked.getRecentRepos.mockResolvedValue([]);
    mocked.getStatus.mockResolvedValue({ staged: [], unstaged: [], conflicted: [], unstaged_truncated: false });
    mocked.listBranches.mockResolvedValue({ branches: [], detached_head_oid: null });
    mocked.getBranchStats.mockResolvedValue({});
    mocked.getAheadBehind.mockResolvedValue(NO_UPSTREAM);
    useNoticeStore.setState({ notice: null });
    useThemeStore.setState({ theme: "light" });
    useAuthStore.getState().reset();
    openUnbornRepo();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("test_appUnborn_beforeTheFirstCommit_signAndToolbarSayNoCommitsYet", () => {
    const { container } = render(<App />);
    expect(container.querySelector("#you-bn")?.textContent).toBe("main");
    expect(container.querySelector("#you-note")?.textContent).toBe("No commits yet");
    expect(title(container, "push")).toBe("No commits yet");
    expect(title(container, "pull")).toBe("No commits yet");
  });

  it("test_appUnborn_firstCommit_updatesSignAndToolbarWithoutWaitingForTheWatcher", async () => {
    mocked.commit.mockResolvedValue({ oid: FIRST });
    mocked.getGraph.mockResolvedValue(BORN_GRAPH);
    mocked.getRepoInfo.mockResolvedValue(BORN_INFO);
    const { container, getByRole, getByPlaceholderText } = render(<App />);

    fireEvent.change(getByPlaceholderText(/Commit message/), { target: { value: "Initial commit" } });
    fireEvent.click(getByRole("button", { name: "Commit" }));

    // 沒有 remote：理由從 unborn 換成「沒 remote」，不是「Detached HEAD」
    await waitFor(() => expect(title(container, "push")).toBe("No remote configured"));
    expect(title(container, "pull")).toBe("No remote configured");
    expect(container.querySelector("#you-note")).toBeNull();
    expect(container.querySelector("#you-bn")?.textContent).toBe("main");
    expect(mocked.getRepoInfo).toHaveBeenCalledWith(REPO);
  });
});
