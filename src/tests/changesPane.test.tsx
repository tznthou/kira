import { render, fireEvent, act, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StagingArea } from "@/components/StagingArea/StagingArea";
import { useRepoStore } from "@/stores/repoStore";
import { useNoticeStore } from "@/stores/noticeStore";
import type { WorkingTreeStatus } from "@/lib/tauri";

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    getStatus: vi.fn(),
    stageFile: vi.fn(),
    unstageFile: vi.fn(),
    stageAll: vi.fn(),
    unstageAll: vi.fn(),
    commit: vi.fn(),
  };
});

import { getStatus, stageFile, unstageFile, stageAll, unstageAll, commit } from "@/lib/tauri";

const mocked = {
  getStatus: vi.mocked(getStatus),
  stageFile: vi.mocked(stageFile),
  unstageFile: vi.mocked(unstageFile),
  stageAll: vi.mocked(stageAll),
  unstageAll: vi.mocked(unstageAll),
  commit: vi.mocked(commit),
};

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
const CLEAN: WorkingTreeStatus = { staged: [], unstaged: [], conflicted: [], unstaged_truncated: false };
const SOME: WorkingTreeStatus = {
  staged: [{ path: "src/lib/a.ts", status: "Modified" }],
  unstaged: [
    { path: "README.md", status: "New" },
    { path: "src/old.ts", status: "Deleted" },
  ],
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

function setStatus(status: WorkingTreeStatus | null, extra: Partial<ReturnType<typeof useRepoStore.getState>> = {}) {
  useRepoStore.setState({ workingTreeStatus: status, statusError: false, ...extra });
}

const texts = (c: ParentNode, sel: string) => [...c.querySelectorAll(sel)].map((e) => e.textContent);
const button = (c: ParentNode, id: string) => c.querySelector<HTMLButtonElement>(`#${id}`)!;
const textarea = (c: ParentNode) => c.querySelector<HTMLTextAreaElement>("#msg")!;

const renderPane = (onCommitSuccess?: () => void) =>
  render(<StagingArea repoId={REPO} onCommitSuccess={onCommitSuccess} />);

beforeEach(() => {
  Object.values(mocked).forEach((m) => m.mockReset());
  mocked.getStatus.mockResolvedValue(CLEAN);
  // status 的三個序號與 refresh 的來源一起歸零：漏掉的話上一條測試的寫入序會讓這一條的重讀被丟掉（第二輪：
  // stageAllInFlight 單獨跑紅、整檔跑綠）
  useRepoStore.setState({
    repoId: REPO,
    workingTreeStatus: CLEAN,
    statusError: false,
    statusRequestId: 0,
    statusWrittenId: 0,
    statusUserPendingId: null,
    commitLoading: false,
    refreshing: false,
    refreshSource: null,
    pushPull: { op: null, repoId: null, percent: null },
  });
  useNoticeStore.setState({ notice: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---- 畫面（Phase 5 5c step 5，基準 renderStaging）----
describe("Changes pane: the reference's lists", () => {
  // status 還沒讀到（C1）：計數不顯示、兩區骨架列、按鈕都停用
  it("test_changes_statusUnread_drawsSkeletonsAndDisablesTheButtons", () => {
    setStatus(null);
    const { container } = renderPane();
    expect(container.querySelectorAll("#staged .sk-file").length).toBe(2);
    expect(container.querySelectorAll("#unstaged .sk-file").length).toBe(3);
    expect(container.querySelector("#n-staged")?.textContent).toBe("");
    expect(container.querySelector("#n-unstaged")?.textContent).toBe("");
    expect(button(container, "stage-all").disabled).toBe(true);
    expect(button(container, "unstage-all").disabled).toBe(true);
    expect(button(container, "commit").disabled).toBe(true);
    expect(container.querySelector(".empty-line")).toBeNull();
  });

  it("test_changes_rows_dirBaseBadgeAndStageButton", () => {
    setStatus(SOME);
    const { container } = renderPane();
    expect(container.querySelector("#n-staged")?.textContent).toBe("1");
    expect(container.querySelector("#n-unstaged")?.textContent).toBe("2");
    const row = container.querySelector("#staged .file")!;
    expect(row.querySelector(".fname")?.getAttribute("title")).toBe("src/lib/a.ts");
    expect(row.querySelector(".fname .dir")?.textContent).toBe("src/lib/");
    expect(row.querySelector(".fname .base")?.textContent).toBe("a.ts");
    expect(row.querySelector(".badge.M")?.getAttribute("title")).toBe("Modified");
    const unstageBtn = row.querySelector<HTMLButtonElement>(".stage-btn")!;
    expect(unstageBtn.getAttribute("aria-label")).toBe("Unstage src/lib/a.ts");
    expect(unstageBtn.dataset.op).toBe("unstage");
    expect(unstageBtn.querySelector("use")?.getAttribute("href")).toBe("#i-minus");
    expect(texts(container, "#unstaged .file .badge")).toEqual(["A", "D"]);
    expect(texts(container, "#unstaged .file .fname .dir")).toEqual(["", "src/"]);
    const stageBtn = container.querySelector<HTMLButtonElement>("#unstaged .stage-btn")!;
    expect(stageBtn.getAttribute("aria-label")).toBe("Stage README.md");
    expect(stageBtn.querySelector("use")?.getAttribute("href")).toBe("#i-plus");
    expect(button(container, "stage-all").disabled).toBe(false);
    expect(button(container, "unstage-all").disabled).toBe(false);
  });

  it("test_changes_emptyLists_sayNoChanges", () => {
    const { container } = renderPane();
    expect(container.querySelector("#staged .empty-line")?.textContent).toBe("No staged changes");
    expect(container.querySelector("#unstaged .empty-line")?.textContent).toBe("No changes");
    expect(container.querySelector("#n-staged")?.textContent).toBe("0");
    expect(button(container, "stage-all").disabled).toBe(true);
    expect(button(container, "unstage-all").disabled).toBe(true);
  });

  // 衝突（C3）：Staged 之上一個區段、一條說明、兩字徽章、沒有 stage 鈕；Commit 停用並說為什麼
  it("test_changes_conflicts_sectionStripBadges_commitDisabled", () => {
    setStatus({
      staged: [{ path: "src/components/Graph/rowRefs.ts", status: "Modified" }],
      unstaged: [],
      conflicted: [
        { path: "src/App.tsx", conflict_type: "BothModified" },
        { path: "src/components/Graph/RouteLayer.tsx", conflict_type: "BothAdded" },
        { path: "src/lib/graphLayout.ts", conflict_type: "DeletedByUs" },
      ],
      unstaged_truncated: false,
    });
    const { container } = renderPane();
    const section = container.querySelector("#conflicted")!;
    expect(section.querySelector(".stage-head h3")?.textContent).toBe("Conflicted 3");
    expect(section.querySelector(".strip")?.textContent).toBe(
      "3 files have conflicts. Fix them in your editor, then git add them.",
    );
    expect(texts(section, ".files .file .badge.C")).toEqual(["UU", "AA", "DU"]);
    expect([...section.querySelectorAll(".badge.C")].map((b) => b.getAttribute("title"))).toEqual([
      "Both modified",
      "Both added",
      "Deleted by us",
    ]);
    expect(section.querySelector(".stage-btn")).toBeNull();
    expect(section.querySelectorAll(".stage-gap").length).toBe(3);
    // 衝突區段在 Staged 之上
    expect(section.compareDocumentPosition(container.querySelector("#stage-lists")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(textarea(container), { target: { value: "half-resolved" } });
    expect(button(container, "commit").disabled).toBe(true);
    expect(button(container, "commit").getAttribute("title")).toBe("Resolve conflicts first");
  });

  it("test_changes_oneConflict_singular", () => {
    setStatus({ ...CLEAN, conflicted: [{ path: "a.txt", conflict_type: "DeletedByThem" }] });
    const { container } = renderPane();
    expect(container.querySelector("#conflicted .strip b")?.textContent).toBe("1 file has conflicts.");
    expect(container.querySelector("#conflicted .badge.C")?.textContent).toBe("UD");
  });

  // unstaged 截斷（C4）：計數 5,000+、Unstaged 標題下一條、Stage all 停用並說為什麼
  it("test_changes_truncated_stripCountAndStageAllDisabled", () => {
    setStatus({ ...SOME, unstaged_truncated: true });
    const { container } = renderPane();
    expect(container.querySelector("#n-unstaged")?.textContent).toBe("5,000+");
    expect(container.querySelector("#unstaged-note .strip")?.textContent).toBe(
      "Only the first 5,000 files are listed. Add a .gitignore to leave out build output.",
    );
    expect(button(container, "stage-all").disabled).toBe(true);
    expect(button(container, "stage-all").getAttribute("title")).toBe("Not every file is listed, so not all at once");
    // 條在清單之前
    const note = container.querySelector("#unstaged-note")!;
    expect(note.compareDocumentPosition(container.querySelector("#unstaged")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // 讀不到（Q-S）：清單藏起來、pane-empty 一行錯誤 + Retry
  it("test_changes_readError_paneEmptyHidesTheLists", () => {
    setStatus(null, { statusError: true });
    const { container } = renderPane();
    expect(container.querySelector("#stage-lists")?.hasAttribute("hidden")).toBe(true);
    const state = container.querySelector("#changes-state")!;
    expect(state.classList.contains("pane-empty")).toBe(true);
    expect(state.getAttribute("role")).toBe("alert");
    expect(state.querySelector("p b")?.textContent).toBe("Couldn't read your changes.");
    expect(state.querySelector(".hint")?.textContent).toBe("Nothing is listed until a read works.");
    expect(state.querySelector("#changes-retry")?.classList.contains("btn")).toBe(true);
    expect(container.querySelector("#conflicted")?.childElementCount).toBe(0);
    expect(button(container, "commit").disabled).toBe(true);
  });

  // 殼層忙碌（commit / push / pull / 使用者按的 refresh）：全部 stage 與 commit 停用；committing 時按鈕寫 Committing…
  it("test_changes_busy_disablesBulkAndCommit_saysCommitting", () => {
    setStatus(SOME, { refreshing: true, refreshSource: "user" });
    const { container } = renderPane();
    fireEvent.change(textarea(container), { target: { value: "x" } });
    expect(button(container, "stage-all").disabled).toBe(true);
    expect(button(container, "unstage-all").disabled).toBe(true);
    expect(button(container, "commit").disabled).toBe(true);
    expect(button(container, "commit").textContent).toBe("Commit");
    act(() => useRepoStore.setState({ refreshing: false, refreshSource: null, commitLoading: true }));
    expect(button(container, "commit").textContent).toBe("Committing…");
    act(() => useRepoStore.setState({ commitLoading: false }));
    expect(button(container, "commit").disabled).toBe(false);
  });

  // watcher / focus 的背景 refresh 不擋：每次 stage 後 400ms watcher 必然 refresh，擋了的話 stage → 打訊息 → ⌘↩
  // 在大 repo 上每次都有一段被靜默吞掉的窗（獨立審查員 CL-1）；來源不明的照擋。來源不明那段在送出之前驗——送出之後
  // 草稿已清、清單已重讀，按鈕本來就停用，驗不到這條規則（第二輪 CL-4）
  it("test_changes_backgroundRefresh_doesNotBlockCommitOrBulk", async () => {
    setStatus(SOME, { refreshing: true, refreshSource: null });
    mocked.commit.mockResolvedValue({ oid: "0123456789abcdef0123456789abcdef01234567" });
    const { container } = renderPane();
    fireEvent.change(textarea(container), { target: { value: "feat: x" } });
    // 來源不明：照擋，⌘↩ 不送
    expect(button(container, "stage-all").disabled).toBe(true);
    expect(button(container, "unstage-all").disabled).toBe(true);
    expect(button(container, "commit").disabled).toBe(true);
    fireEvent.keyDown(textarea(container), { key: "Enter", metaKey: true });
    await act(async () => undefined);
    expect(mocked.commit).not.toHaveBeenCalled();
    // 同一個畫面換成背景 refresh：全部解除，⌘↩ 送出
    act(() => useRepoStore.setState({ refreshSource: "background" }));
    expect(button(container, "stage-all").disabled).toBe(false);
    expect(button(container, "unstage-all").disabled).toBe(false);
    expect(button(container, "commit").disabled).toBe(false);
    fireEvent.keyDown(textarea(container), { key: "Enter", metaKey: true });
    await waitFor(() => expect(mocked.commit).toHaveBeenCalledWith(REPO, "feat: x"));
  });
});

// ---- 操作（step 6，0b P5 §3：按了才失敗 → 站牌提示、× 後焦點回那顆）----
describe("Changes pane: stage and commit, and what a failure does", () => {
  it("test_changes_stageClick_callsThenRereads", async () => {
    setStatus(SOME);
    mocked.stageFile.mockResolvedValue({ success: true });
    const { container } = renderPane();
    fireEvent.click(container.querySelector('#unstaged .stage-btn[data-path="README.md"]')!);
    await waitFor(() => expect(mocked.stageFile).toHaveBeenCalledWith(REPO, "README.md"));
    await waitFor(() => expect(mocked.getStatus).toHaveBeenCalledWith(REPO));
  });

  it("test_changes_unstageClick_callsThenRereads", async () => {
    setStatus(SOME);
    mocked.unstageFile.mockResolvedValue({ success: true });
    const { container } = renderPane();
    fireEvent.click(container.querySelector("#staged .stage-btn")!);
    await waitFor(() => expect(mocked.unstageFile).toHaveBeenCalledWith(REPO, "src/lib/a.ts"));
    await waitFor(() => expect(mocked.getStatus).toHaveBeenCalledWith(REPO));
  });

  it("test_changes_stageFails_noticeOnTheSign_focusBackToThatButton", async () => {
    setStatus(SOME);
    mocked.stageFile.mockRejectedValue({ code: "GIT_ERROR", message: "git operation failed" });
    const { container } = renderPane();
    const btn = container.querySelector<HTMLElement>('#unstaged .stage-btn[data-path="README.md"]')!;
    fireEvent.click(btn);
    await waitFor(() => expect(useNoticeStore.getState().notice?.title).toBe("Stage failed."));
    const notice = useNoticeStore.getState().notice!;
    expect(notice.detail).toBe("");
    expect(typeof notice.from).toBe("function");
    const from = notice.from as () => HTMLElement | null;
    expect(from()).toBe(btn);
    // 清單不動（沒有重讀）、沒有區內紅字
    expect(mocked.getStatus).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")).toBeNull();
    // 列重畫過（status 讀了一輪：骨架、再回來）：關提示時找的是現在掛著的那顆，不是出事當下那個節點
    act(() => setStatus(null));
    act(() => setStatus(SOME));
    expect(btn.isConnected).toBe(false);
    expect(from()).toBe(container.querySelector('#unstaged .stage-btn[data-path="README.md"]'));
  });

  it("test_changes_bulkFails_noticeFromThatButton", async () => {
    setStatus(SOME);
    mocked.stageAll.mockRejectedValue({ code: "GIT_ERROR", message: "git operation failed" });
    mocked.unstageAll.mockRejectedValue({ code: "GIT_ERROR", message: "git operation failed" });
    const { container } = renderPane();
    fireEvent.click(button(container, "stage-all"));
    await waitFor(() => expect(useNoticeStore.getState().notice?.title).toBe("Stage all failed."));
    expect((useNoticeStore.getState().notice!.from as () => HTMLElement | null)()).toBe(button(container, "stage-all"));
    fireEvent.click(button(container, "unstage-all"));
    await waitFor(() => expect(useNoticeStore.getState().notice?.title).toBe("Unstage all failed."));
    expect((useNoticeStore.getState().notice!.from as () => HTMLElement | null)()).toBe(button(container, "unstage-all"));
  });

  // 換了 repo 之後才失敗：不提示（提示會說成新 repo 的事）
  it("test_changes_stageFailsAfterRepoSwitch_saysNothing", async () => {
    setStatus(SOME);
    const op = deferred<{ success: boolean }>();
    mocked.stageFile.mockReturnValue(op.promise);
    const { container } = renderPane();
    fireEvent.click(container.querySelector("#unstaged .stage-btn")!);
    act(() => useRepoStore.setState({ repoId: "BBBBBBBBBBBBBBBBBBBBB" }));
    await act(async () => {
      op.reject({ code: "GIT_ERROR", message: "git operation failed" });
      await op.promise.catch(() => undefined);
    });
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  it("test_changes_startingAnOp_clearsTheOldNotice", async () => {
    setStatus(SOME);
    mocked.stageFile.mockResolvedValue({ success: true });
    useNoticeStore.getState().show({ title: "Refresh failed.", from: "refresh" });
    const { container } = renderPane();
    fireEvent.click(container.querySelector("#unstaged .stage-btn")!);
    expect(useNoticeStore.getState().notice).toBeNull();
    await waitFor(() => expect(mocked.getStatus).toHaveBeenCalled());
  });

  // bulk 進行中：commit 與兩顆 all 都停用（backend write_lock 不保證 IPC 順序）
  it("test_changes_stageAllInFlight_disablesCommitAndBothButtons", async () => {
    setStatus(SOME);
    const op = deferred<{ success: boolean }>();
    mocked.stageAll.mockReturnValue(op.promise);
    // 全部 stage 之後的重讀會寫進畫面：給它 stage 之後的清單（原本 unstaged 的兩檔也進了 staged）
    mocked.getStatus.mockResolvedValue({
      ...SOME,
      staged: [
        { path: "README.md", status: "New" },
        { path: "src/lib/a.ts", status: "Modified" },
        { path: "src/old.ts", status: "Deleted" },
      ],
      unstaged: [],
    });
    const { container } = renderPane();
    fireEvent.change(textarea(container), { target: { value: "race" } });
    expect(button(container, "commit").disabled).toBe(false);
    fireEvent.click(button(container, "stage-all"));
    await waitFor(() => expect(button(container, "stage-all").disabled).toBe(true));
    expect(button(container, "unstage-all").disabled).toBe(true);
    expect(button(container, "commit").disabled).toBe(true);
    await act(async () => {
      op.resolve({ success: true });
      await op.promise;
    });
    await waitFor(() => expect(button(container, "commit").disabled).toBe(false));
  });

  it("test_changes_commit_disabledWithoutMessageOrStagedFiles", () => {
    setStatus(SOME);
    const { container } = renderPane();
    expect(button(container, "commit").disabled).toBe(true);
    fireEvent.change(textarea(container), { target: { value: "   " } });
    expect(button(container, "commit").disabled).toBe(true);
    fireEvent.change(textarea(container), { target: { value: "feat: x" } });
    expect(button(container, "commit").disabled).toBe(false);
    act(() => setStatus(CLEAN));
    expect(button(container, "commit").disabled).toBe(true);
  });

  it("test_changes_commitSuccess_clearsTheMessageRereadsAndCallsBack", async () => {
    setStatus(SOME);
    mocked.commit.mockResolvedValue({ oid: "0123456789abcdef0123456789abcdef01234567" });
    const onCommitSuccess = vi.fn();
    const { container } = renderPane(onCommitSuccess);
    fireEvent.change(textarea(container), { target: { value: "feat: x" } });
    fireEvent.submit(container.querySelector("#commit-form")!);
    await waitFor(() => expect(mocked.commit).toHaveBeenCalledWith(REPO, "feat: x"));
    await waitFor(() => expect(textarea(container).value).toBe(""));
    await waitFor(() => expect(mocked.getStatus).toHaveBeenCalledWith(REPO));
    await waitFor(() => expect(onCommitSuccess).toHaveBeenCalledOnce());
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  it("test_changes_commitFails_keepsTheMessage_noticeFromTheCommitButton", async () => {
    setStatus(SOME);
    mocked.commit.mockRejectedValue({ code: "GIT_ERROR", message: "git operation failed" });
    const onCommitSuccess = vi.fn();
    const { container } = renderPane(onCommitSuccess);
    fireEvent.change(textarea(container), { target: { value: "feat: should-stay" } });
    fireEvent.submit(container.querySelector("#commit-form")!);
    await waitFor(() => expect(useNoticeStore.getState().notice?.title).toBe("Commit failed."));
    const notice = useNoticeStore.getState().notice!;
    expect(notice.detail).toBe("");
    expect((notice.from as () => HTMLElement | null)()).toBe(button(container, "commit"));
    expect(textarea(container).value).toBe("feat: should-stay");
    expect(onCommitSuccess).not.toHaveBeenCalled();
    expect(mocked.getStatus).not.toHaveBeenCalled();
    expect(useRepoStore.getState().commitLoading).toBe(false);
  });

  // commit 進行中 textarea 照基準不停用：等待期間新打的字不能被成功清掉（Codex C-2）
  it("test_changes_commitInFlight_editsMadeMeanwhileSurviveTheSuccess", async () => {
    setStatus(SOME);
    const op = deferred<{ oid: string }>();
    mocked.commit.mockReturnValue(op.promise);
    const { container } = renderPane();
    fireEvent.change(textarea(container), { target: { value: "feat: x" } });
    fireEvent.submit(container.querySelector("#commit-form")!);
    await waitFor(() => expect(mocked.commit).toHaveBeenCalledWith(REPO, "feat: x"));
    fireEvent.change(textarea(container), { target: { value: "feat: x, and then some" } });
    await act(async () => {
      op.resolve({ oid: "0123456789abcdef0123456789abcdef01234567" });
      await op.promise;
    });
    await waitFor(() => expect(container.querySelector("#commit-note")?.textContent).toBe("Committed 0123456"));
    expect(textarea(container).value).toBe("feat: x, and then some");
  });

  // 換了 repo 才回來的 commit：新 repo 的 note、清單、選取都不動（Codex C-2 + 獨立審查員 CL-2）；送出的那份草稿照樣
  // 清掉——它已經進了原本的 repo，而 textarea 是兩個 repo 共用的，留著的話在新 repo 按 ⌘↩ 就拿它去提交（第二輪 CL-3）
  it("test_changes_commitLandingAfterARepoSwitch_leavesTheNewRepoAlone", async () => {
    setStatus(SOME);
    const op = deferred<{ oid: string }>();
    mocked.commit.mockReturnValue(op.promise);
    const onCommitSuccess = vi.fn();
    const { container } = renderPane(onCommitSuccess);
    fireEvent.change(textarea(container), { target: { value: "feat: x" } });
    fireEvent.submit(container.querySelector("#commit-form")!);
    await waitFor(() => expect(mocked.commit).toHaveBeenCalledOnce());
    act(() => useRepoStore.setState({ repoId: "BBBBBBBBBBBBBBBBBBBBB" }));
    await act(async () => {
      op.resolve({ oid: "0123456789abcdef0123456789abcdef01234567" });
      await op.promise;
    });
    await act(async () => undefined);
    expect(mocked.getStatus).not.toHaveBeenCalled();
    expect(onCommitSuccess).not.toHaveBeenCalled();
    expect(textarea(container).value).toBe("");
    expect(container.querySelector("#commit-note")?.textContent).toBe("");
    expect(useRepoStore.getState().commitLoading).toBe(false);
  });

  // 換了 repo 之後打的字是新的草稿：原本那個 repo 的 commit 晚到也不清它（只清送出的那份；第二輪 CL-3 的另一面）
  it("test_changes_commitLandingAfterARepoSwitch_keepsWhatWasTypedSince", async () => {
    setStatus(SOME);
    const op = deferred<{ oid: string }>();
    mocked.commit.mockReturnValue(op.promise);
    const { container } = renderPane();
    fireEvent.change(textarea(container), { target: { value: "feat: x" } });
    fireEvent.submit(container.querySelector("#commit-form")!);
    await waitFor(() => expect(mocked.commit).toHaveBeenCalledOnce());
    act(() => useRepoStore.setState({ repoId: "BBBBBBBBBBBBBBBBBBBBB" }));
    fireEvent.change(textarea(container), { target: { value: "feat: b" } });
    await act(async () => {
      op.resolve({ oid: "0123456789abcdef0123456789abcdef01234567" });
      await op.promise;
    });
    await waitFor(() => expect(useRepoStore.getState().commitLoading).toBe(false));
    expect(textarea(container).value).toBe("feat: b");
  });

  // 換 repo 後才落地的 commit：清草稿（promise 續體裡的 useState）跟解除忙碌（zustand）不能分兩次畫。瀏覽器在事件以外
  // window.event 是 undefined，React 給前者 DefaultLane（下一個 task 才畫）、後者 SyncLane（microtask 內就畫），中間那幀
  // Commit 可按、textarea 還是已提交的訊息，⌘↩ 就把它 commit 進新 repo（第三輪 CL3-1）。jsdom 的 window.event 停在
  // 最後一個事件、act 會把兩次併成一次，所以這條照瀏覽器：window.event 設成 undefined、在 act 外落地、只跑 microtask、
  // 送原生 keydown
  it("test_changes_commitLandingAfterARepoSwitch_neverOffersTheSentMessageToTheNewRepo", async () => {
    setStatus(SOME);
    const op = deferred<{ oid: string }>();
    mocked.commit.mockReturnValueOnce(op.promise);
    const { container, rerender } = renderPane();
    fireEvent.change(textarea(container), { target: { value: "feat: x (for A)" } });
    fireEvent.submit(container.querySelector("#commit-form")!);
    await waitFor(() => expect(mocked.commit).toHaveBeenCalledOnce());
    // 換到 B：B 的清單已經讀到、有 staged（同一份 SOME）
    const B = "BBBBBBBBBBBBBBBBBBBBB";
    act(() => useRepoStore.setState({ repoId: B }));
    rerender(<StagingArea repoId={B} />);
    const own = Object.getOwnPropertyDescriptor(window, "event");
    Object.defineProperty(window, "event", { configurable: true, get: () => undefined });
    try {
      op.resolve({ oid: "0123456789abcdef0123456789abcdef01234567" });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      textarea(container).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }),
      );
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(mocked.commit).toHaveBeenCalledOnce();
    } finally {
      if (own) Object.defineProperty(window, "event", own);
      else delete (window as { event?: unknown }).event;
    }
    await waitFor(() => expect(useRepoStore.getState().commitLoading).toBe(false));
    expect(textarea(container).value).toBe("");
  });

  // commit 落地後、它的重讀回來前，清單還是 commit 之前那份（staged 還在）：忙碌得撐到重讀回來——否則等待期間新打的
  // 訊息一按就再送一次，後端回 NOTHING_TO_COMMIT，站牌在剛成功的 commit 之後說 Commit failed.（第二輪 Codex #2 / Gemini G1）
  it("test_changes_commitLanded_staysBusyUntilItsRereadLands", async () => {
    setStatus(SOME);
    const op = deferred<{ oid: string }>();
    mocked.commit.mockReturnValueOnce(op.promise);
    const reread = deferred<WorkingTreeStatus>();
    mocked.getStatus.mockReturnValue(reread.promise);
    const { container } = renderPane();
    fireEvent.change(textarea(container), { target: { value: "feat: x" } });
    fireEvent.submit(container.querySelector("#commit-form")!);
    await waitFor(() => expect(mocked.commit).toHaveBeenCalledOnce());
    fireEvent.change(textarea(container), { target: { value: "feat: y" } });
    await act(async () => {
      op.resolve({ oid: "0123456789abcdef0123456789abcdef01234567" });
      await op.promise;
    });
    await waitFor(() => expect(mocked.getStatus).toHaveBeenCalledOnce());
    // 重讀在飛：按鈕與 ⌘↩ 都不送
    expect(button(container, "commit").disabled).toBe(true);
    fireEvent.keyDown(textarea(container), { key: "Enter", metaKey: true });
    await act(async () => undefined);
    expect(mocked.commit).toHaveBeenCalledOnce();
    // 重讀回來才解除；等待期間打的訊息還在
    await act(async () => {
      reread.resolve(CLEAN);
      await reread.promise;
    });
    await waitFor(() => expect(useRepoStore.getState().commitLoading).toBe(false));
    expect(textarea(container).value).toBe("feat: y");
  });

  // commit 落地後、重讀還在飛時換了 repo：重讀回來不叫 onCommitSuccess——App 的 graph 重載讀的是當下的 repo，會拿這次
  // commit 去重載新 repo 的路線圖、重選它的 HEAD（第二輪 Codex #1 / Gemini G3；落地前就換的那條在上面）。同一個守門也管
  // note：照 App 的順序（store 換 id → 這格以新 id 重畫），新 repo 不亮另一個 repo 的「Committed …」（第三輪 CL3-2）
  it("test_changes_repoSwitchDuringTheCommitsReread_doesNotCallBack", async () => {
    setStatus(SOME);
    mocked.commit.mockResolvedValue({ oid: "0123456789abcdef0123456789abcdef01234567" });
    const reread = deferred<WorkingTreeStatus>();
    mocked.getStatus.mockReturnValue(reread.promise);
    const onCommitSuccess = vi.fn();
    const { container, rerender } = renderPane(onCommitSuccess);
    fireEvent.change(textarea(container), { target: { value: "feat: x" } });
    fireEvent.submit(container.querySelector("#commit-form")!);
    await waitFor(() => expect(mocked.getStatus).toHaveBeenCalledOnce());
    act(() => useRepoStore.setState({ repoId: "BBBBBBBBBBBBBBBBBBBBB" }));
    rerender(<StagingArea repoId="BBBBBBBBBBBBBBBBBBBBB" onCommitSuccess={onCommitSuccess} />);
    await act(async () => {
      reread.resolve(CLEAN);
      await reread.promise;
    });
    await waitFor(() => expect(useRepoStore.getState().commitLoading).toBe(false));
    await act(async () => undefined);
    expect(onCommitSuccess).not.toHaveBeenCalled();
    expect(container.querySelector("#commit-note")?.textContent).toBe("");
    expect(container.querySelector("#commit-note")?.classList.contains("show")).toBe(false);
  });

  // 「Committed …」跟 Commit 鈕回到可按同一刻亮（基準 commit 成功：清單、setBusy(null)、note 是同一段同步的程式）——
  // 重讀還在飛時就亮的話，旁邊的按鈕還寫 Committing…
  it("test_changes_commitNote_showsOnceCommitIsFreeAgain", async () => {
    setStatus(SOME);
    mocked.commit.mockResolvedValue({ oid: "0123456789abcdef0123456789abcdef01234567" });
    const reread = deferred<WorkingTreeStatus>();
    mocked.getStatus.mockReturnValue(reread.promise);
    const { container } = renderPane();
    fireEvent.change(textarea(container), { target: { value: "feat: x" } });
    fireEvent.submit(container.querySelector("#commit-form")!);
    await waitFor(() => expect(mocked.getStatus).toHaveBeenCalledOnce());
    // 重讀在飛：還在 Committing…，note 還沒亮
    expect(button(container, "commit").textContent).toBe("Committing…");
    expect(container.querySelector("#commit-note")?.textContent).toBe("");
    await act(async () => {
      reread.resolve(CLEAN);
      await reread.promise;
    });
    await waitFor(() => expect(container.querySelector("#commit-note")?.textContent).toBe("Committed 0123456"));
    expect(container.querySelector("#commit-note")?.classList.contains("show")).toBe(true);
    expect(button(container, "commit").textContent).toBe("Commit");
  });

  it("test_changes_commitFails_identityMissing_saysToSetNameAndEmail", async () => {
    setStatus(SOME);
    mocked.commit.mockRejectedValue({ code: "GIT_IDENTITY_MISSING", message: "no identity" });
    const { container } = renderPane();
    fireEvent.change(textarea(container), { target: { value: "feat: x" } });
    fireEvent.submit(container.querySelector("#commit-form")!);
    await waitFor(() => expect(useNoticeStore.getState().notice?.title).toBe("Commit failed."));
    expect(useNoticeStore.getState().notice?.detail).toBe("Set your git name and email.");
  });

  it("test_changes_cmdEnter_commits", async () => {
    setStatus(SOME);
    mocked.commit.mockResolvedValue({ oid: "0123456789abcdef0123456789abcdef01234567" });
    const { container } = renderPane();
    fireEvent.change(textarea(container), { target: { value: "feat: x" } });
    fireEvent.keyDown(textarea(container), { key: "Enter", metaKey: true });
    await waitFor(() => expect(mocked.commit).toHaveBeenCalledWith(REPO, "feat: x"));
    // 沒有訊息時按也不送
    await waitFor(() => expect(textarea(container).value).toBe(""));
    fireEvent.keyDown(textarea(container), { key: "Enter", ctrlKey: true });
    expect(mocked.commit).toHaveBeenCalledOnce();
  });

  // ⌘↩ 跟按鈕走同一條停用規則：有衝突、沒有 staged、使用者的 refresh 進行中都不送
  it("test_changes_cmdEnter_isBlockedLikeTheButton", async () => {
    setStatus({ ...SOME, conflicted: [{ path: "a.txt", conflict_type: "BothModified" }] });
    const { container } = renderPane();
    fireEvent.change(textarea(container), { target: { value: "feat: x" } });
    fireEvent.keyDown(textarea(container), { key: "Enter", metaKey: true });
    act(() => setStatus(CLEAN));
    fireEvent.keyDown(textarea(container), { key: "Enter", metaKey: true });
    act(() => setStatus(SOME, { refreshing: true, refreshSource: "user" }));
    fireEvent.keyDown(textarea(container), { key: "Enter", metaKey: true });
    await act(async () => undefined);
    expect(mocked.commit).not.toHaveBeenCalled();
  });

  // 換 repo：上一個 repo 的「Committed …」不帶過去
  it("test_changes_repoSwitch_dropsTheNote", async () => {
    setStatus(SOME);
    mocked.commit.mockResolvedValue({ oid: "0123456789abcdef0123456789abcdef01234567" });
    const { container, rerender } = renderPane();
    fireEvent.change(textarea(container), { target: { value: "feat: x" } });
    fireEvent.submit(container.querySelector("#commit-form")!);
    await waitFor(() => expect(container.querySelector("#commit-note")?.textContent).toBe("Committed 0123456"));
    act(() => useRepoStore.setState({ repoId: "BBBBBBBBBBBBBBBBBBBBB" }));
    rerender(<StagingArea repoId="BBBBBBBBBBBBBBBBBBBBB" />);
    expect(container.querySelector("#commit-note")?.textContent).toBe("");
    expect(container.querySelector("#commit-note")?.classList.contains("show")).toBe(false);
  });

  // 「Committed <7 碼>」在 Commit 旁亮 2.4 秒（step 7，基準 commit-note）：字留著、只有 .show 退掉；再 commit 一次重新計時
  it("test_changes_commitSuccess_notesTheNewCommitFor2400ms", async () => {
    vi.useFakeTimers();
    const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    try {
      setStatus(SOME);
      mocked.commit.mockResolvedValue({ oid: "0123456789abcdef0123456789abcdef01234567" });
      const { container } = renderPane();
      const note = () => container.querySelector("#commit-note")!;
      expect(note().textContent).toBe("");
      expect(note().classList.contains("show")).toBe(false);
      fireEvent.change(textarea(container), { target: { value: "feat: x" } });
      fireEvent.submit(container.querySelector("#commit-form")!);
      await settle();
      await settle();
      expect(note().textContent).toBe("Committed 0123456");
      expect(note().classList.contains("show")).toBe(true);
      expect(note().getAttribute("role")).toBe("status");
      act(() => vi.advanceTimersByTime(2399));
      expect(note().classList.contains("show")).toBe(true);
      act(() => vi.advanceTimersByTime(1));
      expect(note().classList.contains("show")).toBe(false);
      expect(note().textContent).toBe("Committed 0123456");

      // 再 commit 一次：換字、重新亮、重新計時
      mocked.commit.mockResolvedValue({ oid: "89abcdef0123456789abcdef0123456789abcdef" });
      act(() => setStatus(SOME));
      fireEvent.change(textarea(container), { target: { value: "feat: y" } });
      fireEvent.submit(container.querySelector("#commit-form")!);
      await settle();
      await settle();
      expect(note().textContent).toBe("Committed 89abcde");
      expect(note().classList.contains("show")).toBe(true);
      act(() => vi.advanceTimersByTime(2400));
      expect(note().classList.contains("show")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
