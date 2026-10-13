import { render, act, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneTabs } from "@/components/PaneTabs/PaneTabs";
import { StagingArea } from "@/components/StagingArea/StagingArea";
import { useRepoStore } from "@/stores/repoStore";
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

import { getStatus } from "@/lib/tauri";

const mockedGetStatus = vi.mocked(getStatus);

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
const CLEAN: WorkingTreeStatus = { staged: [], unstaged: [], conflicted: [], unstaged_truncated: false };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Changes 讀不到（Q-S）與 Retry 的焦點（Q-F，Phase 5 5c step 4）：Retry 之後焦點移到 Changes 那一格（#panel-changes），
// 讀取中與讀完都在那；再失敗且焦點還在 → 新的 Retry；讀取中使用者把焦點移走了就不動
describe("Changes: a status that cannot be read, and the focus after Retry", () => {
  const renderPane = () => render(<PaneTabs changes={<StagingArea repoId={REPO} />} prs={<div />} />);
  const retryButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>("#changes-retry");

  beforeEach(() => {
    mockedGetStatus.mockReset();
    // status 的三個序號與 refresh 的來源一起歸零（同 changesPane）：漏掉的話上一條測試的寫入序會讓這一條的重讀被丟掉
    // （打亂順序時 readsAgain_focusStaysInThePane 紅）
    useRepoStore.setState({
      repoId: REPO,
      workingTreeStatus: null,
      statusError: true,
      statusRequestId: 0,
      statusWrittenId: 0,
      statusUserPendingId: null,
      refreshSource: null,
      commitLoading: false,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("test_changes_readError_saysSoWithRetry_commitDisabled", () => {
    const { container, getByRole } = renderPane();
    expect(getByRole("alert").textContent).toContain("Couldn't read your changes.");
    expect(retryButton(container)).not.toBeNull();
    expect(container.querySelector("#stage-lists")?.hasAttribute("hidden")).toBe(true);
    expect((getByRole("button", { name: "Commit" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("test_changes_retry_readsAgain_focusStaysInThePane", async () => {
    mockedGetStatus.mockResolvedValue(CLEAN);
    const { container } = renderPane();
    act(() => retryButton(container)!.focus());
    await act(async () => {
      retryButton(container)!.click();
    });
    await waitFor(() => expect(useRepoStore.getState().workingTreeStatus).toEqual(CLEAN));
    expect(mockedGetStatus).toHaveBeenCalledWith(REPO);
    expect(retryButton(container)).toBeNull();
    expect(document.activeElement).toBe(container.querySelector("#panel-changes"));
  });

  it("test_changes_retryFailsAgain_focusGoesToTheNewRetry", async () => {
    mockedGetStatus.mockRejectedValue(new Error("boom"));
    const { container } = renderPane();
    await act(async () => {
      retryButton(container)!.click();
    });
    await waitFor(() => expect(document.activeElement?.id).toBe("changes-retry"));
  });

  it("test_changes_retry_focusMovedAwayWhileReading_isLeftAlone", async () => {
    const read = deferred<WorkingTreeStatus>();
    mockedGetStatus.mockReturnValue(read.promise);
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    const { container } = renderPane();
    act(() => retryButton(container)!.click());
    act(() => elsewhere.focus());
    await act(async () => {
      read.reject(new Error("boom"));
      await read.promise.catch(() => undefined);
    });
    await waitFor(() => expect(retryButton(container)).not.toBeNull());
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
