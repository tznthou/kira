import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetHint } from "@/lib/resetHint";

// 時鐘時刻照本地時區：釘成台北（基準與 fixture 的時區），最後一條換 UTC 證明它跟著時區走。
// vitest 2 的 forks pool 一個測試檔一個子行程，改的只是這個行程的 TZ；結束時照樣還原
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Taipei";
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

// 期望值一律寫字面字串。RESET = 2026-10-03 14:32 +08:00（基準 prs-rate 的「Try again after 14:32.」）；
// NOW = fixture 凍結的現在 14:31（Phase 5 Q-R）
const RESET = 1_791_009_120;
const NOW = Date.parse("2026-10-03T14:31:00+08:00");
const unix = (iso: string) => Date.parse(iso) / 1000;

describe("resetHint", () => {
  it("test_resetHint_aheadOfNow_isTheLocalClockTime", () => {
    expect(resetHint(RESET, NOW)).toBe("Try again after 14:32.");
  });

  it("test_resetHint_hoursAndMinutes_areZeroPadded", () => {
    expect(resetHint(unix("2026-10-04T09:05:00+08:00"), NOW)).toBe("Try again after 09:05.");
  });

  it("test_resetHint_pastMidnight_isTwentyFourHour", () => {
    expect(resetHint(unix("2026-10-04T00:07:00+08:00"), NOW)).toBe("Try again after 00:07.");
  });

  // GitHub 的重置時刻帶秒：14:32:45 寫成 14:32 的話，照著 14:32:10 去試還是被擋 → 往上取整到下一分鐘
  it("test_resetHint_insideAMinute_isTheNextMinute", () => {
    expect(resetHint(RESET + 45, NOW)).toBe("Try again after 14:33.");
    // 不到半分鐘也進位：四捨五入會寫成 14:32
    expect(resetHint(RESET + 15, NOW)).toBe("Try again after 14:33.");
  });

  it("test_resetHint_noResetTime_isTryAgainLater", () => {
    expect(resetHint(null, NOW)).toBe("Try again later.");
    expect(resetHint(undefined, NOW)).toBe("Try again later.");
  });

  it("test_resetHint_alreadyPast_isTryAgainNow", () => {
    expect(resetHint(RESET, NOW + 5 * 60_000)).toBe("Try again now.");
  });

  it("test_resetHint_exactlyAtTheReset_isTryAgainNow", () => {
    expect(resetHint(RESET, RESET * 1000)).toBe("Try again now.");
  });

  it("test_resetHint_followsTheLocalTimeZone", () => {
    process.env.TZ = "UTC";
    try {
      expect(resetHint(RESET, NOW)).toBe("Try again after 06:32.");
    } finally {
      process.env.TZ = "Asia/Taipei";
    }
  });
});
