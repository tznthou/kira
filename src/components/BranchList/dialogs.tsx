import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { TitleBarDragStrip } from "@/components/ui/TitleBarDragStrip";

// Shared modal shell. Overlay = button so keyboard/screen-reader users get
// the dismiss affordance for free (Enter / Space activate it just like a
// mouse click). The inner panel is a plain region; pointer events on it do
// not bubble to the overlay because the inner is rendered as a sibling block
// inside the overlay's flex container — only clicks landing on the overlay
// background reach the dismiss handler.
interface ModalProps {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}

// Focus-trap selector. Excludes tabindex=-1 (the overlay dismiss button uses
// it) so Tab cycles only over real interactive elements inside the panel.
function getFocusables(container: HTMLElement): HTMLElement[] {
  const sel =
    'button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
    'textarea:not([disabled]),[href],[tabindex]';
  return Array.from(container.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => el.tabIndex !== -1,
  );
}

function Modal({ title, children, onClose }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Restore focus to the trigger element when the dialog closes — standard
  // a11y pattern so keyboard users land back where they were (e.g. the
  // "+ New branch" button after Cancel).
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    // Defer one microtask so nested autoFocus (e.g. CreateBranchDialog input)
    // wins; only fall back to first focusable if nothing inside grabbed focus.
    queueMicrotask(() => {
      const dialog = dialogRef.current;
      if (dialog && !dialog.contains(document.activeElement)) {
        getFocusables(dialog)[0]?.focus();
      }
    });
    return () => {
      previousFocus?.focus?.();
    };
  }, []);

  // ESC closes; Tab/Shift+Tab cycle focus inside the dialog. Without the trap,
  // Tab walks straight into background buttons (Refresh, Push, Logout) and
  // the modal stops being modal for keyboard users.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
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
        // Focus escaped (e.g. via mouse click on background hadn't happened,
        // but defensive) — pull it back so the next Tab starts inside.
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
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-app-bg/70"
    >
      <button
        type="button"
        aria-label="Dismiss dialog"
        onClick={onClose}
        className="absolute inset-0 w-full h-full cursor-default bg-transparent border-0 p-0"
        tabIndex={-1}
      />
      {/* Overlay 標題列下遮罩蓋住了站牌的拖曳區：頂端一條同站牌高的拖曳帶，疊在 Dismiss 上、卡片下 */}
      <TitleBarDragStrip />
      <div className="relative bg-surface-1 border border-border rounded-md w-full max-w-md mx-4 shadow-lg">
        <h2 className="px-4 py-3 border-b border-border text-sm font-semibold">
          {title}
        </h2>
        <div className="px-4 py-3 text-sm space-y-3">{children}</div>
      </div>
    </div>
  );
}

// ====== Checkout ======

export interface CheckoutDialogProps {
  branchName: string;
  busy: boolean;
  onConfirm: (force: boolean) => void;
  onCancel: () => void;
}

export function CheckoutConfirmDialog({
  branchName,
  busy,
  onConfirm,
  onCancel,
}: CheckoutDialogProps) {
  return (
    <Modal title={`Switch to ${branchName}`} onClose={onCancel}>
      <p className="text-text-secondary">
        Safe switch refuses if there are uncommitted tracked changes; Force
        will discard tracked changes (ignored files preserved). This cannot be
        undone.
      </p>
      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => onConfirm(false)}
          disabled={busy}
        >
          Safe
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={() => onConfirm(true)}
          disabled={busy}
        >
          Force
        </Button>
      </div>
    </Modal>
  );
}

// ====== Delete ======

export interface DeleteDialogProps {
  branchName: string;
  busy: boolean;
  onConfirm: (force: boolean) => void;
  onCancel: () => void;
}

export function DeleteConfirmDialog({
  branchName,
  busy,
  onConfirm,
  onCancel,
}: DeleteDialogProps) {
  const [force, setForce] = useState(false);
  return (
    <Modal title={`Delete branch ${branchName}`} onClose={onCancel}>
      <p className="text-text-secondary">
        Safe delete rejects branches with unmerged commits. Force delete
        removes the ref unconditionally — commits may be recoverable via
        <code className="font-mono mx-1">git reflog</code> or
        <code className="font-mono mx-1">git fsck --lost-found</code>, but
        recovery is not guaranteed.
      </p>
      <label className="flex items-center gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={force}
          onChange={(e) => setForce(e.target.checked)}
          disabled={busy}
        />
        Force delete (skip merged check)
      </label>
      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={() => onConfirm(force)}
          disabled={busy}
        >
          {force ? "Force delete" : "Delete"}
        </Button>
      </div>
    </Modal>
  );
}

// ====== Create ======

export interface CreateDialogProps {
  busy: boolean;
  /** 建立失敗的文案（Phase 5 Q-C）；每次失敗都是新的物件，同一句再出現也把焦點放回輸入框 */
  error?: { title: string; detail?: string } | null;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export function CreateBranchDialog({
  busy,
  error,
  onConfirm,
  onCancel,
}: CreateDialogProps) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed) return;
    onConfirm(trimmed);
  };
  // Programmatic focus on mount instead of the autoFocus prop — same UX,
  // but bypasses jsx-a11y/no-autofocus and keeps the focus assignment
  // intentional rather than implicit.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  // 建立失敗（Phase 5 Q-C）：焦點回輸入框好直接改名再試。建立進行中輸入框是停用的（焦點可能已經掉了），
  // 所以等它重新啟用才給
  const focusAfterError = useRef(false);
  useEffect(() => {
    if (error) focusAfterError.current = true;
  }, [error]);
  useEffect(() => {
    if (focusAfterError.current && !busy) {
      focusAfterError.current = false;
      inputRef.current?.focus();
    }
  }, [error, busy]);
  return (
    <Modal title="Create branch" onClose={onCancel}>
      <p className="text-text-secondary">
        The new branch will start at the current HEAD commit. It is not
        checked out — use the row to switch after creation.
      </p>
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="e.g. feat/awesome-thing"
        disabled={busy}
        className="w-full px-3 py-1.5 text-sm rounded border border-border bg-surface-2 focus:outline-none focus:border-accent disabled:opacity-50"
      />
      {/* 失敗留在對話框裡：站牌的提示會被遮罩蓋住。樣式 P6 換 */}
      {error && (
        <p role="alert" className="text-danger-fg text-sm">
          <b>{error.title}</b>
          {error.detail ? ` ${error.detail}` : ""}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={busy || !trimmed}
        >
          Create
        </Button>
      </div>
    </Modal>
  );
}
