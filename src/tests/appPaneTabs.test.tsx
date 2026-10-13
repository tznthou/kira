import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup, act, within } from "@testing-library/react";
import App from "@/App";
import { useRepoStore } from "@/stores/repoStore";
import { useGraphStore } from "@/stores/graphStore";
import { useNoticeStore } from "@/stores/noticeStore";
import { useThemeStore } from "@/stores/themeStore";
import { useAuthStore } from "@/stores/authStore";
import { focusBack } from "@/lib/focusBack";

// 右欄的 tabs（Phase 5c step 3，照基準）：tablist + 兩個 tab（roving tabIndex）+ 兩個 tabpanel；←→ 換 tab、
// 焦點跟著走、到頭繞回；進來的 panel 重播 .enter；PR 面板藏起來不 unmount（§4：watcher 不重抓 PR）。
// render 整個 App，只覆寫會碰後端的函式（同 appNotice）
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
    githubGetPRs: vi.fn(),
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
  githubGetPRs,
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
  githubGetPRs: vi.mocked(githubGetPRs),
};

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
const INFO: RepoInfo = { path: "/tmp/repo", head_branch: "main", branches: [], remotes: ["origin"] };
const EMPTY_GRAPH: GraphData = {
  commits: [],
  branches: [],
  tags: [],
  truncated: false,
  head: { oid: null, branch: null },
  default_branch: null,
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
    aheadBehind: null,
    aheadBehindRequestId: 0,
  });
  useGraphStore.getState().actions.setRepoId(REPO);
  useGraphStore.getState().actions.setGraphData(EMPTY_GRAPH);
}

const pane = (c: HTMLElement) => c.querySelector(".side-pane") as HTMLElement;
const tabs = (c: HTMLElement) => within(pane(c)).getAllByRole("tab");
const panel = (c: HTMLElement, id: string) => c.querySelector(`#${id}`) as HTMLElement;

describe("App: the right pane's tabs", () => {
  beforeEach(() => {
    Object.values(mocked).forEach((m) => m.mockReset());
    mocked.githubGetAuthStatus.mockResolvedValue({ authenticated: false, username: null });
    mocked.getRecentRepos.mockResolvedValue([]);
    mocked.getStatus.mockResolvedValue({ staged: [], unstaged: [], conflicted: [], unstaged_truncated: false });
    mocked.getGraph.mockResolvedValue(EMPTY_GRAPH);
    mocked.getAheadBehind.mockResolvedValue({
      ahead: 0,
      behind: 0,
      has_upstream: true,
      tracking_ref_exists: true,
      upstream_remote: "origin",
      upstream_branch: "main",
    });
    mocked.getRepoInfo.mockResolvedValue(INFO);
    mocked.listBranches.mockResolvedValue({ branches: [], detached_head_oid: null });
    mocked.getBranchStats.mockResolvedValue({});
    mocked.githubGetPRs.mockResolvedValue([]);
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

  it("test_paneTabs_aTablistOfTwo_changesSelected", () => {
    const { container } = render(<App />);
    const list = within(pane(container)).getByRole("tablist");
    expect(list.getAttribute("aria-label")).toBe("Working tree and pull requests");
    const [changes, prs] = tabs(container);
    expect([changes.textContent, prs.textContent]).toEqual(["Changes", "Pull Requests"]);
    expect([changes.getAttribute("aria-selected"), prs.getAttribute("aria-selected")]).toEqual(["true", "false"]);
    // roving tabIndex：Tab 鍵進來落在選中的那個
    expect([changes.tabIndex, prs.tabIndex]).toEqual([0, -1]);
    // 每個 tab 指著自己的 panel，panel 由 tab 命名、可以接焦點（Retry 之後焦點落在這裡，Q-F）
    for (const [tab, id] of [[changes, "panel-changes"], [prs, "panel-prs"]] as const) {
      expect(tab.getAttribute("aria-controls")).toBe(id);
      const p = panel(container, id);
      expect(p.getAttribute("role")).toBe("tabpanel");
      expect(p.getAttribute("aria-labelledby")).toBe(tab.id);
      expect(p.tabIndex).toBe(-1);
    }
    expect([panel(container, "panel-changes").hidden, panel(container, "panel-prs").hidden]).toEqual([false, true]);
  });

  it("test_paneTabs_click_selectsTheTabAndShowsItsPanel", () => {
    const { container } = render(<App />);
    const [changes, prs] = tabs(container);
    fireEvent.click(prs);
    expect([changes.getAttribute("aria-selected"), prs.getAttribute("aria-selected")]).toEqual(["false", "true"]);
    expect([changes.tabIndex, prs.tabIndex]).toEqual([-1, 0]);
    expect([panel(container, "panel-changes").hidden, panel(container, "panel-prs").hidden]).toEqual([true, false]);
  });

  it("test_paneTabs_arrowKeys_moveSelectionAndFocus_andWrapAround", () => {
    const { container } = render(<App />);
    const [changes, prs] = tabs(container);
    changes.focus();
    fireEvent.keyDown(changes, { key: "ArrowRight" });
    expect(document.activeElement).toBe(prs);
    expect(prs.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(prs, { key: "ArrowRight" });
    expect(document.activeElement).toBe(changes);
    expect(changes.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(changes, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(prs);
    expect(panel(container, "panel-prs").hidden).toBe(false);
    // 其他鍵不動
    fireEvent.keyDown(prs, { key: "ArrowDown" });
    expect(document.activeElement).toBe(prs);
    expect(prs.getAttribute("aria-selected")).toBe("true");
  });

  // 基準：開頭沒有 .enter（第一次畫不是「換進來」），換進來的那一格重播
  it("test_paneTabs_thePanelComingIn_replaysEnter", () => {
    const { container } = render(<App />);
    const [changes, prs] = tabs(container);
    expect(panel(container, "panel-changes").classList.contains("enter")).toBe(false);
    fireEvent.click(prs);
    expect(panel(container, "panel-prs").classList.contains("enter")).toBe(true);
    fireEvent.click(changes);
    expect(panel(container, "panel-changes").classList.contains("enter")).toBe(true);
  });

  // 站牌提示 × 之後焦點還給一個藏在別的分頁裡的元素：退回那一格的 tab（5a step 4、G7 的 focusBack 靠
  // [role=tabpanel] + aria-controls + hidden 屬性；舊的右欄三樣都沒有，退回在右欄從沒生效過）
  it("test_paneTabs_focusBack_intoTheHiddenPanel_landsOnItsTab", () => {
    const { container } = render(<App />);
    // PR 面板裡的清單（藏著的分頁裡的元素）
    const inside = panel(container, "panel-prs").querySelector<HTMLElement>("#prs")!;
    act(() => focusBack(inside));
    expect(document.activeElement?.id).toBe("tab-prs");
  });

  // §4 保護清單：PR 面板藏起來不 unmount——換 tab 不重抓 GitHub。守的是舊行為：用按鈕文字找 tab，
  // 新舊兩版都找得到（舊版沒有 role=tab），兩版都要綠
  it("test_paneTabs_switching_doesNotRemountThePullRequests", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(mocked.githubGetPRs).toHaveBeenCalled());
    const calls = mocked.githubGetPRs.mock.calls.length;
    const byText = (t: string) => within(pane(container)).getByText(t, { selector: "button" });
    const [changes, prs] = [byText("Changes"), byText("Pull Requests")];
    await act(async () => {
      fireEvent.click(prs);
      fireEvent.click(changes);
      fireEvent.click(prs);
    });
    expect(mocked.githubGetPRs.mock.calls.length).toBe(calls);
  });
});
