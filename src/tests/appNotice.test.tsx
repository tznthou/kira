import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup, act, within } from "@testing-library/react";
import App from "@/App";
import { useRepoStore } from "@/stores/repoStore";
import { useGraphStore } from "@/stores/graphStore";
import { useNoticeStore } from "@/stores/noticeStore";
import { useThemeStore } from "@/stores/themeStore";
import { useAuthStore } from "@/stores/authStore";

// 站牌失敗提示的生命週期（v8 0b §3、Phase 3 計畫 step 5）：誰寫入、誰清掉、誰不能清。
// render 整個 App：tauri.ts 用真實作，只覆寫會碰後端的函式。homeDir 沒覆寫 → 非 Tauri 環境
// reject → 站牌走退回路徑（完整路徑），這裡不關心。
const h = vi.hoisted(() => ({
  externalChange: null as ((e: { payload: { repo_id: string } }) => void) | null,
  cloneDone: null as ((e: { payload: unknown }) => void) | null,
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
    pickAndOpenRepo: vi.fn(),
    openRecentRepo: vi.fn(),
    commit: vi.fn(),
    pickCloneDest: vi.fn(),
    cloneStart: vi.fn(),
    pushBranch: vi.fn(),
    pullBranch: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: unknown) => {
    if (name === "repo:external-change") h.externalChange = handler as typeof h.externalChange;
    if (name === "clone:done") h.cloneDone = handler as typeof h.cloneDone;
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
  pickAndOpenRepo,
  openRecentRepo,
  commit,
  pickCloneDest,
  cloneStart,
  pushBranch,
  pullBranch,
  type GraphData,
  type AheadBehindInfo,
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
  pickAndOpenRepo: vi.mocked(pickAndOpenRepo),
  openRecentRepo: vi.mocked(openRecentRepo),
  commit: vi.mocked(commit),
  pickCloneDest: vi.mocked(pickCloneDest),
  cloneStart: vi.mocked(cloneStart),
  pushBranch: vi.mocked(pushBranch),
  pullBranch: vi.mocked(pullBranch),
};

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBBBBBBB";
const INFO: RepoInfo = { path: "/tmp/repo", head_branch: "main", branches: [], remotes: ["origin"] };
// upstream 是 origin/main（工具列實際推 / 拉的地方），領先落後各 1
const SYNCED: AheadBehindInfo = {
  ahead: 1,
  behind: 1,
  has_upstream: true,
  tracking_ref_exists: true,
  upstream_remote: "origin",
  upstream_branch: "main",
};
const EMPTY_GRAPH: GraphData = {
  commits: [],
  branches: [],
  tags: [],
  truncated: false,
  head: { oid: null, branch: null },
  default_branch: null,
};
const CONFLICT = { title: "Can't fast-forward.", detail: "Merge manually.", from: "pull" } as const;
const FLOW = {
  device_code: "dc",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

function openRepoInStore() {
  useRepoStore.setState({
    repoId: REPO,
    repoInfo: INFO,
    workingTreeStatus: { staged: [], unstaged: [], conflicted: [], unstaged_truncated: false },
    loading: false,
    commitLoading: false,
    refreshing: false,
    pushPull: { op: null, repoId: null, percent: null },
    aheadBehind: SYNCED,
    aheadBehindRequestId: 0,
  });
  useGraphStore.getState().actions.setRepoId(REPO);
  useGraphStore.getState().actions.setGraphData(EMPTY_GRAPH);
}

const topbarText = (c: HTMLElement) => c.querySelector(".topbar #notice-text")?.textContent ?? null;
const hasNotice = (c: HTMLElement) => c.querySelector(".topbar")?.classList.contains("has-notice") ?? false;

describe("App: the station sign's notice", () => {
  beforeEach(() => {
    h.externalChange = null;
    h.cloneDone = null;
    Object.values(mocked).forEach((m) => m.mockReset());
    mocked.githubGetAuthStatus.mockResolvedValue({ authenticated: false, username: null });
    mocked.getRecentRepos.mockResolvedValue([{ path: "/tmp/other", last_opened: 0 }]);
    mocked.getStatus.mockResolvedValue({ staged: [], unstaged: [], conflicted: [], unstaged_truncated: false });
    mocked.getGraph.mockResolvedValue(EMPTY_GRAPH);
    mocked.getAheadBehind.mockResolvedValue(SYNCED);
    mocked.getRepoInfo.mockResolvedValue(INFO);
    mocked.listBranches.mockResolvedValue({ branches: [], detached_head_oid: null });
    mocked.getBranchStats.mockResolvedValue({});
    useNoticeStore.setState({ notice: null });
    useThemeStore.setState({ theme: "light" });
    useAuthStore.getState().reset();
    openRepoInStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // 背景 refresh 失敗也要說（同一句）
  it("test_appNotice_backgroundRefreshFailure_saysRefreshFailed", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    mocked.getGraph.mockRejectedValue({ code: "GIT_ERROR" });

    await act(async () => h.externalChange!({ payload: { repo_id: REPO } }));

    await waitFor(() => expect(topbarText(container)).toBe("Refresh failed."));
    expect(hasNotice(container)).toBe(true);
  });

  // pull 回 CONFLICT 時 fetch 已更新追蹤 ref → watcher 隨即觸發 refresh；背景 refresh 不能清提示
  it("test_appNotice_backgroundRefresh_keepsTheNotice", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());
    act(() => useNoticeStore.getState().show(CONFLICT));
    mocked.getGraph.mockClear();

    await act(async () => h.externalChange!({ payload: { repo_id: REPO } }));
    await waitFor(() => expect(mocked.getGraph).toHaveBeenCalledWith(REPO));
    await waitFor(() => expect(useRepoStore.getState().refreshing).toBe(false));

    expect(topbarText(container)).toBe("Can't fast-forward. Merge manually.");
  });

  it("test_appNotice_refreshClick_clearsTheNotice", async () => {
    const { container, getByRole } = render(<App />);
    act(() => useNoticeStore.getState().show(CONFLICT));

    fireEvent.click(getByRole("button", { name: "Refresh" }));

    expect(useNoticeStore.getState().notice).toBeNull();
    expect(hasNotice(container)).toBe(false);
    await waitFor(() => expect(useRepoStore.getState().refreshing).toBe(false));
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  // 同基準：主題鈕不是殼層操作，不清提示
  it("test_appNotice_themeToggle_keepsTheNotice", () => {
    const { container, getByRole } = render(<App />);
    act(() => useNoticeStore.getState().show(CONFLICT));

    fireEvent.click(getByRole("button", { name: /Switch to (dark|light) theme/ }));

    expect(topbarText(container)).toBe("Can't fast-forward. Merge manually.");
  });

  it("test_appNotice_switchRepoFailure_saysCouldntOpen", async () => {
    mocked.pickAndOpenRepo.mockRejectedValue({ code: "NOT_A_REPO" });
    const { container, getByRole } = render(<App />);

    fireEvent.click(getByRole("button", { name: /Switch repo/i }));

    await waitFor(() => expect(topbarText(container)).toBe("Couldn't open repo."));
    expect(useRepoStore.getState().repoId).toBe(REPO);
  });

  it("test_appNotice_recentRepoFailure_saysItMayHaveMoved", async () => {
    mocked.openRecentRepo.mockRejectedValue({ code: "NOT_FOUND" });
    const { container, findByTitle } = render(<App />);

    fireEvent.click(await findByTitle("/tmp/other"));

    await waitFor(() => expect(topbarText(container)).toBe("Couldn't open repo. It may have moved."));
  });

  // 首頁沒有站牌：開 repo 失敗維持首頁自己的錯誤顯示（Phase 6 再設計）
  it("test_appNotice_openFailureOnLanding_staysOnTheLandingPage", async () => {
    useRepoStore.setState({ repoId: null, repoInfo: null });
    mocked.pickAndOpenRepo.mockRejectedValue({ code: "NOT_A_REPO" });
    const { container, getByRole, findByText } = render(<App />);

    fireEvent.click(getByRole("button", { name: "Open Repository" }));

    expect(await findByText("Failed to open repository")).toBeTruthy();
    expect(useNoticeStore.getState().notice).toBeNull();
    expect(container.querySelector(".topbar")).toBeNull();
  });

  // clone 成功不經過 Switch repo 的按鈕：清提示的是 applyOpenResult
  it("test_appNotice_cloneSuccess_clearsTheNotice", async () => {
    mocked.pickCloneDest.mockResolvedValue({ dest: "/tmp/dest" });
    mocked.cloneStart.mockResolvedValue({ clone_id: "c1" });
    mocked.getRepoInfo.mockResolvedValue({ ...INFO, path: "/tmp/dest" });
    const { getByRole, getByPlaceholderText, findByText } = render(<App />);
    act(() => useNoticeStore.getState().show({ title: "Refresh failed.", from: "refresh" }));

    fireEvent.click(getByRole("button", { name: "Clone" }));
    fireEvent.change(getByPlaceholderText(/https:\/\/github\.com/), { target: { value: "https://github.com/o/r.git" } });
    fireEvent.click(getByRole("button", { name: /Choose folder/ }));
    expect(await findByText("/tmp/dest")).toBeTruthy();
    const dialog = getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Clone" }));
    await waitFor(() => expect(mocked.cloneStart).toHaveBeenCalled());
    expect(useNoticeStore.getState().notice).not.toBeNull();

    act(() => h.cloneDone!({ payload: { clone_id: "c1", kind: "Ok", data: { path: "/tmp/dest", repo_id: OTHER } } }));

    await waitFor(() => expect(useRepoStore.getState().repoId).toBe(OTHER));
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  // 開 / 切 repo 成功清掉前一個 repo 的提示
  it("test_appNotice_openSuccess_clearsTheNotice", async () => {
    mocked.pickAndOpenRepo.mockResolvedValue({ repo_id: OTHER, info: { ...INFO, path: "/tmp/other" } });
    const { getByRole } = render(<App />);
    act(() => useNoticeStore.getState().show({ title: "Refresh failed.", from: "refresh" }));

    fireEvent.click(getByRole("button", { name: /Switch repo/i }));

    await waitFor(() => expect(useRepoStore.getState().repoId).toBe(OTHER));
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  // 真實路徑：pull 回 CONFLICT → 提示；fetch 已更新追蹤 ref，watcher 隨即觸發 refresh → 提示仍在
  it("test_appNotice_pullConflictThenWatcherRefresh_keepsTheNotice", async () => {
    mocked.pullBranch.mockRejectedValue({ code: "CONFLICT" });
    const { container } = render(<App />);
    await waitFor(() => expect(h.externalChange).not.toBeNull());

    fireEvent.click(container.querySelector<HTMLButtonElement>("#pull")!);
    await waitFor(() => expect(topbarText(container)).toBe("Can't fast-forward. Merge manually."));

    mocked.getGraph.mockClear();
    await act(async () => h.externalChange!({ payload: { repo_id: REPO } }));
    await waitFor(() => expect(mocked.getGraph).toHaveBeenCalledWith(REPO));
    await waitFor(() => expect(useRepoStore.getState().refreshing).toBe(false));
    expect(topbarText(container)).toBe("Can't fast-forward. Merge manually.");
  });

  // push / pull 成功、重載 graph 失敗：只寫結論（沒有新 commit 可說「已存」）
  it("test_appNotice_reloadFailureAfterPush_statesOnlyTheFailure", async () => {
    mocked.pushBranch.mockResolvedValue({ success: true, upstream_set: null });
    mocked.getGraph.mockRejectedValue({ code: "GIT_ERROR" });
    const { container, getByRole } = render(<App />);

    fireEvent.click(getByRole("button", { name: /Push/ }));

    await waitFor(() => expect(topbarText(container)).toBe("Graph reload failed."));
  });

  // 失敗後站牌裡只有一個 alert（舊的行內錯誤都拆乾淨），而且跟直接設狀態長得一樣——
  // fidelity 的 ?state=error-* 直接設狀態，這條保證比對到的就是真實失敗的樣子
  it("test_appNotice_realFailure_rendersLikeTheDirectState", async () => {
    mocked.pushBranch.mockRejectedValue({ code: "REJECTED" });
    const real = render(<App />);
    fireEvent.click(real.getByRole("button", { name: /Push/ }));
    await waitFor(() => expect(topbarText(real.container)).toBe("Push rejected. Pull first."));
    await waitFor(() => expect(useRepoStore.getState().pushPull.op).toBeNull());
    expect(real.container.querySelectorAll(".topbar [role=alert]")).toHaveLength(1);
    const realHtml = real.container.querySelector(".topbar")!.outerHTML;
    cleanup();

    useNoticeStore.setState({ notice: null });
    const direct = render(<App />);
    // 站名路徑等 homeDir() settle（查詢中先留空）
    await waitFor(() => expect(direct.container.querySelector(".st-path")?.textContent).toBe("/tmp/repo"));
    act(() => useNoticeStore.getState().show({ title: "Push rejected.", detail: "Pull first.", from: "push" }));
    expect(direct.container.querySelector(".topbar")!.outerHTML).toBe(realHtml);
  });

  // device code 對話框在 App root：站牌整條是拖曳區，放在裡面 code 與網址選不了字
  it("test_appNotice_deviceCodeDialog_rendersOutsideTheSign", async () => {
    const { container, findByText } = render(<App />);
    act(() => useAuthStore.getState().setDeviceFlow(FLOW));
    const code = await findByText("ABCD-1234");
    expect(container.querySelector(".topbar")).not.toBeNull();
    expect(code.closest(".topbar")).toBeNull();
  });

  // 對話框輪詢的錯誤留在卡片裡；從 authStore 推導的話卡片與提示會同時出現，關卡片又連提示一起清
  it("test_appNotice_deviceCodeErrors_stayInTheDialog", async () => {
    const { findByText, getByRole } = render(<App />);
    act(() => {
      useAuthStore.getState().setDeviceFlow(FLOW);
      useAuthStore.getState().setError("GitHub returned an unexpected response. Please retry.");
    });
    expect(await findByText("Authorization failed")).toBeTruthy();
    expect(useNoticeStore.getState().notice).toBeNull();
    fireEvent.click(getByRole("button", { name: "Close" }));
    expect(useAuthStore.getState().deviceFlow).toBeNull();
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  // commit 已寫進 repo、只是重載 graph 失敗：提示要說 commit 還在
  it("test_appNotice_reloadFailureAfterCommit_saysTheCommitIsSaved", async () => {
    useRepoStore.setState({
      workingTreeStatus: {
        staged: [{ path: "a.txt", status: "Modified" }],
        unstaged: [],
        conflicted: [],
        unstaged_truncated: false,
      },
    });
    mocked.getStatus.mockResolvedValue({ staged: [], unstaged: [], conflicted: [], unstaged_truncated: false });
    mocked.commit.mockResolvedValue({ oid: "abc1234" });
    mocked.getGraph.mockRejectedValue({ code: "GIT_ERROR" });
    const { container, getByRole, getByPlaceholderText } = render(<App />);

    fireEvent.change(getByPlaceholderText(/Commit message/), { target: { value: "feat: x" } });
    fireEvent.click(getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(topbarText(container)).toBe("Graph reload failed. Your commit is saved."));
  });

  // graph 讀到了、repo 資訊沒讀到：repoInfo 照樣 fail closed（推拉停用），所以同樣算重載失敗——提示 commit
  // 還在，也不套新的 graph（提示說重載失敗，畫面就不能已經是新的）
  it("test_appNotice_repoInfoFailureAfterCommit_saysTheCommitIsSaved", async () => {
    useRepoStore.setState({
      workingTreeStatus: {
        staged: [{ path: "a.txt", status: "Modified" }],
        unstaged: [],
        conflicted: [],
        unstaged_truncated: false,
      },
    });
    mocked.getStatus.mockResolvedValue({ staged: [], unstaged: [], conflicted: [], unstaged_truncated: false });
    mocked.commit.mockResolvedValue({ oid: "abc1234" });
    mocked.getGraph.mockResolvedValue({ ...EMPTY_GRAPH, truncated: true });
    mocked.getRepoInfo.mockRejectedValue({ code: "GIT_ERROR" });
    const { container, getByRole, getByPlaceholderText } = render(<App />);

    fireEvent.change(getByPlaceholderText(/Commit message/), { target: { value: "feat: x" } });
    fireEvent.click(getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(topbarText(container)).toBe("Graph reload failed. Your commit is saved."));
    expect(useRepoStore.getState().repoInfo).toBeNull();
    expect(useGraphStore.getState().graphData?.truncated).toBe(false);
  });
});
