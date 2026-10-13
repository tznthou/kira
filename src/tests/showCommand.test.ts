import { describe, expect, it } from "vitest";
import { showCommand } from "@/lib/showCommand";

// 期望值一律寫字面字串，不用函式自己組：規則被改壞時兩邊才不會一起跟著變
const OID = "63421cf0a1b2c3d4e5f60718293a4b5c6d7e8f90";

describe("showCommand", () => {
  it("test_showCommand_oneParent_isAPlainGitShowWithTwelveHexDigits", () => {
    expect(showCommand(OID, 1, "src/index.css")).toBe("git show 63421cf0a1b2 -- src/index.css");
  });

  // 直接 git show 一個 merge 是 combined diff，一邊原樣帶進來的檔一行都不印；Kira 的 diff 是對第一個 parent
  it("test_showCommand_merge_isAgainstTheFirstParent", () => {
    expect(showCommand(OID, 2, "src/index.css")).toBe("git show -m --first-parent 63421cf0a1b2 -- src/index.css");
    expect(showCommand(OID, 3, "src/index.css")).toBe("git show -m --first-parent 63421cf0a1b2 -- src/index.css");
  });

  it("test_showCommand_rootCommit_isAPlainGitShow", () => {
    expect(showCommand(OID, 0, "README.md")).toBe("git show 63421cf0a1b2 -- README.md");
  });

  it.each([
    ["onlyLettersDigitsAndDotUnderscoreSlashDash_asItIs", "src/lib/route-map_v2.ts", "src/lib/route-map_v2.ts"],
    ["aDashFirst_asItIsAfterTheDoubleDash", "-rf", "-rf"],
    ["aSpace_quoted", "docs/my notes.md", "'docs/my notes.md'"],
    ["anApostrophe_closedEscapedAndReopened", "it's.md", "'it'\\''s.md'"],
    ["shellCharacters_quoted", "a$b`c!d;e|f&g.md", "'a$b`c!d;e|f&g.md'"],
    ["equalsOrTildeFirst_quotedSinceZshExpandsThem", "=cmd", "'=cmd'"],
    ["tildeFirst_quoted", "~/notes.md", "'~/notes.md'"],
    ["nonAscii_quoted", "文件/說明.md", "'文件/說明.md'"],
    ["aColonLater_quotedButNotLiteral", "a:b.md", "'a:b.md'"],
    ["aClosingBracketAlone_quotedButNotLiteral", "a]b.ts", "'a]b.ts'"],
    // git reads these as patterns or magic even inside the shell's quotes: app/[id] would match app/i and app/d
    ["aBracket_literal", "app/[id]/page.tsx", "':(literal)app/[id]/page.tsx'"],
    ["anAsterisk_literal", "a*b.ts", "':(literal)a*b.ts'"],
    ["aQuestionMark_literal", "a?b.ts", "':(literal)a?b.ts'"],
    ["aBackslash_literal", "a\\b.ts", "':(literal)a\\b.ts'"],
    ["aColonFirst_literal", ":notes.md", "':(literal):notes.md'"],
    ["anApostropheAndABracket_literalAndEscaped", "it's [draft].md", "':(literal)it'\\''s [draft].md'"],
  ])("test_showCommand_path_%s", (_case, path, arg) => {
    expect(showCommand(OID, 1, path)).toBe(`git show 63421cf0a1b2 -- ${arg}`);
  });

  // 貼到終端機就換行、跳出或亂碼：不給指令
  it.each([
    ["aTab", "a\tb.md"],
    ["aNewline", "a\nb.md"],
    ["aCarriageReturn", "a\rb.md"],
    ["anEscape", "a\u001b[2Jb.md"],
    ["aNul", "a\u0000b.md"],
    ["aDel", "a\u007fb.md"],
  ])("test_showCommand_controlCharacter_%s_givesNoCommand", (_case, path) => {
    expect(showCommand(OID, 1, path)).toBeNull();
  });

  // Q-T2：雙向控制字元照原樣顯示會讓指令讀成別的檔（scripts/setup + RLO + hs.exe 讀成 setupexe.sh），換成標記又不能
  // 貼：一樣不給指令。字元從碼位組，這個檔不放原始字元
  it.each([
    ["LRE", 0x202a],
    ["RLE", 0x202b],
    ["PDF", 0x202c],
    ["LRO", 0x202d],
    ["RLO", 0x202e],
    ["LRI", 0x2066],
    ["RLI", 0x2067],
    ["FSI", 0x2068],
    ["PDI", 0x2069],
    ["LRM", 0x200e],
    ["RLM", 0x200f],
    ["ALM", 0x061c],
  ])("test_showCommand_bidiControl_%s_givesNoCommand", (_name, code) => {
    expect(showCommand(OID, 2, `scripts/setup${String.fromCharCode(code)}hs.exe`)).toBeNull();
  });

  // 零寬連接字元不是雙向控制字元（emoji 由它組成）：照樣給指令、加引號
  it("test_showCommand_zeroWidthJoiner_isQuotedNotRefused", () => {
    const path = `docs/a${String.fromCharCode(0x200d)}b.md`;
    expect(showCommand(OID, 1, path)).toBe(`git show 63421cf0a1b2 -- '${path}'`);
  });
});
