import type { ClonePhase, CloneProgressPayload } from "@/lib/tauri";

// Display label per ClonePhase — short status line shown under the
// progress bar. Verbs match what libgit2 is actually doing internally
// so power users can correlate with git CLI output.
export const PHASE_LABEL: Record<ClonePhase, string> = {
  Receiving: "Receiving objects...",
  Resolving: "Resolving deltas...",
  CheckingOut: "Checking out files...",
};

// Phase weights — libgit2's Receiving and CheckingOut callbacks use
// different totals (bytes/objects vs files), so raw current/total snaps
// from 100% back to 0% at phase boundaries.
// Accumulate weighted: 80% Receiving + 5% Resolving + 15% CheckingOut
// (close to plan v3's 75/5/20; revisit after dev smoke on a large repo).
const PHASE_WEIGHTS: Record<ClonePhase, { base: number; span: number }> = {
  Receiving: { base: 0, span: 0.8 },
  Resolving: { base: 0.8, span: 0.05 },
  CheckingOut: { base: 0.85, span: 0.15 },
};

// Compute the weighted progress percentage (0-1) for a CloneProgressPayload.
// Returns `null` when total <= 0 — libgit2 may emit 0/0 in early Receiving
// or skip Resolving altogether on packs with no deltas;
// callers render an indeterminate bar in that case so the UI doesn't lie
// with a stuck 0% or NaN.
//
// Guarantees: 0 <= pct <= 1 for any valid payload. Math result clamped at
// the high end because libgit2 occasionally emits current > total briefly
// when transitioning between phases.
export function computeProgressPct(payload: CloneProgressPayload): number | null {
  if (payload.total <= 0) return null;
  const ratio = Math.min(1, Math.max(0, payload.current / payload.total));
  const { base, span } = PHASE_WEIGHTS[payload.phase];
  return Math.min(1, base + ratio * span);
}

// Status line shown under the progress bar. For Receiving phase, append
// the byte counter so users see throughput. Other phases omit bytes —
// backend sets bytes=0 for Resolving and CheckingOut.
export function formatProgressStatus(payload: CloneProgressPayload): string {
  const base = PHASE_LABEL[payload.phase];
  if (payload.phase !== "Receiving" || payload.bytes === 0) return base;
  return `${base} (${formatBytes(payload.bytes)})`;
}

/** 位元組 → B / KiB / MiB / GiB（clone 進度與 diff 被收合的檔大小共用） */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
