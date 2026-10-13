import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CheckoutConfirmDialog,
  CreateBranchDialog,
  DeleteConfirmDialog,
} from "@/components/BranchList/dialogs";

describe("BranchList dialogs (T10 v2 #4-#5 destructive copy)", () => {
  it("test_checkoutDialog_force_label_warns_destructive_with_ignored_caveat", () => {
    const { getByText } = render(
      <CheckoutConfirmDialog
        branchName="feature"
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(getByText(/Switch to feature/i)).not.toBeNull();
    expect(getByText(/cannot be undone/i)).not.toBeNull();
    expect(getByText(/ignored files preserved/i)).not.toBeNull();
  });

  it("test_checkoutDialog_safe_button_passes_force_false", () => {
    const onConfirm = vi.fn();
    const { getByText } = render(
      <CheckoutConfirmDialog
        branchName="feature"
        busy={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(getByText("Safe"));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("test_checkoutDialog_force_button_passes_force_true", () => {
    const onConfirm = vi.fn();
    const { getByText } = render(
      <CheckoutConfirmDialog
        branchName="feature"
        busy={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(getByText("Force"));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("test_deleteDialog_force_unchecked_passes_force_false", () => {
    const onConfirm = vi.fn();
    const { getByText } = render(
      <DeleteConfirmDialog
        branchName="feature"
        busy={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(getByText("Delete"));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("test_deleteDialog_reflog_recovery_hint_present", () => {
    const { getByText } = render(
      <DeleteConfirmDialog
        branchName="feature"
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(getByText(/git reflog/i)).not.toBeNull();
    expect(getByText(/git fsck --lost-found/i)).not.toBeNull();
  });

  it("test_deleteDialog_force_checkbox_toggles_to_force_delete_label", () => {
    const onConfirm = vi.fn();
    const { getByText, getByLabelText } = render(
      <DeleteConfirmDialog
        branchName="feature"
        busy={false}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    const checkbox = getByLabelText(/Force delete/i) as HTMLInputElement;
    fireEvent.click(checkbox);
    fireEvent.click(getByText("Force delete"));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("test_createDialog_empty_name_disables_submit", () => {
    const onConfirm = vi.fn();
    const { getByText } = render(
      <CreateBranchDialog busy={false} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    const btn = getByText("Create") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("test_createDialog_trimmed_name_passes_to_handler_on_submit", () => {
    const onConfirm = vi.fn();
    const { getByPlaceholderText, getByText } = render(
      <CreateBranchDialog busy={false} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    const input = getByPlaceholderText(/awesome-thing/i);
    fireEvent.change(input, { target: { value: "  feat/new-thing  " } });
    fireEvent.click(getByText("Create"));
    expect(onConfirm).toHaveBeenCalledWith("feat/new-thing");
  });

  // Regression: Tab on the last focusable inside the dialog must wrap back to
  // the first, not leak into background buttons (Refresh / Push / Logout).
  // Without the trap, the modal stops being modal for keyboard users.
  it("test_checkoutDialog_tab_on_last_button_wraps_to_first", () => {
    const { getByText, getByLabelText } = render(
      <CheckoutConfirmDialog
        branchName="feature"
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const cancel = getByText("Cancel") as HTMLButtonElement;
    const force = getByText("Force") as HTMLButtonElement;
    const dialog = getByLabelText("Switch to feature");
    expect(dialog.getAttribute("role")).toBe("dialog");

    force.focus();
    expect(document.activeElement).toBe(force);

    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
  });

  it("test_checkoutDialog_shift_tab_on_first_button_wraps_to_last", () => {
    const { getByText } = render(
      <CheckoutConfirmDialog
        branchName="feature"
        busy={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const cancel = getByText("Cancel") as HTMLButtonElement;
    const force = getByText("Force") as HTMLButtonElement;

    cancel.focus();
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(force);
  });

  // Escape still closes the dialog after focus-trap refactor.
  it("test_checkoutDialog_escape_calls_onCancel", () => {
    const onCancel = vi.fn();
    render(
      <CheckoutConfirmDialog
        branchName="feature"
        busy={false}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
