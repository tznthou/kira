import { render, fireEvent, act, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BranchList } from "@/components/BranchList";
import { useRepoStore } from "@/stores/repoStore";
import { useNoticeStore } from "@/stores/noticeStore";
import { computeRoutes } from "@/lib/routeMap";
import { fixtureFor } from "@/dev/fidelity/states";
import type { BranchInfo, ListBranchesResult } from "@/lib/tauri";

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    listBranches: vi.fn(),
    getBranchStats: vi.fn(),
    getStatus: vi.fn(),
    getAheadBehind: vi.fn(),
    getRepoInfo: vi.fn(),
    getGraph: vi.fn(),
    checkoutBranch: vi.fn(),
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
  };
});

import {
  listBranches,
  getBranchStats,
  getStatus,
  getAheadBehind,
  getRepoInfo,
  getGraph,
  checkoutBranch,
  createBranch,
  deleteBranch,
} from "@/lib/tauri";

const mocked = {
  listBranches: vi.mocked(listBranches),
  getBranchStats: vi.mocked(getBranchStats),
  getStatus: vi.mocked(getStatus),
  getAheadBehind: vi.mocked(getAheadBehind),
  getRepoInfo: vi.mocked(getRepoInfo),
  getGraph: vi.mocked(getGraph),
  checkoutBranch: vi.mocked(checkoutBranch),
  createBranch: vi.mocked(createBranch),
  deleteBranch: vi.mocked(deleteBranch),
};

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBBBBBBB";
const INFO = { path: "/r", head_branch: "main", branches: [], remotes: ["origin"] };
const TRACKED = {
  ahead: 0,
  behind: 0,
  has_upstream: true,
  tracking_ref_exists: true,
  upstream_remote: "origin",
  upstream_branch: "main",
};

const local = (name: string, extra: Partial<BranchInfo> = {}): BranchInfo => ({
  name,
  is_current: false,
  is_remote: false,
  upstream: { name: `origin/${name}`, tracking_ref_exists: true },
  ...extra,
});
const remote = (name: string): BranchInfo => ({ name, is_current: false, is_remote: true, upstream: null });
const MAIN = local("main", { is_current: true });
const FEATURE = local("feature");

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderList(props: Partial<Parameters<typeof BranchList>[0]> = {}) {
  return render(<BranchList routes={props.routes ?? null} head={props.head ?? null} />);
}
const rows = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>("#branch-list .b-name")].map((e) => e.textContent);
const rowBtn = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll<HTMLElement>(".branch-btn")].find((b) => b.dataset.branch === name)!;
const rowOf = (c: HTMLElement, name: string) => rowBtn(c, name).closest("li")!;

describe("BranchList", () => {
  beforeEach(() => {
    Object.values(mocked).forEach((m) => m.mockReset());
    mocked.getBranchStats.mockResolvedValue({});
    mocked.getStatus.mockResolvedValue({ staged: [], unstaged: [], conflicted: [], unstaged_truncated: false });
    mocked.getAheadBehind.mockResolvedValue(TRACKED);
    mocked.getRepoInfo.mockResolvedValue(INFO);
    mocked.getGraph.mockResolvedValue({
      commits: [],
      branches: [],
      tags: [],
      truncated: false,
      head: { oid: null, branch: null },
      default_branch: null,
    });
    useRepoStore.setState({
      repoId: REPO,
      repoInfo: INFO,
      branches: null,
      branchesError: false,
      detachedHeadOid: null,
      branchStats: {},
      branchOpRequestId: 0,
      refreshing: false,
      commitLoading: false,
      pushPull: { op: null, repoId: null, percent: null },
      aheadBehind: null,
    });
    useNoticeStore.setState({ notice: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ---- 清單本身 ----

  it("test_branchList_loading_drawsFourSkeletonRows", () => {
    const { container } = renderList();
    expect(container.querySelectorAll("#branch-list .sk-branch")).toHaveLength(4);
    expect(container.querySelector("#branch-list")?.getAttribute("aria-label")).toBe("Loading branches");
  });

  it("test_branchList_empty_saysNoBranchesYet", () => {
    useRepoStore.setState({ branches: [] });
    const { container } = renderList();
    expect(container.querySelector("#branch-list .empty-line")?.textContent).toBe("No branches yet");
    expect(container.querySelector(".group-label")).toBeNull();
  });

  // ⚑ detached 不畫虛擬列：站牌已經寫了 Detached at
  it("test_branchList_detachedHead_hasNoRowOfItsOwn", () => {
    useRepoStore.setState({ branches: [local("main")], detachedHeadOid: "abcdef0123456789abcdef0123456789abcdef01" });
    const { container } = renderList();
    expect(rows(container)).toEqual(["main"]);
    expect(container.textContent).not.toMatch(/Detached/);
  });

  // 後端不排（libgit2 是 loose 接 packed）：本機在前、遠端在後，各自依名稱（同 graph 的 byName）
  it("test_branchList_sortsLocalThenRemoteByName", () => {
    useRepoStore.setState({
      branches: [remote("origin/b"), local("zeta"), local("Alpha"), remote("origin/a"), local("beta")],
    });
    const { container } = renderList();
    expect(rows(container)).toEqual(["Alpha", "beta", "zeta", "origin/a", "origin/b"]);
    const items = [...container.querySelectorAll("#branch-list > li")].map((li) => li.textContent);
    expect(items[3]).toBe("Remote");
  });

  it("test_branchList_currentBranchRowIsMarked", () => {
    useRepoStore.setState({ branches: [MAIN, FEATURE] });
    const { container } = renderList();
    expect(rowOf(container, "main").className).toBe("branch current");
    expect(rowOf(container, "feature").className).toBe("branch");
    expect(rowBtn(container, "main").title).toBe("Current branch: main");
    expect(rowBtn(container, "feature").title).toBe("Switch to feature");
    // 螢幕閱讀器聽得出哪一列是目前分支（title 是描述，不一定會被唸）
    expect(rowBtn(container, "main").getAttribute("aria-current")).toBe("true");
    expect(rowBtn(container, "feature").hasAttribute("aria-current")).toBe(false);
  });

  // ⚑ remote 列唯讀：aria-disabled（不變淡），title 照基準
  it("test_branchList_remoteRow_isReadOnly", () => {
    useRepoStore.setState({ branches: [MAIN, remote("origin/feature")] });
    const { container, queryByText } = renderList();
    const b = rowBtn(container, "origin/feature");
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(b.title).toBe("Remote branch (read-only)");
    expect(rowOf(container, "origin/feature").className).toBe("branch remote");
    fireEvent.click(b);
    expect(queryByText("Switch to origin/feature")).toBeNull();
  });

  it("test_branchList_prunedUpstream_tagWithTheReason", () => {
    useRepoStore.setState({
      branches: [MAIN, local("feature", { upstream: { name: "origin/feature", tracking_ref_exists: false } })],
      branchStats: { feature: { ahead: null, behind: null } },
    });
    const { container } = renderList();
    const tag = rowBtn(container, "feature").querySelector(".b-tag")!;
    expect(tag.textContent).toBe("pruned");
    expect(tag.getAttribute("title")).toBe("Upstream is set, but origin/feature no longer exists");
    expect(rowBtn(container, "feature").querySelectorAll(".b-stats")).toHaveLength(0);
  });

  it("test_branchList_lazyStats_requestsLocalBranchesOnly", async () => {
    useRepoStore.setState({ branches: [MAIN, remote("origin/feature")] });
    renderList();
    await waitFor(() => expect(mocked.getBranchStats).toHaveBeenCalled());
    expect(mocked.getBranchStats.mock.calls[0][1]).toEqual(["main"]);
  });

  // 後端省略不認得的名字（讀清單與讀 stats 之間被刪掉）：只問一次。之前每輪都換新的 branchStats 物件、
  // 名字還缺，就馬上再問——100ms 內 501 次（上限）以上，舊元件也一樣（2026-10-11 探針實測）
  it("test_branchList_lazyStats_aReplyMissingABranch_asksOnlyOnce", async () => {
    useRepoStore.setState({ branches: [MAIN, local("gone")] });
    // 20 次以後不再回應：迴圈還在的話也停得下來（立刻 resolve 的迴圈會餓死事件迴圈，測試卡住而不是紅）
    mocked.getBranchStats.mockImplementation(() =>
      mocked.getBranchStats.mock.calls.length > 20
        ? new Promise(() => undefined)
        : Promise.resolve({ main: { ahead: 0, behind: 0 } }),
    );
    renderList();
    await waitFor(() => expect(mocked.getBranchStats).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(mocked.getBranchStats).toHaveBeenCalledTimes(1);
    expect(useRepoStore.getState().branchStats.gone).toEqual({ ahead: null, behind: null });
  });

  // ---- 計數 ----

  // ⚑ 目前分支跟工具列同源（aheadBehind：↑ 金箔、↓ 空心），其他本機分支灰字（branchStats）
  it("test_branchList_counts_yoursFromAheadBehind_othersPlainGrey", () => {
    useRepoStore.setState({
      branches: [MAIN, FEATURE],
      aheadBehind: { ...TRACKED, ahead: 2, behind: 1 },
      branchStats: { main: { ahead: 5, behind: 5 }, feature: { ahead: 1, behind: 2 } },
    });
    const { container } = renderList();
    const yours = [...rowBtn(container, "main").querySelectorAll<HTMLElement>(".b-stats")];
    expect(yours.map((s) => [s.className, s.textContent, s.title])).toEqual([
      ["b-stats", "↑2", "2 commits not pushed"],
      ["b-stats in", "↓1", "1 commit on origin not pulled"],
    ]);
    const other = rowBtn(container, "feature").querySelector<HTMLElement>(".b-stats")!;
    expect([other.className, other.textContent, other.title]).toEqual([
      "b-stats plain",
      "↑1 ↓2",
      "1 commit not pushed · 2 commits on origin not pulled",
    ]);
  });

  // 「on <remote>」照 repo 的 remote 名稱比：本機名不一定跟遠端分支同名、remote 名稱可以含 /；
  // 都對不上就是追蹤本機分支，寫它的名字
  it("test_branchList_counts_theRemoteComesFromTheRepoRemotes", () => {
    const tracking = (name: string, upstream: string) => local(name, { upstream: { name: upstream, tracking_ref_exists: true } });
    useRepoStore.setState({
      repoInfo: { ...INFO, remotes: ["origin", "up", "up/stream"] },
      branches: [MAIN, tracking("feature", "origin/sub/feature"), tracking("x", "up/stream/x"), tracking("topic", "feat/base")],
      branchStats: { feature: { ahead: 0, behind: 2 }, x: { ahead: 0, behind: 1 }, topic: { ahead: 0, behind: 3 } },
    });
    const { container } = renderList();
    const titleOf = (name: string) => rowBtn(container, name).querySelector<HTMLElement>(".b-stats")!.title;
    expect(titleOf("feature")).toBe("2 commits on origin not pulled");
    expect(titleOf("x")).toBe("1 commit on up/stream not pulled");
    expect(titleOf("topic")).toBe("3 commits on feat/base not pulled");
  });

  it("test_branchList_counts_noneWithoutARemote", () => {
    useRepoStore.setState({
      repoInfo: { ...INFO, remotes: [] },
      branches: [MAIN, FEATURE],
      branchStats: { feature: { ahead: 1, behind: 2 } },
    });
    const { container } = renderList();
    expect(container.querySelectorAll(".b-stats")).toHaveLength(0);
  });

  // 上游未知（null）或被 prune（追蹤 ref 解析不到）：目前分支不畫計數，同工具列
  it("test_branchList_counts_yoursHiddenWhenTheUpstreamCannotBeCounted", () => {
    useRepoStore.setState({ branches: [MAIN], aheadBehind: null });
    const { container, rerender } = renderList();
    expect(container.querySelectorAll(".b-stats")).toHaveLength(0);
    act(() => useRepoStore.setState({ aheadBehind: { ...TRACKED, ahead: 2, tracking_ref_exists: false } }));
    rerender(<BranchList routes={null} head={null} />);
    expect(container.querySelectorAll(".b-stats")).toHaveLength(0);
  });

  // ---- 圓標（規則本身在 legendRoundel.test.ts）----

  it("test_branchList_roundels_followTheRouteMap_orSkeletonDotsWithoutIt", () => {
    const d = fixtureFor(null, []);
    useRepoStore.setState({ branches: d.listBranches.branches });
    const { container, rerender } = renderList({ routes: computeRoutes(d.graph), head: d.graph.head });
    expect(rowBtn(container, "main").querySelector(".rd")?.textContent).toBe("M");
    expect(rowBtn(container, "feat/t9d-watcher").querySelector(".rd.beyond svg circle")).not.toBeNull();
    expect(rowBtn(container, "origin/feat/t15g-graph-density").querySelector(".rd")?.className).toBe("rd hollow");
    rerender(<BranchList routes={null} head={null} />);
    expect(container.querySelectorAll("#branch-list .sk-rd")).toHaveLength(d.listBranches.branches.length);
    expect(container.querySelectorAll("#branch-list .rd")).toHaveLength(0);
  });

  // ---- 忙碌 ----

  // ⚑ 列不變淡、不 disabled：aria-disabled + title 說原因，點了沒反應；+ New branch 照 .text-btn[disabled]
  it("test_branchList_busy_rowsSayWhyAndDoNothing", () => {
    useRepoStore.setState({ branches: [MAIN, FEATURE], refreshing: true });
    const { container, queryByText } = renderList();
    const b = rowBtn(container, "feature");
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(b.hasAttribute("disabled")).toBe(false);
    expect(b.title).toBe("Disabled while refreshing");
    const create = container.querySelector<HTMLButtonElement>("#create-branch")!;
    expect([create.disabled, create.title]).toEqual([true, "Disabled while refreshing"]);
    fireEvent.click(b);
    expect(queryByText("Switch to feature")).toBeNull();
    act(() => useRepoStore.setState({ refreshing: false, commitLoading: true }));
    expect(rowBtn(container, "feature").title).toBe("Disabled while committing");
  });

  // ---- 分支操作 ----

  // ⚑ checkout 失敗：對話框關掉（提示才不會壓在遮罩底下）、站牌提示、× 後焦點回那一列
  it("test_branchList_checkoutFails_closesTheDialogAndPutsANoticeInTheSign", async () => {
    useRepoStore.setState({ branches: [MAIN, FEATURE] });
    mocked.checkoutBranch.mockRejectedValue({ code: "DIRTY_TREE", message: "dirty" });
    const { container, getByText, queryByText } = renderList();
    fireEvent.click(rowBtn(container, "feature"));
    fireEvent.click(getByText("Safe"));
    await waitFor(() => expect(useNoticeStore.getState().notice).not.toBeNull());
    expect(queryByText("Switch to feature")).toBeNull();
    const notice = useNoticeStore.getState().notice!;
    expect([notice.title, notice.detail]).toEqual(["Checkout failed.", "Commit or stash first."]);
    expect(typeof notice.from === "function" && notice.from()).toBe(rowBtn(container, "feature"));
  });

  // 那一列不在了（分支在外面被刪、watcher 重讀拿掉它）：× 的焦點給清單本身（同 Retry 之後，Q-F），
  // 不掉到 body——提示關掉時 × 會重掛，焦點原地不動就是丟了
  it("test_branchList_checkoutFails_rowGoneByDismiss_focusGoesToTheList", async () => {
    useRepoStore.setState({ branches: [MAIN, FEATURE] });
    mocked.checkoutBranch.mockRejectedValue({ code: "BRANCH_NOT_FOUND", message: "gone" });
    const { container, getByText } = renderList();
    fireEvent.click(rowBtn(container, "feature"));
    fireEvent.click(getByText("Safe"));
    await waitFor(() => expect(useNoticeStore.getState().notice).not.toBeNull());
    act(() => useRepoStore.setState({ branches: [MAIN] }));
    const from = useNoticeStore.getState().notice!.from;
    expect(typeof from === "function" && from()).toBe(container.querySelector("#branch-list"));
  });

  it("test_branchList_checkoutSucceeds_closesTheDialog", async () => {
    useRepoStore.setState({ branches: [MAIN, FEATURE] });
    mocked.checkoutBranch.mockResolvedValue({ head_branch: "feature" });
    mocked.listBranches.mockResolvedValue({ branches: [local("main"), local("feature", { is_current: true })], detached_head_oid: null });
    const { container, getByText, queryByText } = renderList();
    fireEvent.click(rowBtn(container, "feature"));
    fireEvent.click(getByText("Safe"));
    await waitFor(() => expect(queryByText("Switch to feature")).toBeNull());
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  // ⚑ 刪除失敗同 checkout
  it("test_branchList_deleteFails_closesTheDialogAndPutsANoticeInTheSign", async () => {
    useRepoStore.setState({ branches: [MAIN, FEATURE] });
    mocked.deleteBranch.mockRejectedValue({ code: "BRANCH_UNMERGED", message: "unmerged" });
    const { container, getByText, getByLabelText, queryByText } = renderList();
    fireEvent.click(getByLabelText("Delete branch feature"));
    fireEvent.click(getByText("Delete"));
    await waitFor(() => expect(useNoticeStore.getState().notice).not.toBeNull());
    expect(queryByText("Delete branch feature")).toBeNull();
    const notice = useNoticeStore.getState().notice!;
    expect([notice.title, notice.detail]).toEqual(["Delete failed.", "It has unmerged commits."]);
    expect(typeof notice.from === "function" && notice.from()).toBe(rowBtn(container, "feature"));
  });

  // ⚑ 建立失敗（Q-C）：對話框不關、輸入留著、錯誤寫在對話框裡（站牌的提示會被遮罩蓋住），焦點回輸入框
  it("test_branchList_createFails_staysInTheDialogWithTheError", async () => {
    useRepoStore.setState({ branches: [MAIN] });
    mocked.createBranch.mockRejectedValue({ code: "BRANCH_EXISTS", message: "exists" });
    const { getByText, getByPlaceholderText, findByRole } = renderList();
    fireEvent.click(getByText("+ New branch"));
    const input = getByPlaceholderText("e.g. feat/awesome-thing") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "main" } });
    fireEvent.click(getByText("Create"));
    const alert = await findByRole("alert");
    expect(alert.textContent).toBe("Create failed. Name already taken.");
    expect(getByText("Create branch")).not.toBeNull();
    expect(input.value).toBe("main");
    expect(useNoticeStore.getState().notice).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("test_branchList_opStart_clearsTheNotice", async () => {
    useRepoStore.setState({ branches: [MAIN, FEATURE] });
    useNoticeStore.getState().show({ title: "Push rejected.", from: "push" });
    mocked.checkoutBranch.mockReturnValue(new Promise(() => undefined));
    const { container, getByText } = renderList();
    fireEvent.click(rowBtn(container, "feature"));
    expect(useNoticeStore.getState().notice).not.toBeNull();
    fireEvent.click(getByText("Safe"));
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  // 操作進行中對話框關不掉（Escape、點遮罩；Cancel 本來就停用）：關得掉的話，之後的失敗沒有地方說——
  // 對話框不在了、站牌也不出提示。操作結束就放開：建立失敗留在對話框裡（Q-C），那時要關得掉
  it("test_branchList_opRunning_dialogStaysOpen_soTheFailureIsReported", async () => {
    useRepoStore.setState({ branches: [MAIN, FEATURE] });
    const op = deferred<{ head_branch: string }>();
    mocked.checkoutBranch.mockReturnValue(op.promise);
    mocked.createBranch.mockRejectedValue({ code: "BRANCH_EXISTS", message: "exists" });
    const { container, getByText, getByLabelText, getByPlaceholderText, findByRole, queryByText } = renderList();
    fireEvent.click(rowBtn(container, "feature"));
    fireEvent.click(getByText("Safe"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByText("Switch to feature")).not.toBeNull();
    fireEvent.click(getByLabelText("Dismiss dialog"));
    expect(queryByText("Switch to feature")).not.toBeNull();
    await act(async () => {
      op.reject({ code: "DIRTY_TREE", message: "dirty" });
      await op.promise.catch(() => undefined);
    });
    expect(queryByText("Switch to feature")).toBeNull();
    expect(useNoticeStore.getState().notice?.title).toBe("Checkout failed.");
    fireEvent.click(getByText("+ New branch"));
    fireEvent.change(getByPlaceholderText("e.g. feat/awesome-thing"), { target: { value: "main" } });
    fireEvent.click(getByText("Create"));
    await findByRole("alert");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByText("Create branch")).toBeNull();
  });

  // 同一個對話框的操作還在跑，按鈕看的全域 refreshing 卻被提早清掉、又按得到：再按不送第二次
  it("test_branchList_opRunning_sameDialogDoesNotRunTwice", async () => {
    useRepoStore.setState({ branches: [MAIN, FEATURE] });
    mocked.checkoutBranch.mockReturnValue(new Promise(() => undefined));
    const { container, getByText } = renderList();
    fireEvent.click(rowBtn(container, "feature"));
    fireEvent.click(getByText("Safe"));
    act(() => useRepoStore.setState({ refreshing: false }));
    fireEvent.click(getByText("Safe"));
    expect(mocked.checkoutBranch).toHaveBeenCalledTimes(1);
  });

  // 換 repo 時對話框直接關，舊操作還在跑：新 repo 開的對話框照樣關得掉（記的是對話框代號，不是布林）
  it("test_branchList_oldOpStillRunning_aDialogInTheNewRepoCloses", async () => {
    useRepoStore.setState({ branches: [MAIN, FEATURE] });
    mocked.checkoutBranch.mockReturnValue(new Promise(() => undefined));
    const { container, getByText, queryByText } = renderList();
    fireEvent.click(rowBtn(container, "feature"));
    fireEvent.click(getByText("Safe"));
    act(() => useRepoStore.setState({ repoId: OTHER, refreshing: false }));
    fireEvent.click(getByText("+ New branch"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByText("Create branch")).toBeNull();
  });

  // 同上，重入守衛那一半：舊操作還在跑，新 repo 開的對話框照樣送得出去
  it("test_branchList_oldOpStillRunning_aDialogInTheNewRepoStillRuns", async () => {
    useRepoStore.setState({ branches: [MAIN, FEATURE] });
    mocked.checkoutBranch.mockReturnValue(new Promise(() => undefined));
    mocked.createBranch.mockReturnValue(new Promise(() => undefined));
    const { container, getByText, getByPlaceholderText } = renderList();
    fireEvent.click(rowBtn(container, "feature"));
    fireEvent.click(getByText("Safe"));
    act(() => useRepoStore.setState({ repoId: OTHER, refreshing: false }));
    fireEvent.click(getByText("+ New branch"));
    fireEvent.change(getByPlaceholderText("e.g. feat/awesome-thing"), { target: { value: "topic" } });
    fireEvent.click(getByText("Create"));
    expect(mocked.createBranch).toHaveBeenCalledTimes(1);
    expect(mocked.createBranch.mock.calls[0][0]).toBe(OTHER);
  });

  // Codex #5：換了 repo 之後才失敗的舊操作，不關新 repo 的對話框、不寫提示
  it("test_branchList_lateFailureAfterARepoSwitch_touchesNothing", async () => {
    useRepoStore.setState({ branches: [MAIN, FEATURE] });
    const op = deferred<{ head_branch: string }>();
    mocked.checkoutBranch.mockReturnValue(op.promise);
    const { container, getByText, queryByRole } = renderList();
    fireEvent.click(rowBtn(container, "feature"));
    fireEvent.click(getByText("Safe"));
    // 換 repo 時 App 的 applyOpenResult 也會清掉 refreshing（舊操作結束時不清；App 層由
    // repoSwitchDuringBranchOp.test.tsx 守）
    act(() => useRepoStore.setState({ repoId: OTHER, refreshing: false }));
    fireEvent.click(getByText("+ New branch"));
    await act(async () => {
      op.reject({ code: "DIRTY_TREE", message: "dirty" });
      await op.promise.catch(() => undefined);
    });
    expect(getByText("Create branch")).not.toBeNull();
    expect(queryByRole("alert")).toBeNull();
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  // ---- 清單讀不到（Q-B）與 Retry 的焦點（Q-F）----

  it("test_branchList_readError_oneLineWithRetry", () => {
    useRepoStore.setState({ branchesError: true });
    const { container } = renderList();
    const line = container.querySelector("#branch-list .empty-line")!;
    expect(line.querySelector("[role=alert]")?.textContent).toBe("Couldn't read branches.");
    expect(line.textContent).toBe("Couldn't read branches. Retry");
    expect(container.querySelector("#branch-list")?.getAttribute("aria-label")).toBe("Branches");
    expect(container.querySelector("#create-branch")?.hasAttribute("disabled")).toBe(false);
  });

  it("test_branchList_retry_readsAgain_focusStaysInTheList", async () => {
    useRepoStore.setState({ branchesError: true });
    mocked.listBranches.mockResolvedValue({ branches: [MAIN], detached_head_oid: null });
    const { container } = renderList();
    act(() => container.querySelector<HTMLButtonElement>("#branches-retry")!.focus());
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#branches-retry")!.click();
    });
    await waitFor(() => expect(rows(container)).toEqual(["main"]));
    expect(document.activeElement).toBe(container.querySelector("#branch-list"));
  });

  it("test_branchList_retryFailsAgain_focusGoesToTheNewRetry", async () => {
    useRepoStore.setState({ branchesError: true });
    mocked.listBranches.mockRejectedValue(new Error("boom"));
    const { container } = renderList();
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#branches-retry")!.click();
    });
    await waitFor(() => expect(document.activeElement?.id).toBe("branches-retry"));
  });

  it("test_branchList_retry_focusMovedAwayWhileReading_isLeftAlone", async () => {
    useRepoStore.setState({ branchesError: true });
    const read = deferred<ListBranchesResult>();
    mocked.listBranches.mockReturnValue(read.promise);
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    const { container } = renderList();
    act(() => container.querySelector<HTMLButtonElement>("#branches-retry")!.click());
    act(() => elsewhere.focus());
    await act(async () => {
      read.reject(new Error("boom"));
      await read.promise.catch(() => undefined);
    });
    await waitFor(() => expect(container.querySelector("#branches-retry")).not.toBeNull());
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
