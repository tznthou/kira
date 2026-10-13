import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { CloneRepoModal } from "@/components/CloneRepo/CloneRepoModal";
import type {
  CloneDonePayload,
  CloneProgressPayload,
  RepoOpenResult,
} from "@/lib/tauri";

// Mock @/lib/tauri — keep types and helpers (mapCloneError /
// computeProgressPct from cloneProgress.ts) intact, replace only the
// IPC wrappers and getRepoInfo so tests can drive the flow without a
// running backend.
vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>(
    "@/lib/tauri",
  );
  return {
    ...actual,
    pickCloneDest: vi.fn(),
    cloneStart: vi.fn(),
    cloneCancel: vi.fn(),
    getRepoInfo: vi.fn(),
  };
});

// Capture every listen() handler attached by the hook so tests can emit
// events manually. Maps event-name → array of handlers (the hook attaches
// once per event per modal open, so usually 1 entry per name).
const listenHandlers = new Map<string, Array<(ev: { payload: unknown }) => void>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (ev: { payload: unknown }) => void) => {
    const arr = listenHandlers.get(name) ?? [];
    arr.push(cb);
    listenHandlers.set(name, arr);
    return Promise.resolve(() => {
      const current = listenHandlers.get(name) ?? [];
      listenHandlers.set(
        name,
        current.filter((h) => h !== cb),
      );
    });
  }),
}));

import {
  CLONE_DONE_EVENT,
  CLONE_PROGRESS_EVENT,
  cloneCancel,
  cloneStart,
  getRepoInfo,
  pickCloneDest,
  mapCloneError,
} from "@/lib/tauri";
import { computeProgressPct } from "@/lib/cloneProgress";

const mockedPick = vi.mocked(pickCloneDest);
const mockedStart = vi.mocked(cloneStart);
const mockedCancel = vi.mocked(cloneCancel);
const mockedGetInfo = vi.mocked(getRepoInfo);

// Push event to every active handler for `name`. Wrapped in act so React
// drains the resulting state updates before the test reads the DOM.
function emit(name: string, payload: unknown) {
  const handlers = listenHandlers.get(name) ?? [];
  act(() => {
    for (const h of handlers) h({ payload });
  });
}

// Deferred promise — gives a test explicit control over when the
// cloneStart promise resolves. Used to exercise the early-listener +
// buffer-by-clone_id replay path (done event arrives BEFORE start
// resolve).
function deferred<T>() {
  let resolveFn!: (v: T) => void;
  let rejectFn!: (e: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

// Drive the modal up to in-flight state with a known clone_id so each
// downstream test can focus on its specific transition.
async function openAndStart(
  url: string,
  destPath: string,
  cloneId: string,
  onClose = vi.fn(),
  onOpened: (r: RepoOpenResult) => void | Promise<void> = vi.fn(),
) {
  mockedPick.mockResolvedValueOnce({ dest: destPath });
  mockedStart.mockResolvedValueOnce({ clone_id: cloneId });

  const utils = render(
    <CloneRepoModal open onClose={onClose} onOpened={onOpened} />,
  );

  fireEvent.change(utils.getByPlaceholderText(/https:\/\/github\.com/i), {
    target: { value: url },
  });
  fireEvent.click(utils.getByRole("button", { name: /Choose folder/i }));
  await waitFor(() => expect(utils.queryByText(destPath)).not.toBeNull());
  fireEvent.click(utils.getByRole("button", { name: "Clone" }));
  await waitFor(() => expect(mockedStart).toHaveBeenCalled());

  return utils;
}

beforeEach(() => {
  listenHandlers.clear();
  mockedPick.mockReset();
  mockedStart.mockReset();
  mockedCancel.mockReset();
  mockedGetInfo.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CloneRepoModal — helpers", () => {
  it("test_mapCloneError_mapsCommonCodesToMessageAndHint", () => {
    expect(mapCloneError({ code: "INVALID_URL" }).hint).toMatch(/HTTPS/);
    expect(mapCloneError({ code: "INVALID_PATH" }).hint).toMatch(/5 min/);
    expect(mapCloneError({ code: "DEST_EXISTS" }).hint).toMatch(/empty/);
    expect(mapCloneError({ code: "CLONE_IN_PROGRESS" }).hint).toMatch(/cancel/i);
    expect(mapCloneError({ code: "CANCELLED" }).hint).toBeNull();
    expect(mapCloneError({ code: "INVALID_CLONE_ID" }).message).toMatch(/settled/);
    expect(mapCloneError("unknown shape").code).toBe("CLONE_FAILED");
  });

  it("test_computeProgressPct_appliesPhaseWeights", () => {
    // Receiving at 100% maps to ~80% of overall bar; CheckingOut at 100%
    // pushes to 100%; 0/0 returns null for indeterminate.
    const receivingDone: CloneProgressPayload = {
      clone_id: "A",
      phase: "Receiving",
      current: 100,
      total: 100,
      bytes: 0,
    };
    expect(computeProgressPct(receivingDone)).toBeCloseTo(0.8, 5);

    const checkingOutDone: CloneProgressPayload = {
      clone_id: "A",
      phase: "CheckingOut",
      current: 50,
      total: 50,
      bytes: 0,
    };
    expect(computeProgressPct(checkingOutDone)).toBeCloseTo(1.0, 5);

    const zeroOverZero: CloneProgressPayload = {
      clone_id: "A",
      phase: "Receiving",
      current: 0,
      total: 0,
      bytes: 0,
    };
    expect(computeProgressPct(zeroOverZero)).toBeNull();
  });
});

describe("CloneRepoModal — flow integration", () => {
  it("test_clone_progressEvent_updatesBar", async () => {
    const utils = await openAndStart(
      "https://github.com/o/r.git",
      "/tmp/dest",
      "abc",
    );

    const payload: CloneProgressPayload = {
      clone_id: "abc",
      phase: "Receiving",
      current: 50,
      total: 100,
      bytes: 1024,
    };
    emit(CLONE_PROGRESS_EVENT, payload);

    await waitFor(() => {
      const bar = utils.getByRole("progressbar");
      // 50% of Receiving phase = 40% overall (0.5 * 0.8)
      expect(bar.getAttribute("aria-valuenow")).toBe("40");
    });
  });

  it("test_clone_doneOk_callsOnOpenedAndShowsOpeningState", async () => {
    const onOpened = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mockedGetInfo.mockResolvedValue({
      path: "/tmp/dest",
      head_branch: "main",
      branches: [],
      remotes: [],
    });

    const utils = await openAndStart(
      "https://github.com/o/r.git",
      "/tmp/dest",
      "okid",
      onClose,
      onOpened,
    );

    const done: CloneDonePayload = {
      clone_id: "okid",
      kind: "Ok",
      data: { path: "/tmp/dest", repo_id: "RID" },
    };
    emit(CLONE_DONE_EVENT, done);

    await waitFor(() => {
      expect(mockedGetInfo).toHaveBeenCalledWith("RID");
      expect(onOpened).toHaveBeenCalledWith({
        repo_id: "RID",
        info: expect.objectContaining({ path: "/tmp/dest" }),
      });
    });
    // While opening, the close button is disabled (race guard)
    expect(
      (utils.getByRole("button", { name: /Close/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("test_pickDest_invokesRustPicker", async () => {
    mockedPick.mockResolvedValue({ dest: "/picked/dest" });
    const utils = render(
      <CloneRepoModal open onClose={vi.fn()} onOpened={vi.fn()} />,
    );
    fireEvent.click(utils.getByRole("button", { name: /Choose folder/i }));
    await waitFor(() => expect(mockedPick).toHaveBeenCalled());
    expect(utils.queryByText("/picked/dest")).not.toBeNull();
  });

  it("test_doneErr_showsMessageAndHint", async () => {
    await openAndStart("https://github.com/o/r.git", "/tmp/d", "errid");

    const done: CloneDonePayload = {
      clone_id: "errid",
      kind: "Err",
      data: {
        code: "NETWORK_ERROR",
        message: "network operation failed",
        hint: "Check connectivity / firewall.",
      },
    };
    emit(CLONE_DONE_EVENT, done);

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/network operation failed/);
      expect(document.body.textContent).toMatch(/Check connectivity/);
    });
  });

  it("test_cancel_settlesOnAnyTerminalDone_evenAsNetworkError", async () => {
    mockedCancel.mockResolvedValue({ cancelled: true });
    const utils = await openAndStart(
      "https://github.com/o/r.git",
      "/tmp/d",
      "canid",
    );

    fireEvent.click(utils.getByRole("button", { name: /Cancel clone/i }));
    await waitFor(() => expect(mockedCancel).toHaveBeenCalledWith("canid"));

    // Backend chose to emit NETWORK_ERROR instead of CANCELLED (DNS/TLS
    // stage cancel). The state machine must still settle.
    const done: CloneDonePayload = {
      clone_id: "canid",
      kind: "Err",
      data: { code: "NETWORK_ERROR", message: "network failed", hint: null },
    };
    emit(CLONE_DONE_EVENT, done);

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/network failed/);
    });
  });

  it("test_listenAttachedBeforeStartInvoke", async () => {
    mockedPick.mockResolvedValue({ dest: "/tmp/d" });
    mockedStart.mockImplementation(() => {
      // At the moment cloneStart is invoked, both listeners must already
      // be attached to avoid early-done race.
      expect(listenHandlers.get(CLONE_PROGRESS_EVENT)?.length).toBeGreaterThan(0);
      expect(listenHandlers.get(CLONE_DONE_EVENT)?.length).toBeGreaterThan(0);
      return Promise.resolve({ clone_id: "ok" });
    });

    const utils = render(
      <CloneRepoModal open onClose={vi.fn()} onOpened={vi.fn()} />,
    );
    fireEvent.change(utils.getByPlaceholderText(/https:\/\/github\.com/i), {
      target: { value: "https://github.com/o/r.git" },
    });
    fireEvent.click(utils.getByRole("button", { name: /Choose folder/i }));
    await waitFor(() => expect(utils.queryByText("/tmp/d")).not.toBeNull());
    fireEvent.click(utils.getByRole("button", { name: "Clone" }));
    await waitFor(() => expect(mockedStart).toHaveBeenCalled());
  });

  it("test_doneArrivesBeforeStartResolves_buffersAndReplays", async () => {
    mockedPick.mockResolvedValue({ dest: "/tmp/d" });
    const startDeferred = deferred<{ clone_id: string }>();
    mockedStart.mockReturnValueOnce(startDeferred.promise);

    const utils = render(
      <CloneRepoModal open onClose={vi.fn()} onOpened={vi.fn()} />,
    );
    fireEvent.change(utils.getByPlaceholderText(/https:\/\/github\.com/i), {
      target: { value: "https://github.com/o/r.git" },
    });
    fireEvent.click(utils.getByRole("button", { name: /Choose folder/i }));
    await waitFor(() => expect(utils.queryByText("/tmp/d")).not.toBeNull());
    fireEvent.click(utils.getByRole("button", { name: "Clone" }));
    await waitFor(() => expect(mockedStart).toHaveBeenCalled());

    // Done event arrives BEFORE cloneStart promise resolves — must be
    // buffered and replayed once cloneIdRef is set.
    const done: CloneDonePayload = {
      clone_id: "race",
      kind: "Err",
      data: { code: "NETWORK_ERROR", message: "early fail", hint: null },
    };
    emit(CLONE_DONE_EVENT, done);
    // State should still be 'starting' (UI: "Connecting...") because
    // cloneIdRef is null and event went into buffer.
    expect(document.body.textContent).toMatch(/Connecting/);

    // Now resolve the start promise with the matching clone_id; the
    // buffered done event should replay and surface the error.
    await act(async () => {
      startDeferred.resolve({ clone_id: "race" });
      await startDeferred.promise;
    });
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/early fail/);
    });
  });

  it("test_syncReject_dropsToDoneErr", async () => {
    mockedPick.mockResolvedValue({ dest: "/tmp/d" });
    mockedStart.mockRejectedValueOnce({
      code: "DEST_EXISTS",
      message: "destination already exists",
    });

    const utils = render(
      <CloneRepoModal open onClose={vi.fn()} onOpened={vi.fn()} />,
    );
    fireEvent.change(utils.getByPlaceholderText(/https:\/\/github\.com/i), {
      target: { value: "https://github.com/o/r.git" },
    });
    fireEvent.click(utils.getByRole("button", { name: /Choose folder/i }));
    await waitFor(() => expect(utils.queryByText("/tmp/d")).not.toBeNull());
    fireEvent.click(utils.getByRole("button", { name: "Clone" }));

    await waitFor(() => {
      expect(document.body.textContent).toMatch(/not empty/);
      expect(document.body.textContent).toMatch(/empty directory/);
    });
  });

  it("test_cancelReturnsInvalidCloneId_swallowsErrorAndWaitsForDone", async () => {
    mockedCancel.mockRejectedValueOnce({
      code: "INVALID_CLONE_ID",
      message: "invalid clone id",
    });
    const utils = await openAndStart(
      "https://github.com/o/r.git",
      "/tmp/d",
      "settled",
    );

    fireEvent.click(utils.getByRole("button", { name: /Cancel clone/i }));
    // Should swallow the INVALID_CLONE_ID, stay in cancelling, and not
    // surface an error message to the user.
    await waitFor(() => expect(mockedCancel).toHaveBeenCalled());
    expect(document.body.textContent).toMatch(/Cancelling/);

    // The matching clone:done arrives shortly after (the SPEC guarantees
    // it must have been or is about to be emitted).
    const done: CloneDonePayload = {
      clone_id: "settled",
      kind: "Ok",
      data: { path: "/tmp/d", repo_id: "RID2" },
    };
    mockedGetInfo.mockResolvedValueOnce({
      path: "/tmp/d",
      head_branch: "main",
      branches: [],
      remotes: [],
    });
    emit(CLONE_DONE_EVENT, done);
    await waitFor(() => {
      // race-success after cancel is still a success — opens the repo
      expect(mockedGetInfo).toHaveBeenCalledWith("RID2");
    });
  });

  it("test_progressZeroOverZero_rendersIndeterminateBar", async () => {
    const utils = await openAndStart(
      "https://github.com/o/r.git",
      "/tmp/d",
      "indet",
    );
    emit(CLONE_PROGRESS_EVENT, {
      clone_id: "indet",
      phase: "Receiving",
      current: 0,
      total: 0,
      bytes: 0,
    });
    await waitFor(() => {
      const bar = utils.getByRole("progressbar");
      // No aria-valuenow attribute when indeterminate
      expect(bar.getAttribute("aria-valuenow")).toBeNull();
    });
  });

  it("test_reopenModal_ignoresOldClonePayloads", async () => {
    const onClose = vi.fn();
    const utils = await openAndStart(
      "https://github.com/o/r.git",
      "/tmp/d",
      "session1",
      onClose,
    );

    // First session: receive Err to settle into done-err
    emit(CLONE_DONE_EVENT, {
      clone_id: "session1",
      kind: "Err",
      data: { code: "CANCELLED", message: "operation cancelled", hint: null },
    });
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/cancelled/i);
    });

    // Close + reopen modal — new session, prior cloneIdRef invalidated
    utils.rerender(
      <CloneRepoModal open={false} onClose={onClose} onOpened={vi.fn()} />,
    );
    utils.rerender(
      <CloneRepoModal open={true} onClose={onClose} onOpened={vi.fn()} />,
    );

    // Now a stale event from session1 arrives — must be ignored. UI
    // should remain at the fresh idle form.
    emit(CLONE_DONE_EVENT, {
      clone_id: "session1",
      kind: "Err",
      data: { code: "CANCELLED", message: "stale", hint: null },
    });
    // After rerender + reset, the URL input is back to empty and no
    // error banner from the stale payload.
    expect(document.body.textContent).not.toMatch(/stale/);
  });

  it("test_openingState_guardsAgainstCancelAndCloseOverride", async () => {
    const onOpened = vi.fn(
      () => new Promise<void>(() => undefined /* never resolves */),
    );
    mockedGetInfo.mockResolvedValue({
      path: "/tmp/d",
      head_branch: "main",
      branches: [],
      remotes: [],
    });

    const utils = await openAndStart(
      "https://github.com/o/r.git",
      "/tmp/d",
      "openid",
      vi.fn(),
      onOpened,
    );

    emit(CLONE_DONE_EVENT, {
      clone_id: "openid",
      kind: "Ok",
      data: { path: "/tmp/d", repo_id: "RID3" },
    });
    // Wait for opening state — getRepoInfo resolved, onOpened hangs.
    await waitFor(() => {
      expect(onOpened).toHaveBeenCalled();
    });

    // While opening, Close button is disabled (race guard)
    expect(
      (utils.getByRole("button", { name: /Close/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // Stale done event in opening state must NOT override the opening flow
    emit(CLONE_DONE_EVENT, {
      clone_id: "openid",
      kind: "Err",
      data: { code: "NETWORK_ERROR", message: "late fail", hint: null },
    });
    // UI should still show "Opening repository..." and not the stale Err
    expect(document.body.textContent).toMatch(/Opening repository/);
    expect(document.body.textContent).not.toMatch(/late fail/);
  });
});
