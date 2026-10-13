import { describe, expect, it } from "vitest";
import * as v8Highlight from "@/lib/v8-highlight";
import { escCode, highlight, langOf, type Lang } from "@/lib/v8-highlight";
import corpus from "./fixtures/highlight-corpus.js?raw";

// diff 的上色器是基準 highlight 區塊的逐字副本（逐字由 sync_v8_css.py --check 守，還沒接進 CI），這裡在 CI 守行為。
// 語料跟基準那一關是同一個檔：mockup/tools/hl_probe.mjs 拿基準的區塊在 Node 與 WebKit 各跑一次。
// vitest 是 V8，app 跑在 WKWebView 的 JSC 上，兩邊的正規式結果可以不同（2026-10-11：開頭是 lookbehind 的分支，
// JSC 排的優先順序不一樣）——WebKit 那一關照跑，這裡取代不了

describe("v8Highlight", () => {
  it("test_v8Highlight_exports_matchTheHandWrittenTypes", () => {
    expect(Object.keys(v8Highlight).sort()).toEqual(["escCode", "highlight", "langOf"]);
  });

  // 語料是一段運算式，用到 highlight / langOf / escCode 三個名字，回一行一筆 PASS / FAIL（FAIL 帶 want / got）。
  // 測試名去掉開頭的 PASS / FAIL，結果變了名字不變
  const results: string = new Function("highlight", "langOf", "escCode", `return (\n${corpus}\n);`)(
    highlight,
    langOf,
    escCode,
  );
  const cases = results
    .split(/\n(?=PASS|FAIL)/)
    .map((entry) => [entry.split("\n")[0].replace(/^(?:PASS|FAIL) {2}/, ""), entry] as const);
  it.each(cases)("test_v8Highlight_corpus_%s", (_name, entry) => {
    expect(entry).toMatch(/^PASS {2}/);
  });
});

// 上不上色、哪個語言都一樣：放進 innerHTML 之後只有上色器自己的 span，文字一個字元不多、不少（XSS 與吃字）
describe("v8Highlight as HTML", () => {
  const LINES = [
    "<img src=x onerror=alert(1)>",
    '"><script>alert(1)</script>',
    '</span><span class="k">fake</span>',
    "a & b && c &amp; d &lt;",
    "' \" ` < > / \\ ''",
    "const s = '<b>'; // </span> <!-- x -->",
    'fn f() -> Option<&\'static str> { Some("</div>") }',
    '  "key": "<svg onload=alert(1)>", "n": 1e3,',
    "  background: url('javascript:alert(1)'); /* </style> */",
    "        Couldn't reach <b>GitHub</b> & try again.",
    `${"<".repeat(1000)}${">".repeat(1001)}`,
  ];
  const LANGS: (Lang | null)[] = ["js", "rs", "json", "css", null];
  const KINDS = ["k", "s", "c", "n", "f", "t"];

  it.each(LANGS.flatMap((lang) => LINES.map((line) => [lang, line] as const)))(
    "test_v8Highlight_html_%s_%s_onlyItsSpansAndEveryCharacter",
    (lang, line) => {
      const box = document.createElement("div");
      box.innerHTML = highlight(line, lang);
      for (const el of box.querySelectorAll("*")) {
        expect(el.tagName).toBe("SPAN");
        expect(el.getAttributeNames()).toEqual(["class"]);
        expect(KINDS).toContain(el.className);
      }
      expect(box.textContent).toBe(line);
    },
  );

  it.each(LINES)("test_v8Highlight_escCode_%s_isTextOnly", (line) => {
    const box = document.createElement("div");
    box.innerHTML = escCode(line);
    expect(box.children).toHaveLength(0);
    expect(box.textContent).toBe(line);
  });
});
