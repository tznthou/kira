import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Toolbar } from "@/components/Topbar/Toolbar";
import { useRepoStore } from "@/stores/repoStore";
import { useNoticeStore } from "@/stores/noticeStore";
import type { AheadBehindInfo, RepoInfo } from "@/lib/tauri";

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return { ...actual, pushBranch: vi.fn(), pullBranch: vi.fn() };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

import { pushBranch, pullBranch } from "@/lib/tauri";

const mockedPush = vi.mocked(pushBranch);
const mockedPull = vi.mocked(pullBranch);

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBBBBBBB";
const INFO: RepoInfo = { path: "/tmp/repo", head_branch: "main", branches: [], remotes: ["origin"] };
// upstream 是 origin 的同名分支 = 工具列實際推 / 拉的地方，計數描述的就是它
const sync = (ahead: number, behind: number): AheadBehindInfo => ({
  ahead,
  behind,
  has_upstream: true,
  tracking_ref_exists: true,
  upstream_remote: "origin",
  upstream_branch: "main",
});
const NO_UPSTREAM: AheadBehindInfo = {
  ahead: 0,
  behind: 0,
  has_upstream: false,
  tracking_ref_exists: false,
  upstream_remote: null,
  upstream_branch: null,
};
// upstream 有設定、追蹤 ref 被 prune：後端回 0 / 0 / true，但計數不可得
const UNRESOLVABLE: AheadBehindInfo = { ...sync(0, 0), tracking_ref_exists: false };

function resetStore(overrides: Partial<ReturnType<typeof useRepoStore.getState>> = {}) {
  useRepoStore.setState({
    repoId: REPO,
    repoInfo: INFO,
    workingTreeStatus: null,
    loading: false,
    commitLoading: false,
    refreshing: false,
    pushPull: { op: null, repoId: null, percent: null },
    // 預設：有 upstream、領先 1（ahead 0 會撞上「沒東西可推」停用）
    aheadBehind: sync(1, 0),
    aheadBehindRequestId: 0,
    ...overrides,
  });
}

function renderToolbar(props: { unborn?: boolean; onRefresh?: () => void; onTransportDone?: () => void } = {}) {
  const utils = render(
    <Toolbar
      repoId={REPO}
      unborn={props.unborn ?? false}
      onRefresh={props.onRefresh ?? vi.fn()}
      onTransportDone={props.onTransportDone ?? vi.fn()}
    />,
  );
  const btn = (id: string) => utils.container.querySelector<HTMLButtonElement>(`#${id}`)!;
  return { ...utils, pull: btn("pull"), push: btn("push"), refresh: btn("refresh") };
}

const label = (b: HTMLButtonElement) => b.querySelector(".label")?.textContent;

describe("Toolbar", () => {
  beforeEach(() => {
    mockedPush.mockReset();
    mockedPull.mockReset();
    resetStore();
    useNoticeStore.setState({ notice: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("test_toolbar_idle_allEnabledWithReasonsForTheirAction", () => {
    const { pull, push, refresh } = renderToolbar();
    expect([pull.disabled, push.disabled, refresh.disabled]).toEqual([false, false, false]);
    expect(pull.title).toBe("Pull from origin");
    expect(push.title).toBe("Push to origin");
    expect(refresh.title).toBe("Reload commit graph and working tree status");
    expect([label(pull), label(push), label(refresh)]).toEqual(["Pull", "Push", "Refresh"]);
  });

  it("test_toolbar_pushSuccess_reloadsAndClearsState", async () => {
    mockedPush.mockResolvedValue({ success: true, upstream_set: null });
    const onTransportDone = vi.fn();
    const { push } = renderToolbar({ onTransportDone });
    fireEvent.click(push);

    // 有 upstream → 不帶 set_upstream
    await waitFor(() => expect(mockedPush).toHaveBeenCalledWith(REPO, "origin", "main", false));
    await waitFor(() => expect(onTransportDone).toHaveBeenCalled());
    expect(useRepoStore.getState().pushPull.op).toBeNull();
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  // 錯誤碼 → 0b §3 文案，進站牌提示，焦點回 Push
  it("test_toolbar_pushRejected_hangsTheNotice", async () => {
    mockedPush.mockRejectedValue({ code: "REJECTED", message: "push rejected by remote" });
    const { push } = renderToolbar();
    fireEvent.click(push);

    await waitFor(() =>
      expect(useNoticeStore.getState().notice).toMatchObject({ title: "Push rejected.", detail: "Pull first.", from: "push" }),
    );
    expect(useRepoStore.getState().pushPull.op).toBeNull();
  });

  it("test_toolbar_pushAuthFailed_saysAuthenticationRequired", async () => {
    mockedPush.mockRejectedValue({ code: "AUTH_FAILED", message: "authentication required" });
    const { push } = renderToolbar();
    fireEvent.click(push);
    await waitFor(() =>
      expect(useNoticeStore.getState().notice).toMatchObject({
        title: "Push failed.",
        detail: "Authentication required.",
      }),
    );
  });

  it("test_toolbar_pullConflict_saysCantFastForward", async () => {
    mockedPull.mockRejectedValue({ code: "CONFLICT" });
    const { pull } = renderToolbar();
    fireEvent.click(pull);
    await waitFor(() =>
      expect(useNoticeStore.getState().notice).toMatchObject({
        title: "Can't fast-forward.",
        detail: "Merge manually.",
        from: "pull",
      }),
    );
  });

  // 使用者發起的 push 開始時清掉前一則提示
  it("test_toolbar_startingAnOp_clearsTheNotice", () => {
    mockedPush.mockImplementation(() => new Promise(() => {}));
    useNoticeStore.getState().show({ title: "Refresh failed.", from: "refresh" });
    const { push } = renderToolbar();
    fireEvent.click(push);
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  // 忙碌時三顆一起停，含 commit 中
  it("test_toolbar_committing_disablesAllThree", () => {
    resetStore({ commitLoading: true });
    const { pull, push, refresh } = renderToolbar();
    expect([pull.disabled, push.disabled, refresh.disabled]).toEqual([true, true, true]);
    expect([pull.title, push.title, refresh.title]).toEqual([
      "Disabled while committing",
      "Disabled while committing",
      "Disabled while committing",
    ]);
  });

  // refresh 中混合視角（新 branch × stale has_upstream）會讓 push 用錯 setUpstream flag
  it("test_toolbar_refreshing_spinsRefreshAndStopsTheOthers", () => {
    resetStore({ refreshing: true });
    const { pull, push, refresh } = renderToolbar();
    expect([pull.disabled, push.disabled, refresh.disabled]).toEqual([true, true, true]);
    expect(pull.title).toBe("Disabled while refreshing");
    expect(push.title).toBe("Disabled while refreshing");
    expect(label(refresh)).toBe("Refreshing…");
    expect(refresh.className).toBe("btn ghost spin");
    expect(refresh.title).toBe("Reload commit graph and working tree status");
  });

  it("test_toolbar_pushing_showsThePercentage", () => {
    resetStore({ aheadBehind: sync(2, 0), pushPull: { op: "push", repoId: REPO, percent: 37 } });
    const { pull, push, refresh } = renderToolbar();
    expect(label(push)).toBe("37%");
    expect(push.title).toBe("Pushing to origin…");
    expect(push.querySelector("#ahead")?.textContent).toBe("2");
    expect([pull.disabled, push.disabled, refresh.disabled]).toEqual([true, true, true]);
    expect(refresh.title).toBe("Disabled while pushing");
  });

  // 小 packfile 不觸發進度事件：percent 可能整段推送都是 null（同基準第一格寫 0%）
  it("test_toolbar_pushingWithoutProgress_saysZeroPercent", () => {
    resetStore({ pushPull: { op: "push", repoId: REPO, percent: null } });
    const { push } = renderToolbar();
    expect(label(push)).toBe("0%");
  });

  it("test_toolbar_pulling_saysPulling", () => {
    resetStore({ pushPull: { op: "pull", repoId: REPO, percent: null } });
    const { pull } = renderToolbar();
    expect(label(pull)).toBe("Pulling…");
    expect(pull.title).toBe("Pulling from origin…");
  });

  // detached HEAD → head_branch=null（避免錯 refspec）
  it("test_toolbar_detached_disablesPullAndPush", () => {
    resetStore({ repoInfo: { ...INFO, head_branch: null }, aheadBehind: NO_UPSTREAM });
    const { pull, push, refresh } = renderToolbar();
    expect([pull.disabled, push.disabled, refresh.disabled]).toEqual([true, true, false]);
    expect(pull.title).toBe("Detached HEAD — check out a branch first");
    expect(push.title).toBe("Detached HEAD — check out a branch first");
    expect(label(push)).toBe("Push");
  });

  it("test_toolbar_noRemote_disablesPullAndPush", () => {
    resetStore({ repoInfo: { ...INFO, remotes: [] }, aheadBehind: NO_UPSTREAM });
    const { pull, push } = renderToolbar();
    expect([pull.disabled, push.disabled]).toEqual([true, true]);
    expect(pull.title).toBe("No remote configured");
    expect(push.title).toBe("No remote configured");
    expect(label(push)).toBe("Push");
  });

  // unborn（git init 後還沒 commit）：head_branch 也是 null，但理由不是 detached；不出現 Publish、沒有計數
  it("test_toolbar_unborn_saysNoCommitsYet", () => {
    resetStore({ repoInfo: { ...INFO, head_branch: null }, aheadBehind: NO_UPSTREAM });
    const { pull, push, refresh, container } = renderToolbar({ unborn: true });
    expect([pull.disabled, push.disabled, refresh.disabled]).toEqual([true, true, false]);
    expect(pull.title).toBe("No commits yet");
    expect(push.title).toBe("No commits yet");
    expect(label(push)).toBe("Push");
    expect(container.querySelector("#ahead")).toBeNull();
  });

  // 理由順序：忙碌 → unborn → detached → 沒 remote → 未知
  it("test_toolbar_reasons_comeInOrder", () => {
    resetStore({ commitLoading: true, repoInfo: { ...INFO, head_branch: null, remotes: [] }, aheadBehind: null });
    expect(renderToolbar({ unborn: true }).push.title).toBe("Disabled while committing");
    cleanup();
    resetStore({ repoInfo: { ...INFO, head_branch: null, remotes: [] }, aheadBehind: null });
    expect(renderToolbar({ unborn: true }).push.title).toBe("No commits yet");
    cleanup();
    resetStore({ repoInfo: { ...INFO, head_branch: null, remotes: [] }, aheadBehind: null });
    expect(renderToolbar().push.title).toBe("Detached HEAD — check out a branch first");
    cleanup();
    resetStore({ repoInfo: { ...INFO, remotes: [] }, aheadBehind: null });
    expect(renderToolbar().pull.title).toBe("No remote configured");
  });

  // 上游狀態未知（開 repo 載入中、讀取失敗）：兩顆都停、無計數、標籤維持 Push（子超裁定 F）
  it("test_toolbar_unknownUpstream_stopsBothWithoutCounts", () => {
    resetStore({ aheadBehind: null });
    const { pull, push, container } = renderToolbar();
    expect([pull.disabled, push.disabled]).toEqual([true, true]);
    expect(pull.title).toBe("Upstream status unknown — Refresh to retry");
    expect(push.title).toBe("Upstream status unknown — Refresh to retry");
    expect(label(push)).toBe("Push");
    expect(container.querySelector(".count")).toBeNull();
    fireEvent.click(push);
    expect(mockedPush).not.toHaveBeenCalled();
  });

  // 沒 upstream：Push 改叫 Publish、第一次推送順便 track；Pull 停用
  it("test_toolbar_noUpstream_publishesAndTracks", async () => {
    resetStore({ aheadBehind: NO_UPSTREAM });
    mockedPush.mockResolvedValue({ success: true, upstream_set: true });
    const { pull, push } = renderToolbar();
    expect(pull.disabled).toBe(true);
    expect(pull.title).toBe("No upstream — publish this branch first");
    expect(label(push)).toBe("Publish");
    expect(push.title).toBe("Publish main to origin and track it");

    fireEvent.click(push);
    await waitFor(() => expect(mockedPush).toHaveBeenCalledWith(REPO, "origin", "main", true));
  });

  it("test_toolbar_publishing_saysPublishing", () => {
    resetStore({ aheadBehind: NO_UPSTREAM, pushPull: { op: "push", repoId: REPO, percent: 50 } });
    expect(renderToolbar().push.title).toBe("Publishing to origin…");
  });

  it("test_toolbar_publishFailure_saysPublish", async () => {
    resetStore({ aheadBehind: NO_UPSTREAM });
    mockedPush.mockRejectedValue({ code: "AUTH_FAILED" });
    fireEvent.click(renderToolbar().push);
    await waitFor(() => expect(useNoticeStore.getState().notice?.title).toBe("Publish failed."));
  });

  // ⚑ 沒東西可推：Push 停用（同「沒東西可 commit 時 Commit 停用」）
  it("test_toolbar_nothingToPush_restsPush", () => {
    resetStore({ aheadBehind: sync(0, 0) });
    const { pull, push } = renderToolbar();
    expect(push.disabled).toBe(true);
    expect(push.title).toBe("Nothing to push");
    expect(pull.disabled).toBe(false);
    fireEvent.click(push);
    expect(mockedPush).not.toHaveBeenCalled();
  });

  // upstream 有設定、追蹤 ref 解析不到（被 prune）：兩顆都能按、無計數、push 不帶 set_upstream（裁定 H）
  it("test_toolbar_unresolvableUpstream_pushesWithoutSettingIt", async () => {
    resetStore({ aheadBehind: UNRESOLVABLE });
    mockedPush.mockResolvedValue({ success: true, upstream_set: null });
    const { pull, push, container } = renderToolbar();
    expect([pull.disabled, push.disabled]).toEqual([false, false]);
    expect(pull.title).toBe("Pull from origin");
    expect(push.title).toBe("Push to origin");
    expect(label(push)).toBe("Push");
    expect(container.querySelector(".count")).toBeNull();

    fireEvent.click(push);
    await waitFor(() => expect(mockedPush).toHaveBeenCalledWith(REPO, "origin", "main", false));
  });

  // upstream 不在 Push 要去的地方（fork：main 追蹤 upstream/main，工具列推 origin）：ahead 0 是對
  // upstream 算的，origin 落後也會讀成 0 → 不能據此停用 Push。計數同 main 照 upstream 顯示（子超裁定 I）
  it("test_toolbar_upstreamOnAnotherRemote_stillPushes", async () => {
    resetStore({
      repoInfo: { ...INFO, remotes: ["origin", "upstream"] },
      aheadBehind: { ...sync(0, 3), upstream_remote: "upstream" },
    });
    mockedPush.mockResolvedValue({ success: true, upstream_set: null });
    const { pull, push } = renderToolbar();
    expect([pull.disabled, push.disabled]).toEqual([false, false]);
    expect(push.title).toBe("Push to origin");
    expect(push.querySelector("#ahead")).toBeNull();
    expect(pull.querySelector("#behind")?.textContent).toBe("3");

    fireEvent.click(push);
    await waitFor(() => expect(mockedPush).toHaveBeenCalledWith(REPO, "origin", "main", false));
  });

  // 從 origin/main 開的分支（git switch -c feat origin/main → feat 追蹤 origin/main）：Push 推到
  // origin/feat，不是 upstream，ahead 0 一樣不代表沒東西可推
  it("test_toolbar_upstreamOnAnotherBranch_stillPushes", () => {
    resetStore({ repoInfo: { ...INFO, head_branch: "feat" }, aheadBehind: sync(0, 0) });
    const { push } = renderToolbar();
    expect(push.disabled).toBe(false);
    expect(push.title).toBe("Push to origin");
  });

  // 計數：領先 = 金箔（你的），落後 = 空心（還不是你的）
  it("test_toolbar_counts_goldAheadHollowBehind", () => {
    resetStore({ aheadBehind: sync(3, 2) });
    const { pull, push } = renderToolbar();
    const ahead = push.querySelector("#ahead")!;
    const behind = pull.querySelector("#behind")!;
    expect([ahead.textContent, ahead.className]).toEqual(["3", "count"]);
    expect([behind.textContent, behind.className]).toEqual(["2", "count in"]);
  });

  // title 與 IPC 用實際要推 / 拉的 remote：origin 優先，沒有就第一個
  it("test_toolbar_remote_prefersOriginElseTheFirst", async () => {
    resetStore({ repoInfo: { ...INFO, remotes: ["upstream", "fork"] } });
    mockedPush.mockResolvedValue({ success: true, upstream_set: null });
    const first = renderToolbar();
    expect(first.push.title).toBe("Push to upstream");
    expect(first.pull.title).toBe("Pull from upstream");
    fireEvent.click(first.push);
    await waitFor(() => expect(mockedPush).toHaveBeenCalledWith(REPO, "upstream", "main", false));
    cleanup();

    resetStore({ repoInfo: { ...INFO, remotes: ["upstream", "origin"] } });
    expect(renderToolbar().push.title).toBe("Push to origin");
  });

  // Contract: 用 store 的 repoInfo.head_branch，不 fetch fresh；防 stale 的責任在 handleRefresh
  it("test_toolbar_contract_passesStoreHeadBranchAndUpstreamFlagToPushIPC", async () => {
    resetStore({ repoInfo: { ...INFO, head_branch: "feat-X" }, aheadBehind: { ...NO_UPSTREAM, ahead: 1 } });
    mockedPush.mockResolvedValue({ success: true, upstream_set: true });
    const { push } = renderToolbar();
    expect(label(push)).toBe("Publish");
    fireEvent.click(push);
    await waitFor(() => expect(mockedPush).toHaveBeenCalledWith(REPO, "origin", "feat-X", true));
  });

  it("test_toolbar_pushPullStateForOtherRepo_doesNotShowAsTransporting", () => {
    resetStore({ pushPull: { op: "push", repoId: OTHER, percent: 50 } });
    const { push } = renderToolbar();
    expect(push.disabled).toBe(false);
    expect(label(push)).toBe("Push");
  });

  it("test_toolbar_pushSettlesAfterRepoSwitched_doesNotMutateNewRepoState", async () => {
    let settle: (ok: boolean) => void = () => {};
    mockedPush.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          settle = (ok) => (ok ? resolve({ success: true, upstream_set: null }) : reject({ code: "REJECTED" }));
        }),
    );
    const { push } = renderToolbar();
    fireEvent.click(push);
    await waitFor(() => expect(useRepoStore.getState().pushPull.op).toBe("push"));

    useRepoStore.setState({ repoId: OTHER });
    useRepoStore.getState().clearPushPull();
    useRepoStore.getState().startPushPull("pull", OTHER);

    settle(false);
    await new Promise((r) => setTimeout(r, 0));
    const s = useRepoStore.getState().pushPull;
    expect([s.op, s.repoId]).toEqual(["pull", OTHER]);
    // 舊 repo 的失敗不掛到新 repo 的站牌上
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  it("test_toolbar_refreshClick_callsOnRefresh", () => {
    const onRefresh = vi.fn();
    fireEvent.click(renderToolbar({ onRefresh }).refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
