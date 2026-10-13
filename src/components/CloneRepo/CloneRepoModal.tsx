import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pickCloneDest, type RepoOpenResult } from "@/lib/tauri";
import {
  computeProgressPct,
  formatProgressStatus,
} from "@/lib/cloneProgress";
import { useCloneFlow } from "@/hooks/useCloneFlow";
import { Button } from "@/components/ui/Button";
import { TitleBarDragStrip } from "@/components/ui/TitleBarDragStrip";

// Focus-trap selector mirrors BranchList/dialogs.tsx — exclude tabindex=-1
// so the overlay dismiss button doesn't get into the cycle.
function getFocusables(container: HTMLElement): HTMLElement[] {
  const sel =
    'button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
    'textarea:not([disabled]),[href],[tabindex]';
  return Array.from(container.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => el.tabIndex !== -1,
  );
}

export interface CloneRepoModalProps {
  open: boolean;
  onClose: () => void;
  onOpened: (result: RepoOpenResult) => void | Promise<void>;
}

export function CloneRepoModal({ open, onClose, onOpened }: CloneRepoModalProps) {
  const { state, start, cancel, requestClose, canCloseNow } = useCloneFlow({
    open,
    onOpened,
  });

  const [url, setUrl] = useState("");
  const [dest, setDest] = useState<string | null>(null);
  // closeIntent + canCloseNow 雙態同步：UI 按 X / ESC / scrim 設 intent，
  // 等 hook state machine 走到安全狀態 (idle / done-err) 才真正觸發 parent
  // unmount。避免在 cancelling/opening 等狀態下強制關閉 modal 把背景 clone
  // 變成 orphaned。
  const [closeIntent, setCloseIntent] = useState(false);

  // isPickingDestRef — picker 期間 (Rust OS dialog blocking) ESC handler
  // 必須失效，否則 user 按 ESC 取消 OS dialog 順手把 modal 也關掉。
  const isPickingDestRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Reset form when modal opens — re-opening should always start blank,
  // dest from previous session is invalidated by backend lock 5min TTL
  // anyway.
  useEffect(() => {
    if (open) {
      setUrl("");
      setDest(null);
      setCloseIntent(false);
    }
  }, [open]);

  // Bridge close intent into actual parent unmount only when canCloseNow
  // flips true. Effect dependency ensures we re-evaluate whenever the
  // hook's state machine settles.
  useEffect(() => {
    if (open && closeIntent && canCloseNow) {
      setCloseIntent(false);
      onClose();
    }
  }, [open, closeIntent, canCloseNow, onClose]);

  const handleCloseRequest = useCallback(() => {
    setCloseIntent(true);
    requestClose();
  }, [requestClose]);

  // Restore focus to whatever had it before the modal opened (a11y standard)
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    // Defer one microtask so the URL input autoFocus wins; only fall back
    // to first focusable if nothing inside grabbed focus.
    queueMicrotask(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (!dialog.contains(document.activeElement)) {
        if (urlInputRef.current) {
          urlInputRef.current.focus();
        } else {
          getFocusables(dialog)[0]?.focus();
        }
      }
    });
    return () => {
      previousFocus?.focus?.();
    };
  }, [open]);

  // Keyboard handlers: ESC closes (unless picker active), Tab cycles focus.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // isPickingDestRef guard — OS folder picker has its own ESC; don't
        // double-fire.
        if (isPickingDestRef.current) return;
        handleCloseRequest();
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = getFocusables(dialog);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, handleCloseRequest]);

  const handlePickDest = useCallback(async () => {
    isPickingDestRef.current = true;
    try {
      const result = await pickCloneDest();
      if (result) setDest(result.dest);
    } catch (err) {
      console.error("[kira] pick clone dest failed:", err);
    } finally {
      isPickingDestRef.current = false;
    }
  }, []);

  const trimmedUrl = url.trim();
  const canStart =
    (state.kind === "idle" || state.kind === "done-err") &&
    trimmedUrl.length > 0 &&
    dest !== null;

  const handleStart = useCallback(() => {
    // canStart already enforces dest !== null; the explicit null-check
    // here narrows TS so we can pass `dest` to start() without `!`.
    if (!canStart || dest === null) return;
    start(trimmedUrl, dest);
  }, [canStart, dest, start, trimmedUrl]);

  // Derived display: progress pct + status line (commit 3 helpers).
  const progressPct = useMemo(() => {
    if (state.kind !== "in-flight" || !state.progress) return null;
    return computeProgressPct(state.progress);
  }, [state]);
  const statusLine = useMemo(() => {
    switch (state.kind) {
      case "idle":
        return null;
      case "starting":
        return "Connecting...";
      case "in-flight":
        return state.progress
          ? formatProgressStatus(state.progress)
          : "Connecting...";
      case "cancelling":
        return "Cancelling...";
      case "opening":
        return "Opening repository...";
      case "done-err":
        return null;
    }
  }, [state]);

  // INVALID_PATH 多半是 picker 註冊後超過 5 min lock expired
  // → 改顯示 Re-pick dest button 引導 user。
  const isLockExpired = state.kind === "done-err" && state.code === "INVALID_PATH";

  const isBusy =
    state.kind === "starting" ||
    state.kind === "in-flight" ||
    state.kind === "cancelling" ||
    state.kind === "opening";
  const showCancelButton = state.kind === "in-flight";

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Clone repository"
      className="fixed inset-0 z-50 flex items-center justify-center bg-app-bg/70"
    >
      <button
        type="button"
        aria-label="Dismiss dialog"
        onClick={handleCloseRequest}
        className="absolute inset-0 w-full h-full cursor-default bg-transparent border-0 p-0"
        tabIndex={-1}
      />
      {/* Overlay 標題列下遮罩蓋住了站牌的拖曳區：頂端一條同站牌高的拖曳帶，疊在 Dismiss 上、卡片下 */}
      <TitleBarDragStrip />
      <div className="relative bg-surface-1 border border-border rounded-md w-full max-w-md mx-4 shadow-lg">
        <h2 className="px-4 py-3 border-b border-border text-sm font-semibold">
          Clone Repository
        </h2>
        <div className="px-4 py-3 text-sm space-y-3">
          {/* URL input — disabled while a clone is in progress */}
          <label className="flex flex-col gap-1">
            <span className="text-xs text-text-secondary">Repository URL</span>
            <input
              ref={urlInputRef}
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={isBusy}
              placeholder="https://github.com/owner/repo.git"
              className="px-3 py-1.5 text-sm rounded border border-border bg-surface-2 disabled:opacity-50"
            />
          </label>

          {/* Dest picker */}
          <div className="flex flex-col gap-1">
            <span className="text-xs text-text-secondary">Destination folder</span>
            <div className="flex gap-2 items-center">
              <Button
                size="sm"
                onClick={() => void handlePickDest()}
                disabled={isBusy}
              >
                {dest ? "Change..." : "Choose folder..."}
              </Button>
              <span
                className="text-xs text-text-tertiary truncate"
                title={dest ?? ""}
              >
                {dest ?? "No folder selected"}
              </span>
            </div>
          </div>

          {/* Progress bar — visible during any non-terminal state */}
          {isBusy && (
            <div className="space-y-1">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  progressPct !== null ? Math.round(progressPct * 100) : undefined
                }
                aria-label="Clone progress"
                className="h-1.5 w-full bg-surface-2 rounded overflow-hidden"
              >
                {progressPct !== null ? (
                  <div
                    className="h-full bg-accent transition-[width] duration-150"
                    style={{ width: `${progressPct * 100}%` }}
                  />
                ) : (
                  // indeterminate: animated stripe (CheckingOut without total
                  // or libgit2 0/0 phase). simple pulse, no library.
                  <div className="h-full bg-accent/60 animate-pulse w-1/3" />
                )}
              </div>
              {statusLine && (
                <p className="text-xs text-text-secondary" role="status">
                  {statusLine}
                </p>
              )}
            </div>
          )}

          {/* Error display */}
          {state.kind === "done-err" && (
            <div className="space-y-2">
              <p className="text-sm text-danger-fg" role="alert">
                {state.message}
              </p>
              {state.hint && (
                <p className="text-xs text-text-secondary">{state.hint}</p>
              )}
              {isLockExpired && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handlePickDest()}
                >
                  Re-pick destination
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
          {showCancelButton ? (
            <Button size="sm" onClick={cancel}>
              Cancel clone
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleCloseRequest}
              disabled={state.kind === "opening"}
            >
              Close
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleStart}
            disabled={!canStart}
          >
            Clone
          </Button>
        </div>
      </div>
    </div>
  );
}
