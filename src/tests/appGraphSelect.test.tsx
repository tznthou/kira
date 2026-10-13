import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import App from "@/App";
import { useRepoStore } from "@/stores/repoStore";
import { useGraphStore } from "@/stores/graphStore";
import { useNoticeStore } from "@/stores/noticeStore";
import { useThemeStore } from "@/stores/themeStore";
import { useAuthStore } from "@/stores/authStore";

// graph 的選取（Phase 4 計畫 §2.8）：開 repo 選 HEAD、commit 後選新的 HEAD，都跟被採用的那份 graph 一起寫入；
// 背景 refresh 不動選取。選取一律斷言 (repoId, full_oid)：fidelity 的假後端對任何 oid 都回 diff，
// 只看畫面或日誌分不出選對了沒有
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
    getDiff: vi.fn(),
    listBranches: vi.fn(),
    getBranchStats: vi.fn(),
    githubGetAuthStatus: vi.fn(),
    getRecentRepos: vi.fn(),
    openRecentRepo: vi.fn(),
    commit: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: unknown) => {
    if (name === "repo:external-change") h.externalChange = handler as typeof h.externalChange;
    return Promise.resolve(() => undefined);
  }),
}));

import {
  getRepoInfo,
  getAheadBehind,
  getStatus,
  getGraph,
  getDiff,
  listBranches,
  getBranchStats,
  githubGetAuthStatus,
  getRecentRepos,
  openRecentRepo,
  commit,
  type CommitNode,
  type GraphData,
  type HeadInfo,
  type RepoInfo,
} from "@/lib/tauri";

const mocked = {
  getRepoInfo: vi.mocked(getRepoInfo),
  getAheadBehind: vi.mocked(getAheadBehind),
  getStatus: vi.mocked(getStatus),
  getGraph: vi.mocked(getGraph),
  getDiff: vi.mocked(getDiff),
  listBranches: vi.mocked(listBranches),
  getBranchStats: vi.mocked(getBranchStats),
  githubGetAuthStatus: vi.mocked(githubGetAuthStatus),
  getRecentRepos: vi.mocked(getRecentRepos),
  openRecentRepo: vi.mocked(openRecentRepo),
  commit: vi.mocked(commit),
};

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBBBBBBB";
const INFO: RepoInfo = { path: "/tmp/repo", head_branch: "main", branches: [], remotes: [] };
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const node = (oid: string, parents: string[]): CommitNode => ({
  oid: oid.slice(0, 7),
  full_oid: oid,
  message: `commit ${oid.slice(0, 7)}`,
  author: { name: "t", email: "t@example.com", timestamp: 0 },
  parents,
  refs: [],
});

/** main 在 B（B ← A）；HEAD 照參數 */
const graphOf = (head: HeadInfo, commits: CommitNode[] = [node(B, [A]), node(A, [])]): GraphData => ({
  commits,
  branches: commits.length ? [{ name: "main", target: commits[0].full_oid, is_remote: false, upstream: null, name_on_remote: null }] : [],
  tags: [],
  truncated: false,
  head,
  default_branch: null,
});

const selection = () => [useGraphStore.getState().repoId, useGraphStore.getState().selectedCommit?.full_oid ?? null];
const ariaSelected = (c: HTMLElement, oid: string) => c.querySelector(`[data-oid="${oid}"]`)?.getAttribute("aria-selected");

/** REPO 已開著、graph 是 B ← A、選取在 A（不是 HEAD） */
function openRepoInStore() {
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
  });
  useGraphStore.getState().actions.setRepoId(REPO);
  const graph = graphOf({ oid: B, branch: "main" });
  useGraphStore.getState().actions.adoptGraph(graph, graph.commits[1]);
}

/** 點首頁近期清單以外的另一個 repo：站牌上的 Switch repo 不經過這裡，側欄的近期清單才是 */
async function openOther(graph: GraphData, findByTitle: (t: string) => Promise<HTMLElement>) {
  mocked.openRecentRepo.mockResolvedValue({ repo_id: OTHER, info: { ...INFO, path: "/tmp/other" } });
  mocked.getGraph.mockResolvedValue(graph);
  fireEvent.click(await findByTitle("/tmp/other"));
}

describe("App: what the graph selects", () => {
  beforeEach(() => {
    h.externalChange = null;
    Object.values(mocked).forEach((m) => m.mockReset());
    mocked.githubGetAuthStatus.mockResolvedValue({ authenticated: false, username: null });
    mocked.getRecentRepos.mockResolvedValue([{ path: "/tmp/other", last_opened: 0 }]);
    mocked.getStatus.mockResolvedValue({ staged: [], unstaged: [], conflicted: [], unstaged_truncated: false });
    mocked.getAheadBehind.mockResolvedValue({
      ahead: 0,
      behind: 0,
      has_upstream: false,
      tracking_ref_exists: false,
      upstream_remote: null,
      upstream_branch: null,
    });
    mocked.getRepoInfo.mockResolvedValue(INFO);
    mocked.getDiff.mockResolvedValue({ files: [], truncated: false });
    mocked.listBranches.mockResolvedValue({ branches: [], detached_head_oid: null });
    mocked.getBranchStats.mockResolvedValue({});
    useNoticeStore.setState({ notice: null });
    useThemeStore.setState({ theme: "light" });
    useAuthStore.getState().reset();
    openRepoInStore();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("test_appGraphSelect_openRepo_selectsHeadAndScrollsItIntoView", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    const { container, findByTitle } = render(<App />);
    scroll.mockClear();

    await openOther(graphOf({ oid: B, branch: "main" }), findByTitle);

    await waitFor(() => expect(selection()).toEqual([OTHER, B]));
    expect(ariaSelected(container, B)).toBe("true");
    expect(ariaSelected(container, A)).toBe("false");
    const scrolled = scroll.mock.contexts.map((el) => (el as HTMLElement).dataset.oid);
    expect(scrolled).toContain(B);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("test_appGraphSelect_openRepoDetached_selectsTheCommitHeadIsAt", async () => {
    const { findByTitle } = render(<App />);

    await openOther(graphOf({ oid: A, branch: null }), findByTitle);

    await waitFor(() => expect(selection()).toEqual([OTHER, A]));
  });

  // HEAD 比載入的 commit 都舊：沒有可選的；前一個 repo 的選取（A）也不能留下來
  it("test_appGraphSelect_openRepoHeadBeyondTheWindow_selectsNothing", async () => {
    const { container, findByTitle } = render(<App />);

    await openOther({ ...graphOf({ oid: C, branch: "old" }), truncated: true }, findByTitle);

    await waitFor(() => expect(useGraphStore.getState().repoId).toBe(OTHER));
    await waitFor(() => expect(container.querySelectorAll('[role="option"]')).toHaveLength(2));
    expect(selection()).toEqual([OTHER, null]);
    // 限定在 graph 的列：右欄的 tab 也帶 aria-selected（5c step 3 起），選中的那顆永遠是 true
    expect(container.querySelector('[role="option"][aria-selected="true"]')).toBeNull();
  });

  it("test_appGraphSelect_openRepoUnborn_selectsNothing", async () => {
    const { container, findByTitle } = render(<App />);

    await openOther(graphOf({ oid: null, branch: "main" }, []), findByTitle);

    await waitFor(() => expect(container.querySelector(".graph-empty")).not.toBeNull());
    expect(selection()).toEqual([OTHER, null]);
  });

  it("test_appGraphSelect_commit_selectsTheNewHead", async () => {
    useRepoStore.setState({
      workingTreeStatus: {
        staged: [{ path: "a.txt", status: "Modified" }],
        unstaged: [],
        conflicted: [],
        unstaged_truncated: false,
      },
    });
    mocked.commit.mockResolvedValue({ oid: C.slice(0, 7) });
    mocked.getGraph.mockResolvedValue(graphOf({ oid: C, branch: "main" }, [node(C, [B]), node(B, [A]), node(A, [])]));
    const { container, getByRole, getByPlaceholderText } = render(<App />);
    expect(selection()).toEqual([REPO, A]);

    fireEvent.change(getByPlaceholderText(/Commit message/), { target: { value: "feat: x" } });
    fireEvent.click(getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(selection()).toEqual([REPO, C]));
    expect(ariaSelected(container, C)).toBe("true");
  });

  // watcher 觸發的背景 refresh 換了 graph（HEAD 走到 C）：選取留在原本那筆
  it("test_appGraphSelect_backgroundRefresh_keepsTheSelection", async () => {
    render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    mocked.getGraph.mockResolvedValue(graphOf({ oid: C, branch: "main" }, [node(C, [B]), node(B, [A]), node(A, [])]));

    await act(async () => h.externalChange!({ payload: { repo_id: REPO } }));

    await waitFor(() => expect(useGraphStore.getState().graphData?.head.oid).toBe(C));
    expect(selection()).toEqual([REPO, A]);
  });
});
