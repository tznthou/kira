import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CLONE_DONE_EVENT,
  CLONE_PROGRESS_EVENT,
  cloneCancel,
  cloneStart,
  getRepoInfo,
  mapCloneError,
  type CloneDonePayload,
  type CloneProgressPayload,
  type RepoOpenResult,
} from "@/lib/tauri";

// State machine — 6 階段（plan v3 Section 5）：
//
//   idle           User 輸入 URL/dest，尚未送 IPC。
//   starting       已呼 cloneStart()，等 Promise resolve/reject。close 需先
//                  set closeRequestedRef，resolve 後立刻 cancel；不能直接
//                  unmount，否則背景 clone 會持續跑但沒人接 done。
//   in-flight      clone_id 已拿到，listener 開始 dispatch progress/done。
//   cancelling     已呼 cloneCancel()，等任何 terminal done 即 settle（不嚴
//                  格等 CANCELLED — DNS/TLS 階段 cancel 可能變 NETWORK_ERROR；
//                  race 成功也可能變 Ok）。
//   opening        done.Ok 收到後到 applyOpenResult 完成中間的視窗 —
//                  禁止 cancel / close 覆蓋，避免成功 clone 被 race window
//                  中途取消。Commit 4 才接 actual flow。
//   done-err       終結錯誤狀態。Modal 展示 message + hint + retry/close。
export type CloneFlowState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "in-flight"; clone_id: string; progress: CloneProgressPayload | null }
  | { kind: "cancelling"; clone_id: string }
  | { kind: "opening"; path: string; repo_id: string }
  | { kind: "done-err"; code: string; message: string; hint: string | null };

export interface UseCloneFlowOptions {
  open: boolean;
  // Funnel for the success path: hook calls onOpened after getRepoInfo
  // resolves so App-level applyOpenResult can wire repoStore /
  // graphStore / recent mirror in one place. Caller closes the modal
  // after onOpened.
  onOpened: (result: RepoOpenResult) => void | Promise<void>;
}

export interface UseCloneFlowResult {
  state: CloneFlowState;
  start: (url: string, dest: string) => void;
  // Explicit cancel button — drops into `cancelling`, swallows
  // INVALID_CLONE_ID (settled clone_id is harmless), and settles on
  // any terminal done (not strictly CANCELLED — DNS/TLS-stage cancel
  // can surface as NETWORK_ERROR; race-success can surface as Ok).
  cancel: () => void;
  // ESC / X-button close intent. Returns nothing — the caller watches
  // `canCloseNow` and only flips its own modal-open flag when this
  // hook reports it's safe to unmount.
  requestClose: () => void;
  // True when the parent is allowed to unmount the modal without
  // orphaning a background clone or stomping an in-flight open flow.
  canCloseNow: boolean;
  reset: () => void;
}

// 既有工具列（Topbar/Toolbar）的 pattern 是 useEffect + listen + cancelled flag。本 hook
// 額外加：
//   1. Listener attach 在 invoke cloneStart **之前** — backend spawn_blocking
//      後立刻返 clone_id，極快失敗 case `clone:done` 可能在 cloneStart
//      Promise resolve 前抵達；如果先 invoke 再 attach，terminal event 直接
//      被丟掉。
//   2. Buffer-by-clone_id replay — listener attach 後但 cloneIdRef.current
//      還是 null 的視窗內，event 進 Map<clone_id, events[]>；start resolve
//      後設 cloneIdRef.current 並 replay 該 clone_id 的緩存。
//   3. 所有 mutable state 走 useRef — listener closure 內讀 useState 永遠
//      是掛載當下舊值。
//
// `open` 決定 listener lifecycle：modal open 時掛上，close 時 cleanup。重開
// modal 視為新 session — reset state 並 bump cloneIdRef.current 失效 stale
// listener payload，避免 reopen modal 看到上一輪的 in-flight 殘留。
export function useCloneFlow({ open, onOpened }: UseCloneFlowOptions): UseCloneFlowResult {
  const [state, setState] = useState<CloneFlowState>({ kind: "idle" });

  // Mirror onOpened in a ref so the listener closure always calls the
  // latest callback without re-attaching the listener on every render.
  const onOpenedRef = useRef(onOpened);
  useEffect(() => {
    onOpenedRef.current = onOpened;
  }, [onOpened]);

  // 所有 listener / async settle 路徑讀寫的 mutable state 都用 ref：
  //   cloneIdRef            目前持有的 clone_id；null = 還沒 start 或已 reset
  //   bufferRef             Map<clone_id, (Progress | Done)[]> — pre-clone_id
  //                         抵達的事件緩存，等 cloneIdRef 設好就 replay
  //   stateRef              鏡像 state，listener 內判斷分支用（state 是
  //                         useState 不能在 closure 內讀新值）
  const cloneIdRef = useRef<string | null>(null);
  const bufferRef = useRef<
    Map<string, Array<{ type: "progress"; payload: CloneProgressPayload } | { type: "done"; payload: CloneDonePayload }>>
  >(new Map());
  const stateRef = useRef<CloneFlowState>(state);
  // closeRequestedRef — close 在 `starting` 階段（cloneStart promise 還沒
  // resolve）時無法 cancel（沒 clone_id），記錄意圖，start resolve 後立即
  // cancel；reject 路徑 done-err 自然滿足 canCloseNow。
  const closeRequestedRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Reset all listener-side refs to "fresh session" defaults. Called from
  // the modal-close cleanup effect, retry-after-done-err in start(), and
  // the public reset(). Does NOT touch state — callers setState as needed.
  const resetSessionRefs = useCallback(() => {
    cloneIdRef.current = null;
    bufferRef.current = new Map();
    closeRequestedRef.current = false;
  }, []);

  // Listener event handler — commit 2 只做 dispatch 框架 + buffer replay；
  // weighted progress + opening flow + cancel settle 邏輯由 commit 3-5 補。
  // Progress only updates UI while in-flight; during cancelling we drop
  // updates so the "Cancelling..." status line doesn't flap.
  const handleProgress = useCallback((payload: CloneProgressPayload) => {
    const current = stateRef.current;
    if (current.kind !== "in-flight") return;
    if (payload.clone_id !== cloneIdRef.current) return;
    setState({
      kind: "in-flight",
      clone_id: payload.clone_id,
      progress: payload,
    });
  }, []);

  const handleDone = useCallback((payload: CloneDonePayload) => {
    if (payload.clone_id !== cloneIdRef.current) return;
    const current = stateRef.current;
    // opening race guard — done event 在 opening state 之後抵達（重複 emit
    // 或晚到）不可覆蓋 opening flow（commit 4 才會進入 opening 狀態）。
    if (current.kind === "opening") return;

    if (payload.kind === "Ok") {
      // Enter `opening` immediately so any further cancel/close attempts
      // bail (handled in commit 5). Backend already wrote recent_repos
      // in open_cloned_repo, but we still need to load fresh RepoInfo
      // for the App-level funnel — getRepoInfo is the canonical re-read
      // helper used elsewhere (App.tsx refreshRepoInfo path).
      const { path, repo_id } = payload.data;
      setState({ kind: "opening", path, repo_id });
      void (async () => {
        try {
          const info = await getRepoInfo(repo_id);
          await onOpenedRef.current({ repo_id, info });
          // Caller is expected to close the modal after onOpened resolves;
          // that flips `open` to false and the cleanup effect resets state.
          // We do NOT setState(idle) here — leaving 'opening' lets the UI
          // keep showing "Opening repository..." until the parent unmounts
          // the modal, avoiding a flash of idle form between flows.
        } catch (err) {
          // getRepoInfo failure or onOpened throwing — repo was cloned to
          // disk (libgit2 done Ok), just couldn't be opened. Tell the user
          // the path so they can open it manually via the picker afterward.
          console.error("[kira] clone Ok but open flow failed:", err);
          setState({
            kind: "done-err",
            code: "CLONE_FAILED",
            message: "Repository cloned, but failed to load it.",
            hint: `Open it manually from: ${path}`,
          });
        }
      })();
      return;
    }
    setState({
      kind: "done-err",
      code: payload.data.code,
      message: payload.data.message,
      hint: payload.data.hint,
    });
  }, []);

  // Single source of truth for routing an incoming event：cloneIdRef 是否已
  // 設定。沒設 → 進 buffer；已設且 clone_id 對應 → 直接 dispatch。
  const routeEvent = useCallback(
    (
      ev:
        | { type: "progress"; payload: CloneProgressPayload }
        | { type: "done"; payload: CloneDonePayload },
    ) => {
      if (cloneIdRef.current === null) {
        const eventCloneId = ev.payload.clone_id;
        const existing = bufferRef.current.get(eventCloneId) ?? [];
        existing.push(ev);
        bufferRef.current.set(eventCloneId, existing);
        return;
      }
      if (ev.type === "progress") handleProgress(ev.payload);
      else handleDone(ev.payload);
    },
    [handleProgress, handleDone],
  );

  // Listener attach — 同工具列（Topbar/Toolbar）的 pattern：cancelled flag 守 listen Promise
  // race（unmount 在 listen.then 之前 resolve 時必 cleanup unlisten）。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let unlistenProgress: UnlistenFn | undefined;
    let unlistenDone: UnlistenFn | undefined;

    listen<CloneProgressPayload>(CLONE_PROGRESS_EVENT, (event) => {
      routeEvent({ type: "progress", payload: event.payload });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenProgress = fn;
      })
      .catch((err) => {
        console.error("[kira] failed to listen clone:progress:", err);
      });

    listen<CloneDonePayload>(CLONE_DONE_EVENT, (event) => {
      routeEvent({ type: "done", payload: event.payload });
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenDone = fn;
      })
      .catch((err) => {
        console.error("[kira] failed to listen clone:done:", err);
      });

    return () => {
      cancelled = true;
      unlistenProgress?.();
      unlistenDone?.();
    };
  }, [open, routeEvent]);

  // Reset listener state when modal closes — re-opening modal is a new
  // clone session, prior cloneIdRef must not match incoming events.
  // Parent is expected to gate setOpen(false) on canCloseNow so the reset
  // never strands a live backend clone (commit 6/7 wire this in the UI).
  useEffect(() => {
    if (!open) {
      resetSessionRefs();
      setState({ kind: "idle" });
    }
  }, [open, resetSessionRefs]);

  // triggerCancel — invoke backend cancel; INVALID_CLONE_ID is settle
  // signal (clone already finished + removed from CloneRegistry), swallow
  // it and trust the upcoming/received clone:done event to drive state.
  // Other errors fall through to the existing done-err handler.
  const triggerCancel = useCallback(async (cloneId: string) => {
    try {
      await cloneCancel(cloneId);
    } catch (err) {
      const ui = mapCloneError(err);
      if (ui.code === "INVALID_CLONE_ID") {
        // settled — wait for the done event we must have received or are
        // about to receive (SPEC.md `git_clone_cancel` Note + Codex
        // finding #5).
        return;
      }
      // any other error during cancel is unusual; surface to UI but don't
      // crash the state machine — clone:done will still arrive eventually.
      console.error("[kira] clone_cancel failed:", ui.code);
    }
  }, []);

  const cancel = useCallback(() => {
    const current = stateRef.current;
    if (current.kind === "in-flight") {
      setState({ kind: "cancelling", clone_id: current.clone_id });
      void triggerCancel(current.clone_id);
      return;
    }
    // opening / starting / cancelling / idle / done-err — explicit cancel
    // is a no-op (opening guards success flow; starting has no clone_id;
    // cancelling already requested; idle/done-err have nothing to cancel).
  }, [triggerCancel]);

  const requestClose = useCallback(() => {
    const current = stateRef.current;
    if (current.kind === "opening") {
      // race guard — never close while applyOpenResult is in progress
      return;
    }
    if (current.kind === "starting") {
      // cloneStart promise still in flight; defer the cancel until we
      // know clone_id. Reject path naturally satisfies canCloseNow.
      closeRequestedRef.current = true;
      return;
    }
    if (current.kind === "in-flight") {
      setState({ kind: "cancelling", clone_id: current.clone_id });
      void triggerCancel(current.clone_id);
      return;
    }
    // cancelling — cancel already in flight, parent should wait for
    // canCloseNow to flip via the upcoming terminal done. idle / done-err
    // are already closeable (canCloseNow=true) so parent's onClose handler
    // can just unmount; nothing for us to do here.
  }, [triggerCancel]);

  const start = useCallback((url: string, dest: string) => {
    if (stateRef.current.kind !== "idle" && stateRef.current.kind !== "done-err") {
      return; // 防誤觸 — UI 也會 disable Start button，但 hook 自己也守
    }
    // Retry after done-err must land in the same "early listener + buffer
    // replay" path as a first attempt. Without clearing the prior session's
    // refs, routeEvent would dispatch new clone_id events through the live
    // handlers but cloneIdRef.current still holds the old id — the events
    // get matched against the wrong id and dropped (Codex review finding).
    resetSessionRefs();
    setState({ kind: "starting" });

    void (async () => {
      try {
        const result = await cloneStart(url, dest);
        cloneIdRef.current = result.clone_id;
        setState({
          kind: "in-flight",
          clone_id: result.clone_id,
          progress: null,
        });
        // Replay buffered events for this clone_id。
        // 取出 buffer + 清空後 dispatch，避免 replay 過程中 listener 再寫入
        // 同個 key 造成 dup（cloneIdRef 已設，後續 event 走直接 dispatch）。
        const buffered = bufferRef.current.get(result.clone_id);
        let replayedTerminal = false;
        if (buffered) {
          bufferRef.current.delete(result.clone_id);
          for (const ev of buffered) {
            if (ev.type === "progress") {
              handleProgress(ev.payload);
            } else {
              handleDone(ev.payload);
              // done event drives state into opening or done-err — both are
              // terminal-ish; deferred cancel below must not overwrite.
              replayedTerminal = true;
            }
          }
        }
        // closeRequestedRef set 過 → 立即觸發 cancel（user 在 starting 階段
        // 按了 close，當時沒 clone_id 無法 cancel，現在補上）。
        // 例外：buffer 已 replay terminal event 時跳過 — 否則 setState
        // cancelling 覆蓋剛入的 done-err / opening 狀態，後續 triggerCancel
        // 對 settled clone_id 拿 INVALID_CLONE_ID swallow，UI 永遠等不到
        // 下一個 done（Codex 審查發現）。
        const pendingClose = closeRequestedRef.current;
        closeRequestedRef.current = false;
        if (pendingClose && !replayedTerminal) {
          setState({ kind: "cancelling", clone_id: result.clone_id });
          void triggerCancel(result.clone_id);
        }
      } catch (err) {
        // Sync reject — INVALID_URL / INVALID_PATH / DEST_EXISTS /
        // CLONE_IN_PROGRESS / INSUFFICIENT_DISK_SPACE 不會發 clone:done，
        // 必須在這條路徑 settle 進 done-err。
        // closeRequestedRef set 過也由 done-err 自然滿足 canCloseNow。
        closeRequestedRef.current = false;
        const ui = mapCloneError(err);
        setState({
          kind: "done-err",
          code: ui.code,
          message: ui.message,
          hint: ui.hint,
        });
      }
    })();
  }, [handleProgress, handleDone, triggerCancel, resetSessionRefs]);

  const reset = useCallback(() => {
    resetSessionRefs();
    setState({ kind: "idle" });
  }, [resetSessionRefs]);

  // True only when no IPC promise / backend handle / applyOpenResult is
  // in flight — parent must gate setOpen(false) on this to avoid orphans.
  const canCloseNow = state.kind === "idle" || state.kind === "done-err";

  return { state, start, cancel, requestClose, canCloseNow, reset };
}
