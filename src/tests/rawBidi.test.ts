import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// src 不放原始的雙向控制字元（Phase 5 Q-T 的規則寫成檢查）：編輯器裡看不見，卻能讓一行讀起來跟實際不同
// （Trojan Source）。要用就寫成跳脫序列——2026-10-11 實測：工具參數裡的跳脫序列寫進檔案會變成原始字元
// （基準被寫進 25 個，測試全綠看不出來）。字元從碼位組，這個檔自己也不放
const CODE_POINTS = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c];
const RAW_BIDI = new RegExp(`[${CODE_POINTS.map((n) => String.fromCharCode(n)).join("")}]`, "g");
// src 裡的文字檔；出現別的副檔名就讓第二條紅，決定它要不要掃
const TEXT = new Set([".ts", ".tsx", ".js", ".css", ".svg", ".json"]);

const SRC = resolve(__dirname, "..");
const files = readdirSync(SRC, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => join(e.parentPath, e.name).slice(SRC.length + 1).split(sep).join("/"));

describe("rawBidi", () => {
  it("test_rawBidi_selfTest_findsEachControlBuiltFromItsCodePoint", () => {
    for (const n of CODE_POINTS) expect(`a${String.fromCharCode(n)}b`.match(RAW_BIDI)).toHaveLength(1);
    expect("named, not raw: RLO U+202E".match(RAW_BIDI)).toBeNull();
  });

  it("test_rawBidi_srcFiles_areTextOfAKindItReads", () => {
    expect(files.filter((f) => !TEXT.has(extname(f)))).toEqual([]);
    expect(files).toEqual(expect.arrayContaining(["lib/v8-highlight.js", "styles/v8.css", "App.tsx", "tests/fixtures/highlight-corpus.js"]));
  });

  it("test_rawBidi_srcFiles_holdNone", () => {
    const found = files.flatMap((f) => {
      const n = readFileSync(join(SRC, f), "utf8").match(RAW_BIDI)?.length ?? 0;
      return n ? [`${f}: ${n}`] : [];
    });
    expect(found).toEqual([]);
  });
});
