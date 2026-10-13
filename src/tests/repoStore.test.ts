import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useRepoStore } from "@/stores/repoStore";
import type {
  RepoInfo,
  ListBranchesResult,
  WorkingTreeStatus,
  AheadBehindInfo,
  GraphData,
} from "@/lib/tauri";

vi.mock("@/lib/tauri", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    getRepoInfo: vi.fn(),
    listBranches: vi.fn(),
    getStatus: vi.fn(),
    getAheadBehind: vi.fn(),
    getGraph: vi.fn(),
    getBranchStats: vi.fn(),
  };
});

import {
  getRepoInfo,
  listBranches,
  getStatus,
  getAheadBehind,
  getGraph,
  getBranchStats,
} from "@/lib/tauri";

const mockedGetRepoInfo = vi.mocked(getRepoInfo);
const mockedListBranches = vi.mocked(listBranches);
const mockedGetStatus = vi.mocked(getStatus);
const mockedGetAheadBehind = vi.mocked(getAheadBehind);
const mockedGetGraph = vi.mocked(getGraph);
const mockedGetBranchStats = vi.mocked(getBranchStats);

const REPO_A = "AAAAAAAAAAAAAAAAAAAAA";
const REPO_B = "BBBBBBBBBBBBBBBBBBBBB";

const FRESH_INFO: RepoInfo = {
  path: "/tmp/repo",
  head_branch: "feat-X",
  branches: [],
  remotes: ["origin"],
};

const STALE_INFO: RepoInfo = {
  path: "/tmp/repo",
  head_branch: "main",
  branches: [],
  remotes: ["origin"],
};

function resetStore() {
  useRepoStore.setState({
    repoId: null,
    repoInfo: null,
    workingTreeStatus: null,
    statusError: false,
    statusRequestId: 0,
    statusWrittenId: 0,
    statusUserPendingId: null,
    loading: false,
    commitLoading: false,
    pushPull: { op: null, repoId: null, percent: null },
    aheadBehind: null,
    aheadBehindRequestId: 0,
    refreshing: false,
    branches: null,
    detachedHeadOid: null,
    branchesError: false,
    branchStats: {},
    branchOpRequestId: 0,
  });
}

const EMPTY_BRANCHES: ListBranchesResult = {
  branches: [],
  detached_head_oid: null,
};

const CLEAN_STATUS: WorkingTreeStatus = {
  staged: [],
  unstaged: [],
  conflicted: [],
  unstaged_truncated: false,
};

const CLEAN_AHEAD_BEHIND: AheadBehindInfo = {
  ahead: 0,
  behind: 0,
  has_upstream: false,
  tracking_ref_exists: false,
  upstream_remote: null,
  upstream_branch: null,
};

const EMPTY_GRAPH: GraphData = {
  commits: [],
  branches: [],
  tags: [],
  truncated: false,
  head: { oid: null, branch: null },
  default_branch: null,
};

describe("repoStore.refreshRepoInfo", () => {
  beforeEach(() => {
    mockedGetRepoInfo.mockReset();
    resetStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_refreshRepoInfo_success_replacesStoreRepoInfo", async () => {
    useRepoStore.setState({ repoId: REPO_A, repoInfo: STALE_INFO });
    mockedGetRepoInfo.mockResolvedValue(FRESH_INFO);

    expect(await useRepoStore.getState().refreshRepoInfo()).toBe(true);

    expect(mockedGetRepoInfo).toHaveBeenCalledWith(REPO_A);
    expect(useRepoStore.getState().repoInfo).toEqual(FRESH_INFO);
  });

  it("test_refreshRepoInfo_noRepoId_isNoop", async () => {
    await useRepoStore.getState().refreshRepoInfo();
    expect(mockedGetRepoInfo).not.toHaveBeenCalled();
    expect(useRepoStore.getState().repoInfo).toBeNull();
  });

  // repo switch 期間 settle: A 的 fetch 完成時 store 已切 B, 不能用 A 的結果蓋 B
  it("test_refreshRepoInfo_repoSwitchedDuringSettle_doesNotOverwrite", async () => {
    useRepoStore.setState({ repoId: REPO_A });
    let resolveFetch: (v: RepoInfo) => void = () => {};
    mockedGetRepoInfo.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const refreshPromise = useRepoStore.getState().refreshRepoInfo();
    useRepoStore.setState({ repoId: REPO_B, repoInfo: STALE_INFO });
    resolveFetch(FRESH_INFO);
    await refreshPromise;

    expect(useRepoStore.getState().repoInfo).toEqual(STALE_INFO);
    expect(useRepoStore.getState().repoId).toBe(REPO_B);
  });

  // fail closed: IPC 失敗時清掉 repoInfo, 工具列（Toolbar）讀不到 branch 就停用 Pull / Push
  // — 比保留 stale head_branch 安全, 否則用戶仍可對 stale branch 按 push.
  it("test_refreshRepoInfo_ipcError_failsClosedSetsRepoInfoNull", async () => {
    useRepoStore.setState({ repoId: REPO_A, repoInfo: STALE_INFO });
    mockedGetRepoInfo.mockRejectedValue(new Error("network down"));

    // false：呼叫端要不要提示由它決定（commit 後重載把它算成重載失敗）
    expect(await useRepoStore.getState().refreshRepoInfo()).toBe(false);

    expect(useRepoStore.getState().repoInfo).toBeNull();
  });

  // catch 路徑也要守 repoId switch: 切 repo 後 error settle 不可清掉新 repo 的 repoInfo
  it("test_refreshRepoInfo_repoSwitchedThenError_doesNotMutateNewRepoState", async () => {
    useRepoStore.setState({ repoId: REPO_A });
    let rejectFetch: (e: unknown) => void = () => {};
    mockedGetRepoInfo.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectFetch = reject;
        }),
    );

    const refreshPromise = useRepoStore.getState().refreshRepoInfo();
    useRepoStore.setState({ repoId: REPO_B, repoInfo: FRESH_INFO });
    rejectFetch(new Error("late err"));
    await refreshPromise;

    expect(useRepoStore.getState().repoInfo).toEqual(FRESH_INFO);
  });
});

// 分支清單讀不到（Phase 5 Q-B，比照 Q-S）：背景重讀失敗留著舊清單、不顯示；使用者操作後的重讀、或還沒有
// 清單時失敗 → 清掉、branchesError（側欄畫一行錯誤 + Retry）
describe("repoStore.refreshBranches: a list that cannot be read", () => {
  const MAIN: ListBranchesResult = {
    branches: [{ name: "main", is_current: true, is_remote: false, upstream: null }],
    detached_head_oid: null,
  };

  beforeEach(() => {
    mockedListBranches.mockReset();
    resetStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_refreshBranches_backgroundFailure_keepsTheListQuietly", async () => {
    useRepoStore.setState({ repoId: REPO_A, branches: MAIN.branches });
    mockedListBranches.mockRejectedValue(new Error("boom"));
    await useRepoStore.getState().refreshBranches({ source: "background" });
    expect(useRepoStore.getState().branches).toEqual(MAIN.branches);
    expect(useRepoStore.getState().branchesError).toBe(false);
  });

  it("test_refreshBranches_userFailure_clearsTheListAndSaysSo", async () => {
    useRepoStore.setState({ repoId: REPO_A, branches: MAIN.branches });
    mockedListBranches.mockRejectedValue(new Error("boom"));
    await useRepoStore.getState().refreshBranches({ source: "user" });
    expect(useRepoStore.getState().branches).toBeNull();
    expect(useRepoStore.getState().branchesError).toBe(true);
  });

  // 開 repo：還沒有清單可留，背景或使用者都一樣說讀不到（否則永遠停在骨架）
  it("test_refreshBranches_failureWithNoList_saysSoEvenInTheBackground", async () => {
    useRepoStore.setState({ repoId: REPO_A });
    mockedListBranches.mockRejectedValue(new Error("boom"));
    await useRepoStore.getState().refreshBranches({ source: "background" });
    expect(useRepoStore.getState().branchesError).toBe(true);
  });

  // Retry：讀的期間錯誤先收掉（側欄畫骨架），讀到了清單回來
  it("test_refreshBranches_retry_clearsTheErrorWhileReadingThenShowsTheList", async () => {
    useRepoStore.setState({ repoId: REPO_A, branchesError: true });
    let resolve!: (v: ListBranchesResult) => void;
    mockedListBranches.mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = useRepoStore.getState().refreshBranches();
    expect(useRepoStore.getState().branchesError).toBe(false);
    expect(useRepoStore.getState().branches).toBeNull();
    resolve(MAIN);
    await pending;
    expect(useRepoStore.getState().branches).toEqual(MAIN.branches);
    expect(useRepoStore.getState().branchesError).toBe(false);
  });

  // 換了 repo 之後才回來的失敗：不碰新 repo 的狀態
  it("test_refreshBranches_lateFailureAfterRepoSwitch_isIgnored", async () => {
    useRepoStore.setState({ repoId: REPO_A });
    let reject!: (e: Error) => void;
    mockedListBranches.mockReturnValue(new Promise((_, r) => (reject = r)));
    const pending = useRepoStore.getState().refreshBranches();
    useRepoStore.setState({ repoId: REPO_B, branches: MAIN.branches });
    reject(new Error("boom"));
    await pending;
    expect(useRepoStore.getState().branches).toEqual(MAIN.branches);
    expect(useRepoStore.getState().branchesError).toBe(false);
  });
});

// working tree 讀不到（Phase 5 5c step 4，Codex #1 + Q-S）：背景重讀失敗留著舊清單、不顯示；使用者操作後的重讀、或還
// 沒有清單時失敗 → 清掉、statusError（Changes 畫一行錯誤 + Retry）。請求序號：只有最新一次讀的結果（成功或失敗）會寫入
describe("repoStore.refreshStatus: a status that cannot be read", () => {
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

  beforeEach(() => {
    mockedGetStatus.mockReset();
    resetStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_refreshStatus_backgroundFailure_keepsTheListQuietly", async () => {
    useRepoStore.setState({ repoId: REPO_A, workingTreeStatus: DIRTY });
    mockedGetStatus.mockRejectedValue(new Error("boom"));
    await useRepoStore.getState().refreshStatus({ source: "background" });
    expect(useRepoStore.getState().workingTreeStatus).toEqual(DIRTY);
    expect(useRepoStore.getState().statusError).toBe(false);
  });

  it("test_refreshStatus_userFailure_clearsTheListAndSaysSo", async () => {
    useRepoStore.setState({ repoId: REPO_A, workingTreeStatus: DIRTY });
    mockedGetStatus.mockRejectedValue(new Error("boom"));
    await useRepoStore.getState().refreshStatus({ source: "user" });
    expect(useRepoStore.getState().workingTreeStatus).toBeNull();
    expect(useRepoStore.getState().statusError).toBe(true);
  });

  // 開 repo：還沒有清單可留，背景或使用者都一樣說讀不到（否則永遠停在骨架）
  it("test_refreshStatus_failureWithNoList_saysSoEvenInTheBackground", async () => {
    useRepoStore.setState({ repoId: REPO_A });
    mockedGetStatus.mockRejectedValue(new Error("boom"));
    await useRepoStore.getState().refreshStatus({ source: "background" });
    expect(useRepoStore.getState().statusError).toBe(true);
  });

  // Retry：讀的期間錯誤先收掉（Changes 畫骨架），讀到了清單回來
  it("test_refreshStatus_retry_clearsTheErrorWhileReadingThenShowsTheList", async () => {
    useRepoStore.setState({ repoId: REPO_A, statusError: true });
    const read = deferred<WorkingTreeStatus>();
    mockedGetStatus.mockReturnValue(read.promise);
    const pending = useRepoStore.getState().refreshStatus();
    expect(useRepoStore.getState().statusError).toBe(false);
    expect(useRepoStore.getState().workingTreeStatus).toBeNull();
    read.resolve(DIRTY);
    await pending;
    expect(useRepoStore.getState().workingTreeStatus).toEqual(DIRTY);
    expect(useRepoStore.getState().statusError).toBe(false);
  });

  // 換了 repo 之後才回來的失敗：不碰新 repo 的狀態（舊實作就守 repoId，這條是守門）
  it("test_refreshStatus_lateFailureAfterRepoSwitch_isIgnored", async () => {
    useRepoStore.setState({ repoId: REPO_A });
    const read = deferred<WorkingTreeStatus>();
    mockedGetStatus.mockReturnValue(read.promise);
    const pending = useRepoStore.getState().refreshStatus();
    useRepoStore.setState({ repoId: REPO_B, workingTreeStatus: DIRTY });
    read.reject(new Error("boom"));
    await pending;
    expect(useRepoStore.getState().workingTreeStatus).toEqual(DIRTY);
    expect(useRepoStore.getState().statusError).toBe(false);
  });

  // 兩次讀反序回來（stage 後的重讀 vs watcher 的背景重讀）：後發的那次是最新的，先發後到的不能蓋掉它
  it("test_refreshStatus_twoReadsSettleOutOfOrder_theNewerOneWins", async () => {
    useRepoStore.setState({ repoId: REPO_A });
    const first = deferred<WorkingTreeStatus>();
    const second = deferred<WorkingTreeStatus>();
    mockedGetStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = useRepoStore.getState().refreshStatus({ source: "user" });
    const p2 = useRepoStore.getState().refreshStatus({ source: "background" });
    second.resolve(CLEAN_STATUS);
    await p2;
    expect(useRepoStore.getState().workingTreeStatus).toEqual(CLEAN_STATUS);
    first.resolve(DIRTY);
    await p1;
    expect(useRepoStore.getState().workingTreeStatus).toEqual(CLEAN_STATUS);
  });

  // 先發的失敗在後發的成功之後才回來：清單是新的，不說讀不到（Codex #1：舊回覆推翻 Retry）
  it("test_refreshStatus_anOlderFailureLandingAfterANewerSuccess_isIgnored", async () => {
    useRepoStore.setState({ repoId: REPO_A, statusError: true });
    const first = deferred<WorkingTreeStatus>();
    const second = deferred<WorkingTreeStatus>();
    mockedGetStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = useRepoStore.getState().refreshStatus();
    const p2 = useRepoStore.getState().refreshStatus();
    second.resolve(DIRTY);
    await p2;
    first.reject(new Error("boom"));
    await p1;
    expect(useRepoStore.getState().workingTreeStatus).toEqual(DIRTY);
    expect(useRepoStore.getState().statusError).toBe(false);
  });

  // stage 後的重讀還沒回來，watcher 就再發了一次背景重讀：第一次的清單仍是對的，照寫；第二次失敗留的是它，
  // 不是 stage 之前的那份（側 agent 提醒：「只有最新一次算」會把正確的那次丟掉）
  it("test_refreshStatus_anOlderSuccessLandingBeforeANewerBackgroundFailure_isKept", async () => {
    const OLD: WorkingTreeStatus = { ...CLEAN_STATUS, unstaged: [{ path: "a.ts", status: "Modified" }] };
    useRepoStore.setState({ repoId: REPO_A, workingTreeStatus: OLD });
    const first = deferred<WorkingTreeStatus>();
    const second = deferred<WorkingTreeStatus>();
    mockedGetStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = useRepoStore.getState().refreshStatus({ source: "user" });
    const p2 = useRepoStore.getState().refreshStatus({ source: "background" });
    first.resolve(DIRTY);
    await p1;
    expect(useRepoStore.getState().workingTreeStatus).toEqual(DIRTY);
    second.reject(new Error("boom"));
    await p2;
    expect(useRepoStore.getState().workingTreeStatus).toEqual(DIRTY);
    expect(useRepoStore.getState().statusError).toBe(false);
  });

  // stage 後的重讀與超車它的背景重讀都失敗（Codex C-1）：使用者的那次不是最新也算數，不能由背景的那次替它留舊清單——
  // 兩種完成順序都要清掉、說讀不到
  it("test_refreshStatus_userReadAndTheBackgroundReadThatOvertookIt_bothFail_userFirst_clearsTheList", async () => {
    const OLD: WorkingTreeStatus = { ...CLEAN_STATUS, unstaged: [{ path: "a.ts", status: "Modified" }] };
    useRepoStore.setState({ repoId: REPO_A, workingTreeStatus: OLD });
    const first = deferred<WorkingTreeStatus>();
    const second = deferred<WorkingTreeStatus>();
    mockedGetStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = useRepoStore.getState().refreshStatus({ source: "user" });
    const p2 = useRepoStore.getState().refreshStatus({ source: "background" });
    first.reject(new Error("boom"));
    await p1;
    expect(useRepoStore.getState().workingTreeStatus).toBeNull();
    expect(useRepoStore.getState().statusError).toBe(true);
    second.reject(new Error("boom"));
    await p2;
    expect(useRepoStore.getState().workingTreeStatus).toBeNull();
    expect(useRepoStore.getState().statusError).toBe(true);
  });

  it("test_refreshStatus_userReadAndTheBackgroundReadThatOvertookIt_bothFail_backgroundFirst_clearsTheList", async () => {
    const OLD: WorkingTreeStatus = { ...CLEAN_STATUS, unstaged: [{ path: "a.ts", status: "Modified" }] };
    useRepoStore.setState({ repoId: REPO_A, workingTreeStatus: OLD });
    const first = deferred<WorkingTreeStatus>();
    const second = deferred<WorkingTreeStatus>();
    mockedGetStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = useRepoStore.getState().refreshStatus({ source: "user" });
    const p2 = useRepoStore.getState().refreshStatus({ source: "background" });
    second.reject(new Error("boom"));
    await p2;
    // 使用者的讀還在飛：先留著，由它決定
    expect(useRepoStore.getState().workingTreeStatus).toEqual(OLD);
    expect(useRepoStore.getState().statusError).toBe(false);
    first.reject(new Error("boom"));
    await p1;
    expect(useRepoStore.getState().workingTreeStatus).toBeNull();
    expect(useRepoStore.getState().statusError).toBe(true);
  });

  // Retry 在飛、背景重讀超車它、先失敗（手上沒有清單）：不替 Retry 決定，Retry 成功就寫進來（獨立審查員 CL-3 /
  // Gemini：失敗一律蓋寫入序會把它丟掉，畫面停在讀不到）
  it("test_refreshStatus_retryOvertakenByABackgroundFailure_stillLandsItsSuccess", async () => {
    useRepoStore.setState({ repoId: REPO_A, statusError: true });
    const first = deferred<WorkingTreeStatus>();
    const second = deferred<WorkingTreeStatus>();
    mockedGetStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = useRepoStore.getState().refreshStatus({ source: "user" });
    const p2 = useRepoStore.getState().refreshStatus({ source: "background" });
    second.reject(new Error("boom"));
    await p2;
    expect(useRepoStore.getState().workingTreeStatus).toBeNull();
    first.resolve(DIRTY);
    await p1;
    expect(useRepoStore.getState().workingTreeStatus).toEqual(DIRTY);
    expect(useRepoStore.getState().statusError).toBe(false);
  });

  // 同一組反過來：背景的那次先失敗（使用者的讀還在飛，留著舊清單），stage 的重讀後到——它比畫面上的新，照寫
  it("test_refreshStatus_anOlderSuccessLandingAfterANewerBackgroundFailure_isWritten", async () => {
    const OLD: WorkingTreeStatus = { ...CLEAN_STATUS, unstaged: [{ path: "a.ts", status: "Modified" }] };
    useRepoStore.setState({ repoId: REPO_A, workingTreeStatus: OLD });
    const first = deferred<WorkingTreeStatus>();
    const second = deferred<WorkingTreeStatus>();
    mockedGetStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = useRepoStore.getState().refreshStatus({ source: "user" });
    const p2 = useRepoStore.getState().refreshStatus({ source: "background" });
    second.reject(new Error("boom"));
    await p2;
    expect(useRepoStore.getState().workingTreeStatus).toEqual(OLD);
    first.resolve(DIRTY);
    await p1;
    expect(useRepoStore.getState().workingTreeStatus).toEqual(DIRTY);
    expect(useRepoStore.getState().statusError).toBe(false);
  });

  // Retry 還在飛，比它更早發出的那次失敗先回來：不推翻讀取中的骨架（失敗只有最新一次的算；守門，兩版都綠）
  it("test_refreshStatus_anOlderFailureLandingWhileARetryFlies_isIgnored", async () => {
    useRepoStore.setState({ repoId: REPO_A, statusError: true });
    const first = deferred<WorkingTreeStatus>();
    const second = deferred<WorkingTreeStatus>();
    mockedGetStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = useRepoStore.getState().refreshStatus({ source: "background" });
    const p2 = useRepoStore.getState().refreshStatus({ source: "user" });
    expect(useRepoStore.getState().statusError).toBe(false);
    first.reject(new Error("boom"));
    await p1;
    expect(useRepoStore.getState().statusError).toBe(false);
    second.resolve(DIRTY);
    await p2;
    expect(useRepoStore.getState().workingTreeStatus).toEqual(DIRTY);
  });

  // 先發的成功在後發的失敗之後才回來：Changes 已經說讀不到，舊清單不能回來蓋掉它
  it("test_refreshStatus_anOlderSuccessLandingAfterANewerFailure_isIgnored", async () => {
    useRepoStore.setState({ repoId: REPO_A });
    const first = deferred<WorkingTreeStatus>();
    const second = deferred<WorkingTreeStatus>();
    mockedGetStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = useRepoStore.getState().refreshStatus({ source: "user" });
    const p2 = useRepoStore.getState().refreshStatus({ source: "user" });
    second.reject(new Error("boom"));
    await p2;
    expect(useRepoStore.getState().statusError).toBe(true);
    first.resolve(DIRTY);
    await p1;
    expect(useRepoStore.getState().workingTreeStatus).toBeNull();
    expect(useRepoStore.getState().statusError).toBe(true);
  });
});

describe("repoStore.refreshBranchStats", () => {
  beforeEach(() => {
    resetStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 後端省略不認得的名字：問過的一律記一筆（沒有的記成不知道），側欄才不會一直再問
  it("test_refreshBranchStats_namesTheReplyLeftOut_areRecordedAsUnknown", async () => {
    useRepoStore.setState({ repoId: REPO_A });
    mockedGetBranchStats.mockResolvedValue({ main: { ahead: 1, behind: 0 } });
    await useRepoStore.getState().refreshBranchStats(["main", "gone"]);
    expect(useRepoStore.getState().branchStats).toEqual({
      main: { ahead: 1, behind: 0 },
      gone: { ahead: null, behind: null },
    });
  });
});

describe("repoStore.runBranchOp", () => {
  beforeEach(() => {
    mockedGetRepoInfo.mockReset().mockResolvedValue(FRESH_INFO);
    mockedListBranches.mockReset().mockResolvedValue(EMPTY_BRANCHES);
    mockedGetStatus.mockReset().mockResolvedValue(CLEAN_STATUS);
    mockedGetAheadBehind.mockReset().mockResolvedValue(CLEAN_AHEAD_BEHIND);
    mockedGetGraph.mockReset().mockResolvedValue(EMPTY_GRAPH);
    resetStore();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Regression: refreshBranches must NOT bump branchOpRequestId, otherwise
  // runBranchOp's finally check sees a mismatched epoch and strands
  // `refreshing: true`. Symptom in dev smoke: "+ New branch" button stays
  // disabled after the first successful op (cursor: not-allowed).
  it("test_runBranchOp_clearsRefreshingAfterSuccess", async () => {
    useRepoStore.setState({ repoId: REPO_A });
    const op = vi.fn().mockResolvedValue("ok");

    await useRepoStore.getState().runBranchOp(op);

    expect(op).toHaveBeenCalledOnce();
    expect(useRepoStore.getState().refreshing).toBe(false);
  });

  // Op throw still must clear refreshing — otherwise BRANCH_EXISTS / DIRTY_TREE
  // errors permanently disable the next op's button.
  it("test_runBranchOp_clearsRefreshingAfterOpThrows", async () => {
    useRepoStore.setState({ repoId: REPO_A });
    const op = vi.fn().mockRejectedValue(new Error("BRANCH_EXISTS"));

    await expect(useRepoStore.getState().runBranchOp(op)).rejects.toThrow();

    expect(useRepoStore.getState().refreshing).toBe(false);
  });

  // Serial fan-out must run in declared order: refreshRepoInfo → refreshBranches
  // → refreshStatus → refreshAheadBehind → getGraph. Prevents mixed-state window
  // where BranchList shows new HEAD while graph still reflects the previous one.
  it("test_runBranchOp_fanOutRunsAllRefreshesInOrder", async () => {
    useRepoStore.setState({ repoId: REPO_A });
    const callOrder: string[] = [];
    mockedGetRepoInfo.mockImplementation(async () => {
      callOrder.push("repoInfo");
      return FRESH_INFO;
    });
    mockedListBranches.mockImplementation(async () => {
      callOrder.push("branches");
      return EMPTY_BRANCHES;
    });
    mockedGetStatus.mockImplementation(async () => {
      callOrder.push("status");
      return CLEAN_STATUS;
    });
    mockedGetAheadBehind.mockImplementation(async () => {
      callOrder.push("aheadBehind");
      return CLEAN_AHEAD_BEHIND;
    });
    mockedGetGraph.mockImplementation(async () => {
      callOrder.push("graph");
      return EMPTY_GRAPH;
    });

    await useRepoStore.getState().runBranchOp(vi.fn().mockResolvedValue("ok"));

    expect(callOrder).toEqual([
      "repoInfo",
      "branches",
      "status",
      "aheadBehind",
      "graph",
    ]);
  });
});
