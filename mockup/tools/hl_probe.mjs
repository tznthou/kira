// Q-H 驗收（5b 第 0 步）：從基準抽出 highlight 區塊（esc + 語言表 + langOf + highlight，同步腳本抽的同一段），
// 用語料 src/tests/fixtures/highlight-corpus.js 在兩個引擎上跑：Node（V8）與 WebKit（wk-shot，系統 WKWebView = app 的引擎）。
// 兩邊都全 PASS 才 exit 0。
// 用法：node hl_probe.mjs [檔案]（預設 mockup/v8-kirazuri-lines-sys.html，不改任何檔）。app 的副本 src/lib/v8-highlight.js
//       也帶著同樣的標記，可以直接當參數：證明 WebKit 跑的就是 app 出貨的那份
// 為什麼要兩個引擎：JSC 跟 V8 的正規式實作不同（2026-10-11：「第一個分支是 lookbehind」在 JSC 配到的東西不一樣），只在 Node 過不算數。
// 第一版（Q-H 查證）只印出舊上色器的結果，證據記在計畫 v3.1 §0.2；5b step 2 起語料搬進 repo，vitest 拿 app 的副本跑同一個檔
// （vitest 是 V8 不是 JSC，WebKit 這一關照跑、取代不了）。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const file = process.argv[2] ?? new URL("../v8-kirazuri-lines-sys.html", import.meta.url).pathname;
const WK = new URL("./wk-shot", import.meta.url).pathname;
const src = readFileSync(file, "utf8");
const start = src.indexOf("  /* ---------- highlight:");
const endMark = "  /* ---------- end highlight ---------- */\n";
const end = src.indexOf(endMark, start);
if (start < 0 || end < 0) {
  console.log("FAIL  highlight block not found (markers missing)");
  process.exit(1);
}
const block = src.slice(start, end + endMark.length);
const corpus = readFileSync(new URL("../../src/tests/fixtures/highlight-corpus.js", import.meta.url), "utf8");

// 基準本身不放原始雙向字元（Q-T）：寫成跳脫文字，編輯器裡才看得出來。字元從碼位組，這個檔也不放
const span = (a, b) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`;
const RAW_BIDI = new RegExp(`[${span(0x202a, 0x202e)}${span(0x2066, 0x2069)}${String.fromCharCode(0x200e, 0x200f, 0x061c)}]`, "g");
const rawInRef = (src.match(RAW_BIDI) || []).length;
if (rawInRef) {
  console.log(`FAIL  the reference holds ${rawInRef} raw bidirectional control(s): write them as \\u escapes`);
  process.exit(1);
}

const results = {};
results.node = vm.runInNewContext(`${block}\n${corpus}`, {});
const dir = mkdtempSync(join(tmpdir(), "hl-probe-"));
try {
  const page = join(dir, "hl.html");
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><script>\n${block}\ndocument.documentElement.dataset.ready = "1";\n</script>`);
  writeFileSync(join(dir, "corpus.js"), corpus);
  results.webkit = execFileSync(WK, [`file://${page}`, "400", "300", "-", join(dir, "corpus.js"), "ready"], { encoding: "utf8" }).trim();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

let failed = 0;
for (const [engine, text] of Object.entries(results)) {
  const lines = text.split("\n");
  const pass = lines.filter((l) => l.startsWith("PASS")).length;
  const fails = text.split(/\n(?=PASS|FAIL)/).filter((l) => l.startsWith("FAIL"));
  failed += fails.length;
  console.log(`${engine}: ${pass} PASS, ${fails.length} FAIL`);
  for (const f of fails) console.log(`  ${f.replace(/\n/g, "\n  ")}`);
}
console.log(failed ? `\n${failed} FAIL` : "\nall PASS on both engines");
process.exit(failed ? 1 : 0);
