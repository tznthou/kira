import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act, fireEvent } from "@testing-library/react";
import { DiffViewer } from "@/components/DiffViewer/DiffViewer";
import { useGraphStore } from "@/stores/graphStore";
import type { CommitNode, DiffFile, DiffResult } from "@/lib/tauri";

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>(
    "@/lib/tauri",
  );
  return {
    ...actual,
    getDiff: vi.fn(),
  };
});

import { getDiff } from "@/lib/tauri";

// 真的上色器，只多一層計數（「重畫不重上色」用）：highlight 是每一行、escCode 是檔頭的路徑與 hunk 標頭
vi.mock("@/lib/v8-highlight", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/v8-highlight")>();
  return { ...m, highlight: vi.fn(m.highlight), escCode: vi.fn(m.escCode) };
});
import { escCode, highlight } from "@/lib/v8-highlight";

const mockedGetDiff = vi.mocked(getDiff);

const TEST_REPO_ID = "AAAAAAAAAAAAAAAAAAAAA";

function makeCommit(oid: string, parents: string[] = []): CommitNode {
  return {
    oid: oid.slice(0, 7),
    full_oid: oid,
    message: "test commit",
    author: { name: "t", email: "t@example.com", timestamp: 0 },
    parents,
    refs: [],
  };
}

function resetStore(commit: CommitNode | null = null) {
  useGraphStore.setState({
    graphData: null,
    selectedCommit: commit,
    selectionFromRepeat: false,
    repoId: TEST_REPO_ID,
    loading: false,
    error: null,
  });
}

const view = (repoId: string | null = TEST_REPO_ID, unborn = false) =>
  render(<DiffViewer repoId={repoId} unborn={unborn} />);
const diffArea = () => document.getElementById("diff") as HTMLElement;
const dpaths = () => [...document.querySelectorAll(".dfile .dpath")].map((p) => p.textContent);
const strips = () => [...document.querySelectorAll(".diff-scroll > .strip")].map((s) => s.textContent);

describe("DiffViewer", () => {
  beforeEach(() => {
    mockedGetDiff.mockReset();
    resetStore(null);
  });
  afterEach(() => cleanup());

  // Retry 之後焦點停在這一區（Q-F）：它自己有名字、能拿焦點、不在 Tab 順序裡
  it("test_diffViewer_area_isANamedRegionThatTakesFocus", () => {
    view();
    const area = screen.getByRole("region", { name: "Diff" });
    expect(area).toBe(diffArea());
    expect(area.className).toBe("diff-scroll");
    expect(area.getAttribute("tabindex")).toBe("-1");
  });

  it("test_diffViewer_noSelectedCommit_showsIdleHintWithKeys", () => {
    view();
    expect(screen.getByText("Select a commit to view its diff")).toBeTruthy();
    expect([...diffArea().querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["↑", "↓", "Esc"]);
    expect(mockedGetDiff).not.toHaveBeenCalled();
  });

  it("test_diffViewer_repoIdNull_showsIdleHint", () => {
    resetStore(makeCommit("a".repeat(40)));
    view(null);
    expect(screen.getByText("Select a commit to view its diff")).toBeTruthy();
    expect(mockedGetDiff).not.toHaveBeenCalled();
  });

  // E9：空 repo 沒有站可選，不提鍵盤
  it("test_diffViewer_unborn_saysNothingToCompareWithoutKeys", () => {
    view(TEST_REPO_ID, true);
    expect(screen.getByText("Nothing to compare yet")).toBeTruthy();
    expect(screen.getByText("Your first commit will show here.")).toBeTruthy();
    expect(diffArea().querySelector("kbd")).toBeNull();
  });

  it("test_diffViewer_loading_drawsFourSkeletonBars", () => {
    mockedGetDiff.mockReturnValue(new Promise<DiffResult>(() => {}));
    resetStore(makeCommit("a".repeat(40)));
    view();
    const skeleton = diffArea().querySelector(".skeleton");
    expect(skeleton?.getAttribute("aria-label")).toBe("Loading diff");
    // 沒有 role 的 div 不會以那個名字進無障礙樹（審查：main 的 Skeleton 有 role=status，這裡換成 div 不能退步）
    expect(skeleton?.getAttribute("role")).toBe("status");
    expect(skeleton?.getAttribute("aria-busy")).toBe("true");
    expect([...(skeleton?.querySelectorAll("i") ?? [])].map((i) => (i as HTMLElement).style.width)).toEqual([
      "42%",
      "88%",
      "76%",
      "64%",
    ]);
  });

  it("test_diffViewer_textFile_rendersHunksWithLines", async () => {
    const result: DiffResult = {
      truncated: false,
      files: [
        {
          path: "src/foo.ts",
          status: "Modified",
          binary: false,
          too_large: false,
          omitted: null,
          hunks: [
            {
              old_start: 1,
              old_lines: 1,
              new_start: 1,
              new_lines: 2,
              context: "",
              lines: [
                { origin: " ", content: "context", old_lineno: 1, new_lineno: 1 },
                { origin: "+", content: "added", old_lineno: null, new_lineno: 2 },
              ],
            },
          ],
        },
      ],
    };
    mockedGetDiff.mockResolvedValue(result);
    resetStore(makeCommit("a".repeat(40)));

    view();
    await waitFor(() => expect(dpaths()).toEqual(["src/foo.ts"]));
    expect([...diffArea().querySelectorAll(".dl code")].map((c) => c.textContent)).toEqual(["context", "added"]);
    expect(diffArea().querySelector(".hunk-head")?.textContent).toBe("@@ -1,1 +1,2 @@");
  });

  it("test_diffViewer_binaryFile_showsBinaryNotice", async () => {
    mockedGetDiff.mockResolvedValue({
      truncated: false,
      files: [
        {
          path: "logo.png",
          status: "Modified",
          binary: true,
          too_large: false,
          omitted: null,
          hunks: [],
        },
      ],
    });
    resetStore(makeCommit("b".repeat(40)));

    view();
    await waitFor(() => {
      expect(screen.getByText("Binary file")).toBeTruthy();
    });
  });

  it("test_diffViewer_tooLargeFile_showsSizeNotice_notBinary", async () => {
    mockedGetDiff.mockResolvedValue({
      truncated: false,
      files: [
        {
          path: "huge.bin",
          status: "Modified",
          // 邊界：libgit2 對 too_large 也 set BINARY raw flag，但前端 schema 已分流為
          // too_large=true / binary=false。UI 必須優先顯示 size notice 而非 binary notice。
          binary: false,
          too_large: true,
          omitted: null,
          hunks: [],
        },
      ],
    });
    resetStore(makeCommit("c".repeat(40)));

    view();
    await waitFor(() => {
      expect(screen.getByText("Over 10 MB.")).toBeTruthy();
    });
    expect(screen.queryByText(/Binary file/)).toBeNull();
  });

  it("test_diffViewer_getDiffRejects_saysSoWithARetry", async () => {
    mockedGetDiff.mockRejectedValue({ code: "COMMIT_NOT_FOUND" });
    resetStore(makeCommit("d".repeat(40)));

    view();
    const alert = await screen.findByRole("alert");
    expect(alert.querySelector("b")?.textContent).toBe("Couldn't load this diff.");
    expect(alert.querySelector(".hint")?.textContent).toBe("Try again, or pick another station.");
    expect(alert.querySelector("button#diff-retry")?.textContent).toBe("Retry");
  });

  // E2：這個 commit 沒有改任何檔
  it("test_diffViewer_emptyFiles_saysNoFileChanges", async () => {
    mockedGetDiff.mockResolvedValue({ truncated: false, files: [] });
    resetStore(makeCommit("e".repeat(40)));

    view();
    await waitFor(() => expect(screen.getByText("No file changes")).toBeTruthy());
    expect(screen.getByText("This commit changes no files.")).toBeTruthy();
  });

  // 收合的檔給的指令跟 Kira 算 diff 一樣對第一個 parent：merge 加 -m --first-parent（parent 數來自選取的 commit）
  it("test_diffViewer_omittedFileOfAMerge_givesTheFirstParentCommand", async () => {
    mockedGetDiff.mockResolvedValue({ truncated: false, files: [omittedFile("package-lock.json", "File", 3412, 96000)] });
    resetStore(makeCommit("6".repeat(40), ["p1", "p2"]));

    view();
    await waitFor(() => expect(diffArea().querySelector(".how code")).not.toBeNull());
    expect(diffArea().querySelector(".how code")?.textContent).toBe(
      "git show -m --first-parent 666666666666 -- package-lock.json",
    );
  });

  // ---- 條：檔數截斷（E3）與顯示上限收合的檔（E4） ----

  function omittedFile(path: string, reason: "File" | "Total", lines: number, bytes: number): DiffFile {
    return { path, status: "Modified", binary: false, too_large: false, hunks: [], omitted: { reason, lines, bytes } };
  }

  function shownFile(path: string): DiffFile {
    return {
      path,
      status: "Modified",
      binary: false,
      too_large: false,
      omitted: null,
      hunks: [
        {
          old_start: 1,
          old_lines: 1,
          new_start: 1,
          new_lines: 1,
          context: "",
          lines: [{ origin: "+", content: "shown", old_lineno: null, new_lineno: 1 }],
        },
      ],
    };
  }

  async function drawDiff(result: DiffResult, oidChar: string) {
    mockedGetDiff.mockResolvedValue(result);
    resetStore(makeCommit(oidChar.repeat(40)));
    view();
    await waitFor(() => expect(dpaths()).toEqual(result.files.map((f) => f.path)));
  }

  // 審查：切換選取時上一站的檔立刻消失、換成骨架，不等新的結果（B1「選取換了先畫骨架、不留上一筆」）
  it("test_diffViewer_newSelection_dropsThePreviousFilesForTheSkeleton", async () => {
    await drawDiff({ truncated: false, files: [shownFile("a.ts")] }, "a");
    mockedGetDiff.mockReturnValueOnce(new Promise<DiffResult>(() => {}));
    act(() => useGraphStore.getState().actions.setSelectedCommit(makeCommit("b".repeat(40))));
    expect(dpaths()).toEqual([]);
    expect(diffArea().querySelector(".skeleton")).not.toBeNull();
  });

  it("test_diffViewer_truncated_stripSaysOnlyTheFirstFilesShow", async () => {
    await drawDiff({ truncated: true, files: [shownFile("a.ts"), shownFile("b.ts")] }, "f");
    expect(strips()).toEqual(["Showing the first 2 files. This commit changes more."]);
  });

  // 審查：App 重畫（切 tab、對話框、refresh）時 DiffViewer 的 props 沒變，畫著的 diff 不該整個重畫——行的上色
  // 由 Hunk 的 useMemo 擋，檔頭（路徑、hunk 標頭的 escCode）由 memo 的 FileDiff 擋，所以 `at` 要是同一個物件
  it("test_diffViewer_rerenderWithTheSameProps_doesNotDrawTheFilesAgain", async () => {
    mockedGetDiff.mockResolvedValue({ truncated: false, files: [shownFile("a.ts"), shownFile("b.ts")] });
    resetStore(makeCommit("f".repeat(40)));
    vi.mocked(highlight).mockClear();
    vi.mocked(escCode).mockClear();
    const { rerender } = render(<DiffViewer repoId={TEST_REPO_ID} unborn={false} />);
    await waitFor(() => expect(dpaths()).toEqual(["a.ts", "b.ts"]));
    const coloured = vi.mocked(highlight).mock.calls.length;
    const escaped = vi.mocked(escCode).mock.calls.length;
    expect(coloured).toBe(2);
    expect(escaped).toBeGreaterThan(0);
    rerender(<DiffViewer repoId={TEST_REPO_ID} unborn={false} />);
    expect(vi.mocked(highlight).mock.calls.length).toBe(coloured);
    expect(vi.mocked(escCode).mock.calls.length).toBe(escaped);
  });

  it("test_diffViewer_omittedFiles_stripCountsEachReason", async () => {
    await drawDiff(
      {
        truncated: false,
        files: [
          omittedFile("a.lock", "File", 3000, 12000),
          omittedFile("b.ts", "Total", 900, 3600),
          omittedFile("c.ts", "Total", 800, 3200),
          shownFile("d.ts"),
        ],
      },
      "3",
    );
    expect(strips()).toEqual(["3 of 4 files not shown. 1 too large, 2 over the display limit."]);
    // 放得下的檔照常畫出來
    expect(screen.getByText("shown")).toBeTruthy();
  });

  it("test_diffViewer_omittedFiles_singleReason_leavesTheOtherOut", async () => {
    await drawDiff({ truncated: false, files: [omittedFile("a.lock", "File", 3000, 12000), shownFile("b.ts")] }, "4");
    expect(strips()).toEqual(["1 of 2 files not shown. 1 too large."]);
  });

  it("test_diffViewer_omittedFiles_overTheLimitOnly", async () => {
    await drawDiff({ truncated: false, files: [shownFile("a.ts"), omittedFile("b.ts", "Total", 900, 3600)] }, "7");
    expect(strips()).toEqual(["1 of 2 files not shown. 1 over the display limit."]);
  });

  it("test_diffViewer_fileCountAndBudgetStrips_bothShow", async () => {
    await drawDiff({ truncated: true, files: [omittedFile("a.lock", "File", 3000, 12000)] }, "5");
    expect(strips()).toEqual(["Showing the first 1 files. This commit changes more.", "1 of 1 file not shown. 1 too large."]);
  });

  // 超過 10 MB 與二進位不算收合（同 B1 的計數）
  it("test_diffViewer_noOmittedFiles_noStrip", async () => {
    await drawDiff(
      {
        truncated: false,
        files: [shownFile("a.ts"), { ...shownFile("b.bin"), hunks: [], too_large: true }, { ...shownFile("c.png"), hunks: [], binary: true }],
      },
      "6",
    );
    expect(strips()).toEqual([]);
  });

  // 換成新的結果：捲回頂端、重播進場（基準對 #diff 拿掉再加上 .enter）
  it("test_diffViewer_newResult_scrollsToTheTopAndEntersAgain", async () => {
    mockedGetDiff.mockResolvedValue({ truncated: false, files: [shownFile("a.ts")] });
    resetStore(makeCommit("8".repeat(40)));
    view();
    await waitFor(() => expect(dpaths()).toEqual(["a.ts"]));
    expect(diffArea().classList.contains("enter")).toBe(true);
    diffArea().scrollTop = 120;
    const removed = vi.spyOn(diffArea().classList, "remove");
    mockedGetDiff.mockResolvedValue({ truncated: false, files: [shownFile("b.ts")] });
    act(() => useGraphStore.getState().actions.setSelectedCommit(makeCommit("9".repeat(40))));
    await waitFor(() => expect(dpaths()).toEqual(["b.ts"]));
    expect(diffArea().scrollTop).toBe(0);
    expect(removed).toHaveBeenCalledWith("enter");
    expect(diffArea().classList.contains("enter")).toBe(true);
  });
});

// Retry（Q-F）：按了焦點移到 #diff，讀取中與讀完都在那；再讀不到、焦點還在 #diff → 新的 Retry；
// 讀取中使用者把焦點移走了就不動
describe("DiffViewer: Retry", () => {
  const OID = "7".repeat(40);
  const ok: DiffResult = {
    truncated: false,
    files: [{ path: "a.ts", status: "Added", binary: false, too_large: false, omitted: null, hunks: [] }],
  };

  function deferred() {
    let resolve: (v: DiffResult) => void = () => {};
    let reject: (e: unknown) => void = () => {};
    const promise = new Promise<DiffResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function failFirst() {
    mockedGetDiff.mockRejectedValueOnce({ code: "GIT_ERROR" });
    resetStore(makeCommit(OID));
    const utils = view();
    await screen.findByRole("alert");
    return utils;
  }

  beforeEach(() => {
    mockedGetDiff.mockReset();
    resetStore(null);
  });
  afterEach(() => cleanup());

  it("test_diffViewer_retryWorks_focusStaysOnTheDiff", async () => {
    await failFirst();
    const again = deferred();
    mockedGetDiff.mockReturnValueOnce(again.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(document.activeElement).toBe(diffArea());
    expect(diffArea().querySelector(".skeleton")).not.toBeNull();
    await act(async () => again.resolve(ok));
    expect(dpaths()).toEqual(["a.ts"]);
    expect(document.activeElement).toBe(diffArea());
    expect(mockedGetDiff).toHaveBeenLastCalledWith(TEST_REPO_ID, OID);
  });

  it("test_diffViewer_retryFailsAgain_focusGoesToTheNewRetry", async () => {
    await failFirst();
    const again = deferred();
    mockedGetDiff.mockReturnValueOnce(again.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => again.reject({ code: "GIT_ERROR" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retry" }));
  });

  it("test_diffViewer_focusMovedAwayWhileReading_isLeftAlone", async () => {
    const { container } = await failFirst();
    const elsewhere = document.createElement("button");
    container.appendChild(elsewhere);
    const again = deferred();
    mockedGetDiff.mockReturnValueOnce(again.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    act(() => elsewhere.focus());
    await act(async () => again.reject({ code: "GIT_ERROR" }));
    expect(document.activeElement).toBe(elsewhere);
  });

  // 審查：成功那一路也一樣——讀取中把焦點移走，diff 畫出來時不搶回來
  it("test_diffViewer_focusMovedAwayWhileReading_staysAwayWhenItLoads", async () => {
    const { container } = await failFirst();
    const elsewhere = document.createElement("button");
    container.appendChild(elsewhere);
    const again = deferred();
    mockedGetDiff.mockReturnValueOnce(again.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    act(() => elsewhere.focus());
    await act(async () => again.resolve(ok));
    expect(dpaths()).toEqual(["a.ts"]);
    expect(document.activeElement).toBe(elsewhere);
  });
});

// 按住方向鍵（自動重複）時：小 diff 照樣即時預覽，大 diff 等放開（150ms 內沒有新的選取）才畫；
// 點選、按一下、開 repo、commit 後一律立即畫
describe("DiffViewer: a request the backend cancelled", () => {
  // 後端的閘只算「領到號碼」較新的那個；號碼在 task 第一次執行時才領，幾乎同時送出的兩個請求，
  // 目前的選取可能先領號、被較舊的取代而回 CANCELLED
  const cancelledError = { code: "CANCELLED", message: "operation cancelled" };
  const oneFile = (path: string): DiffResult => ({
    truncated: false,
    files: [
      {
        path,
        status: "Modified",
        binary: false,
        too_large: false,
        omitted: null,
        hunks: [
          {
            old_start: 1,
            old_lines: 0,
            new_start: 1,
            new_lines: 1,
            context: "",
            lines: [{ origin: "+", content: "x", old_lineno: null, new_lineno: 1 }],
          },
        ],
      },
    ],
  });

  beforeEach(() => {
    mockedGetDiff.mockReset();
    resetStore(null);
  });
  afterEach(() => cleanup());

  it("test_diffViewer_currentSelectionCancelled_isRequestedAgain", async () => {
    mockedGetDiff.mockRejectedValueOnce(cancelledError).mockResolvedValueOnce(oneFile("again.ts"));
    resetStore(makeCommit("1".repeat(40)));

    view();
    await waitFor(() => {
      expect(screen.getByText("again.ts")).toBeTruthy();
    });
    expect(mockedGetDiff).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Couldn't load this diff/)).toBeNull();
  });

  it("test_diffViewer_cancelledAgainAfterTheResend_isRequestedAgain", async () => {
    // 重送之後，另一個還沒領號的舊請求才領號 → 又被取代一次，仍要再送
    mockedGetDiff
      .mockRejectedValueOnce(cancelledError)
      .mockRejectedValueOnce(cancelledError)
      .mockResolvedValueOnce(oneFile("third.ts"));
    resetStore(makeCommit("5".repeat(40)));

    view();
    await waitFor(() => {
      expect(screen.getByText("third.ts")).toBeTruthy();
    });
    expect(mockedGetDiff).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/Couldn't load this diff/)).toBeNull();
  });

  it("test_diffViewer_cancelledEveryTime_givesUpAfterFiveResends", async () => {
    // 保險：一直回 CANCELLED（例如兩個地方互相取代）不會無限重送——第一次 + 重送 5 次之後顯示錯誤
    mockedGetDiff.mockRejectedValue(cancelledError);
    resetStore(makeCommit("2".repeat(40)));

    view();
    await waitFor(() => {
      expect(screen.getByText(/Couldn't load this diff/)).toBeTruthy();
    });
    expect(mockedGetDiff).toHaveBeenCalledTimes(6);
  });

  it("test_diffViewer_staleSelectionCancelled_isNotRequestedAgain", async () => {
    // 回歸保護：選取換掉之後才回來的 CANCELLED 是真的被取代，不重送
    let rejectFirst: (err: unknown) => void = () => {};
    mockedGetDiff
      .mockImplementationOnce(() => new Promise<DiffResult>((_, reject) => (rejectFirst = reject)))
      .mockResolvedValueOnce(oneFile("second.ts"));
    resetStore(makeCommit("3".repeat(40)));

    view();
    act(() => useGraphStore.getState().actions.setSelectedCommit(makeCommit("4".repeat(40))));
    await waitFor(() => {
      expect(screen.getByText("second.ts")).toBeTruthy();
    });
    await act(async () => rejectFirst(cancelledError));
    expect(mockedGetDiff).toHaveBeenCalledTimes(2);
  });
});

describe("DiffViewer: holding an arrow key", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);

  /** 一個檔、n 行、每行 `width` 個字元 */
  function linesDiff(path: string, n: number, width = 1): DiffResult {
    const lines = Array.from({ length: n }, (_, i) => ({
      origin: "+",
      content: "x".repeat(width),
      old_lineno: null,
      new_lineno: i + 1,
    }));
    return {
      truncated: false,
      files: [
        {
          path,
          status: "Modified",
          binary: false,
          too_large: false,
          omitted: null,
          hunks: [{ old_start: 1, old_lines: 0, new_start: 1, new_lines: n, context: "", lines }],
        },
      ],
    };
  }

  const select = (oid: string, fromRepeat: boolean) =>
    act(() => useGraphStore.getState().actions.setSelectedCommit(makeCommit(oid), fromRepeat));
  /** 讓 getDiff 的 promise 跑完（不推進 150ms 的等待） */
  const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  const shown = (path: string) => screen.queryByText(path) !== null;

  beforeEach(() => {
    vi.useFakeTimers();
    mockedGetDiff.mockReset();
    resetStore(null);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("test_diffViewer_autoRepeat_heavyDiff_waitsUntilTheKeyIsReleased", async () => {
    mockedGetDiff.mockResolvedValue(linesDiff("big.ts", 301));
    view();
    select(A, true);
    await settle();
    expect(shown("big.ts")).toBe(false);
    wait(149);
    expect(shown("big.ts")).toBe(false);
    wait(1);
    expect(shown("big.ts")).toBe(true);
  });

  it("test_diffViewer_autoRepeat_heavyDiffStillHeld_isNeverDrawn", async () => {
    mockedGetDiff.mockImplementation((_repo, oid) =>
      Promise.resolve(oid === A ? linesDiff("big.ts", 301) : linesDiff("small.ts", 10)),
    );
    view();
    select(A, true);
    await settle();
    expect(shown("big.ts")).toBe(false);
    wait(50);
    select(B, true); // 還按著：下一站來了
    await settle();
    expect(shown("small.ts")).toBe(true);
    wait(500);
    expect(shown("big.ts")).toBe(false);
  });

  it("test_diffViewer_autoRepeat_smallDiff_drawsRightAway", async () => {
    mockedGetDiff.mockResolvedValue(linesDiff("small.ts", 300));
    view();
    select(A, true);
    await settle();
    expect(shown("small.ts")).toBe(true);
  });

  it("test_diffViewer_autoRepeat_longLines_countAsHeavy", async () => {
    // 行數少但字元多（壓縮過的程式碼）：一行 32KB 就算大
    mockedGetDiff.mockResolvedValue(linesDiff("min.js", 1, 32 * 1024));
    view();
    select(A, true);
    await settle();
    expect(shown("min.js")).toBe(false);
    wait(150);
    expect(shown("min.js")).toBe(true);
  });

  it("test_diffViewer_click_heavyDiff_drawsRightAway", async () => {
    mockedGetDiff.mockResolvedValue(linesDiff("big.ts", 3000));
    view();
    select(A, false);
    await settle();
    expect(shown("big.ts")).toBe(true);
  });

  it("test_diffViewer_openRepoAfterHoldingAKey_drawsTheHeadRightAway", async () => {
    // 開 repo / commit 後是 adoptGraph 選 HEAD：前一次是按住方向鍵的選取也不影響
    mockedGetDiff.mockResolvedValue(linesDiff("big.ts", 3000));
    view();
    select(A, true);
    await settle();
    act(() => useGraphStore.getState().actions.setSelectedCommit(null));
    const head = makeCommit(B);
    act(() =>
      useGraphStore.getState().actions.adoptGraph(
        {
          commits: [head],
          branches: [],
          tags: [],
          truncated: false,
          head: { oid: B, branch: "main" },
          default_branch: null,
        },
        head,
      ),
    );
    await settle();
    expect(shown("big.ts")).toBe(true);
  });

  // Retry 是使用者按的：按住方向鍵選到、讀不到的那一站，按 Retry 之後大 diff 立即畫
  it("test_diffViewer_retryAfterAHeldKey_drawsRightAway", async () => {
    mockedGetDiff.mockRejectedValueOnce({ code: "GIT_ERROR" }).mockResolvedValueOnce(linesDiff("big.ts", 301));
    view();
    select(A, true);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(shown("big.ts")).toBe(true);
  });

  // 回歸保護：Retry 那一站還在讀的時候又按住方向鍵換到下一站，下一站的大 diff 照樣等放開
  it("test_diffViewer_heldKeyAfterARetry_stillWaits", async () => {
    mockedGetDiff
      .mockRejectedValueOnce({ code: "GIT_ERROR" })
      .mockImplementationOnce(() => new Promise<DiffResult>(() => {}))
      .mockResolvedValueOnce(linesDiff("next.ts", 301));
    view();
    select(A, true);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    select(B, true);
    await settle();
    expect(shown("next.ts")).toBe(false);
    wait(150);
    expect(shown("next.ts")).toBe(true);
  });

  // 回歸保護（審查）：X 讀不到 → Retry 還在讀 → 按住到 Y → Y 回來前按住回 X。這輪 Retry 在選取離開 X 時就結束，
  // 回到 X 的大 diff 照樣等放開（原本要等 Retry 的結果才清，但那個請求已被作廢、結果不會到，回到 X 被當成 Retry 立即畫）
  it("test_diffViewer_heldKeyBackToTheRetriedStation_stillWaits", async () => {
    mockedGetDiff
      .mockRejectedValueOnce({ code: "GIT_ERROR" })
      .mockImplementationOnce(() => new Promise<DiffResult>(() => {}))
      .mockImplementationOnce(() => new Promise<DiffResult>(() => {}))
      .mockResolvedValueOnce(linesDiff("big.ts", 301));
    view();
    select(A, true);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    select(B, true);
    await settle();
    select(A, true);
    await settle();
    expect(shown("big.ts")).toBe(false);
    wait(150);
    expect(shown("big.ts")).toBe(true);
  });

  // 審查：門檻算的是整個 diff 的行數，不是單檔——5 個檔各 70 行（350 行）也等放開
  it("test_diffViewer_autoRepeat_manyFilesOverTheLineThreshold_waits", async () => {
    const one = linesDiff("a.ts", 70).files[0];
    const files = Array.from({ length: 5 }, (_, i) => ({ ...one, path: `f${i}.ts` }));
    mockedGetDiff.mockResolvedValue({ truncated: false, files });
    view();
    select(A, true);
    await settle();
    expect(shown("f0.ts")).toBe(false);
    wait(150);
    expect(shown("f0.ts")).toBe(true);
  });

  it("test_diffViewer_unmountWhileWaiting_clearsTheTimer", async () => {
    mockedGetDiff.mockResolvedValue(linesDiff("big.ts", 301));
    const result = view();
    select(A, true);
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    result.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
