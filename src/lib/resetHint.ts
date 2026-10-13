/**
 * GitHub rate limit 什麼時候可以再試：右欄 rate limit 那格的提示句（Phase 5c；0b §3.1、Q-R），呼叫端直接畫。
 * 寫時鐘時刻、不寫倒數：畫面停著也不會過期，所以不需要計時器（§9 G5）
 * - 還沒到 →「Try again after 14:32.」：本地時間 24 小時制、補零；不足一分鐘往上取整（GitHub 的時刻帶秒，
 *   14:32:45 寫成 14:32 的話照著時刻去試還是被擋）
 * - GitHub 沒說 →「Try again later.」
 * - 已經過了（含剛好到）→「Try again now.」
 * `resetAt`：後端 RATE_LIMITED 的 `reset_at`（unix 秒）；`now`：`Date.now()`（毫秒）
 */
export function resetHint(resetAt: number | null | undefined, now: number): string {
  if (resetAt == null || !Number.isFinite(resetAt)) return "Try again later.";
  const at = resetAt * 1000;
  if (at <= now) return "Try again now.";
  const shown = new Date(Math.ceil(at / 60_000) * 60_000);
  return `Try again after ${String(shown.getHours()).padStart(2, "0")}:${String(shown.getMinutes()).padStart(2, "0")}.`;
}
