import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { FileDiff, type ShowAt } from "@/components/DiffViewer/FileDiff";
import type { DiffFile, DiffHunk, DiffLine } from "@/lib/tauri";

// 真的上色器，只多一層計數（下面「rendering cost」用）
vi.mock("@/lib/v8-highlight", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/v8-highlight")>();
  return { ...m, highlight: vi.fn(m.highlight) };
});
import { highlight } from "@/lib/v8-highlight";

const OID = "63421cf0a1b2c3d4e5f60718293a4b5c6d7e8f90";
const MERGE: ShowAt = { oid: OID, parentCount: 2 };
const ONE_PARENT: ShowAt = { oid: OID, parentCount: 1 };
const RLO = String.fromCharCode(0x202e);

const line = (origin: string, content: string, old_lineno: number | null, new_lineno: number | null): DiffLine => ({
  origin,
  content,
  old_lineno,
  new_lineno,
});

const hunk = (overrides: Partial<DiffHunk> = {}): DiffHunk => ({
  old_start: 1,
  old_lines: 3,
  new_start: 1,
  new_lines: 3,
  context: "",
  lines: [line(" ", "const a = 1;", 1, 1), line("-", "const b = 2;", 2, null), line("+", "const b = 3;", null, 2)],
  ...overrides,
});

const file = (overrides: Partial<DiffFile> = {}): DiffFile => ({
  path: "src/lib/a.ts",
  status: "Modified",
  hunks: [hunk()],
  binary: false,
  too_large: false,
  omitted: null,
  ...overrides,
});

function draw(f: DiffFile, at: ShowAt | null = ONE_PARENT) {
  return render(<FileDiff file={f} at={at} />).container.querySelector("article.dfile") as HTMLElement;
}

describe("FileDiff: the header", () => {
  afterEach(() => cleanup());

  it.each([
    ["Added", "A"],
    ["Modified", "M"],
    ["Deleted", "D"],
    ["Renamed", "R"],
  ] as const)("test_fileDiff_status%s_isALetterBadgeTitledWithTheWord", (status, letter) => {
    const badge = draw(file({ status })).querySelector(".dfile-head .badge");
    expect(badge?.className).toBe(`badge ${letter}`);
    expect(badge?.textContent).toBe(letter);
    expect(badge?.getAttribute("title")).toBe(status);
  });

  it("test_fileDiff_path_directoryInItsOwnSpanThenTheName", () => {
    const path = draw(file()).querySelector(".dpath");
    expect(path?.querySelector(".dir")?.textContent).toBe("src/lib/");
    expect(path?.textContent).toBe("src/lib/a.ts");
  });

  it("test_fileDiff_pathWithoutADirectory_isTheNameAlone", () => {
    const path = draw(file({ path: "README.md" })).querySelector(".dpath");
    expect(path?.querySelector(".dir")).toBeNull();
    expect(path?.textContent).toBe("README.md");
  });

  // Q-T：檔名裡的雙向控制字元換成看得見的標記，不讓它反轉後面的字（"invoice.exe" 偽裝成 "invoice.txt"）
  it("test_fileDiff_pathWithABidiControl_namesIt", () => {
    const path = draw(file({ path: `docs/invoice${RLO}txt.exe` })).querySelector(".dpath");
    expect(path?.querySelector(".bidi")?.getAttribute("title")).toBe("U+202E");
    expect(path?.textContent).toBe("docs/invoiceRLOtxt.exe");
  });

  it("test_fileDiff_pathWithMarkup_isText", () => {
    const path = draw(file({ path: 'x/<img src=x onerror="alert(1)">.ts' })).querySelector(".dpath");
    expect(path?.querySelector("img")).toBeNull();
    expect(path?.textContent).toBe('x/<img src=x onerror="alert(1)">.ts');
  });
});

describe("FileDiff: what the file shows, in this order", () => {
  afterEach(() => cleanup());

  it("test_fileDiff_tooLarge_winsOverBinary", () => {
    const cell = draw(file({ too_large: true, binary: true, hunks: [] })).querySelector(".dcell");
    expect(cell?.className).toBe("dcell warn");
    expect(cell?.innerHTML).toBe("<b>Over 10 MB.</b> Diff skipped.");
  });

  it("test_fileDiff_binary_isAPlainCell", () => {
    const cell = draw(file({ binary: true, hunks: [] })).querySelector(".dcell");
    expect(cell?.className).toBe("dcell");
    expect(cell?.textContent).toBe("Binary file");
  });

  it("test_fileDiff_tooLargeOnItsOwn_saysSoWithItsSizeAndTheCommand", () => {
    const el = draw(file({ path: "package-lock.json", hunks: [], omitted: { reason: "File", lines: 3412, bytes: 96000 } }), MERGE);
    const cell = el.querySelector(".dcell.warn");
    expect(cell?.querySelector("b")?.textContent).toBe("Too large to show.");
    expect(cell?.querySelector(".size")?.textContent).toBe("3,412 lines · 93.8 KiB");
    expect(cell?.querySelector(".how")?.textContent).toBe(
      "In a terminal: git show -m --first-parent 63421cf0a1b2 -- package-lock.json",
    );
    expect(el.querySelector(".hunk-head")).toBeNull();
  });

  it("test_fileDiff_overTheTotal_saysTheFilesBeforeItUsedTheLimitUp", () => {
    const f = file({ path: "docs/notes/v8 port [draft].md", hunks: [], omitted: { reason: "Total", lines: 1, bytes: 1 } });
    const cell = draw(f, ONE_PARENT).querySelector(".dcell.warn");
    expect(cell?.firstElementChild?.textContent).toBe("Not shown. The files before it used up the display limit. 1 line · 1 B");
    expect(cell?.querySelector(".how code")?.textContent).toBe("git show 63421cf0a1b2 -- ':(literal)docs/notes/v8 port [draft].md'");
  });

  it("test_fileDiff_omittedInAPullRequest_hasNoCommand", () => {
    const cell = draw(file({ hunks: [], omitted: { reason: "File", lines: 5000, bytes: 200000 } }), null).querySelector(".dcell");
    expect(cell?.querySelector(".how")).toBeNull();
    expect(cell?.textContent).toBe("Too large to show. 5,000 lines · 195.3 KiB");
  });

  it("test_fileDiff_omittedPathWithAControlCharacter_hasNoCommand", () => {
    const f = file({ path: "a\tb.json", hunks: [], omitted: { reason: "File", lines: 5000, bytes: 200000 } });
    expect(draw(f).querySelector(".how")).toBeNull();
  });

  // 改名的檔不給指令：pathspec 只有新路徑時 git 配不出 rename，`git show … -- <新路徑>` 印的是整檔新增（審查實跑）
  it("test_fileDiff_omittedRenamedFile_hasNoCommand", () => {
    const f = file({ path: "dist/assets/index-b2c3d4.js", status: "Renamed", hunks: [], omitted: { reason: "File", lines: 5000, bytes: 200000 } });
    const cell = draw(f).querySelector(".dcell.warn");
    expect(cell?.querySelector(".how")).toBeNull();
    expect(cell?.querySelector("b")?.textContent).toBe("Too large to show.");
  });

  // Q-T2 在元件層：路徑帶雙向控制字元（RLO 偽裝的檔名）也不給指令
  it("test_fileDiff_omittedPathWithABidiControl_hasNoCommand", () => {
    const f = file({ path: `docs/invoice${RLO}txt.exe`, hunks: [], omitted: { reason: "File", lines: 5000, bytes: 200000 } });
    expect(draw(f).querySelector(".how")).toBeNull();
  });

  it("test_fileDiff_noHunks_saysNoTextChanges", () => {
    const cell = draw(file({ hunks: [] })).querySelector(".dcell");
    expect(cell?.className).toBe("dcell");
    expect(cell?.textContent).toBe("No text changes");
  });
});

describe("FileDiff: hunks", () => {
  afterEach(() => cleanup());

  it("test_fileDiff_hunkHead_countsFromGitThenTheFunctionName", () => {
    const head = draw(file({ hunks: [hunk({ old_start: 12, old_lines: 7, new_start: 12, new_lines: 8, context: "export function main() {" })] }))
      .querySelector(".hunk-head");
    expect(head?.textContent).toBe("@@ -12,7 +12,8 @@ export function main() {");
  });

  it("test_fileDiff_hunkHeadWithoutAFunction_endsAtTheMarks", () => {
    expect(draw(file()).querySelector(".hunk-head")?.textContent).toBe("@@ -1,3 +1,3 @@");
  });

  it("test_fileDiff_hunkHeadWithABidiControl_namesIt", () => {
    const head = draw(file({ hunks: [hunk({ context: `fn a${RLO}b()` })] })).querySelector(".hunk-head");
    expect(head?.querySelector(".bidi")?.textContent).toBe("RLO");
  });

  it("test_fileDiff_lines_classMarkAndNumbersFromTheBackend", () => {
    const rows = [...draw(file()).querySelectorAll(".hunk-body > .hunk-inner > .dl")];
    expect(rows.map((r) => r.className)).toEqual(["dl ctx", "dl del", "dl add"]);
    expect(rows.map((r) => r.querySelector(".og")?.textContent)).toEqual(["", "−", "+"]);
    expect(rows.map((r) => [...r.querySelectorAll(".ln")].map((n) => n.textContent))).toEqual([
      ["1", "1"],
      ["2", ""],
      ["", "2"],
    ]);
    expect(rows.map((r) => r.querySelector("code")?.textContent)).toEqual(["const a = 1;", "const b = 2;", "const b = 3;"]);
  });

  it("test_fileDiff_lines_colouredByTheFilesLanguage", () => {
    expect(draw(file()).querySelector(".dl code .k")?.textContent).toBe("const");
    cleanup();
    expect(draw(file({ path: "notes.md" })).querySelector(".dl code span")).toBeNull();
  });

  it("test_fileDiff_lineWithMarkup_isText", () => {
    const f = file({ hunks: [hunk({ lines: [line("+", '"</code><img src=x onerror=alert(1)>"', null, 1)] })] });
    const code = draw(f).querySelector(".dl code");
    expect(code?.querySelector("img")).toBeNull();
    expect(code?.textContent).toBe('"</code><img src=x onerror=alert(1)>"');
  });

  // hunk 標頭的函式名也是 repo 的文字（B2）：跟路徑、行一樣只能是純文字
  it("test_fileDiff_hunkHeadWithMarkup_isText", () => {
    const head = draw(file({ hunks: [hunk({ context: '<img src=x onerror="alert(1)">' })] })).querySelector(".hunk-head");
    expect(head?.querySelector("img")).toBeNull();
    expect(head?.children.length).toBe(0);
    expect(head?.textContent).toBe('@@ -1,3 +1,3 @@ <img src=x onerror="alert(1)">');
  });

  // Q-T 在元件層：行裡的雙向控制字元在 `.dl code` 裡標出來（路徑與 hunk 標頭另有測試）
  it("test_fileDiff_lineWithABidiControl_namesItInTheCode", () => {
    const f = file({ hunks: [hunk({ lines: [line("+", `const a${RLO}b = 1;`, null, 1)] })] });
    const mark = draw(f).querySelector(".dl code .bidi");
    expect(mark?.textContent).toBe("RLO");
    expect(mark?.getAttribute("title")).toBe("U+202E");
  });

  // git 的「\ No newline at end of file」（Q-N）：libgit2 送 origin = > <、內容開頭帶換行、行號沿用上一行（實測，
  // 後端 diff.rs 有測試釘它）。是上一行的註記：淡色一行，不帶行號與標記、不上色，文字照 git 的寫法。三種 origin
  // 各照 git 真正的序列（context 之後 `=`、刪除之後 `>`、新增之後 `<`），不是同一個擺法換字母
  const NOTE = "\n\\ No newline at end of file";
  it.each([
    ["=", "afterAContextLine", [line(" ", "}", 16, 16), line("=", NOTE, 16, 16)], ["dl ctx", "dl eof"]],
    [">", "afterADeletedLine", [line("-", "}", 16, null), line(">", NOTE, 16, null), line("+", "}", null, 16)], ["dl del", "dl eof", "dl add"]],
    ["<", "afterAnAddedLine", [line("-", "}", 16, null), line("+", "}", null, 16), line("<", NOTE, null, 16)], ["dl del", "dl add", "dl eof"]],
  ])("test_fileDiff_noNewlineMarker%s_isANoteWithoutNumbers_%s", (_origin, _where, lines, classes) => {
    const f = file({ path: "src-tauri/capabilities/default.json", hunks: [hunk({ old_start: 13, old_lines: 4, new_start: 13, new_lines: 4, lines })] });
    const rows = [...draw(f).querySelectorAll(".dl")];
    expect(rows.map((r) => r.className)).toEqual(classes);
    const note = rows.find((r) => r.classList.contains("eof"));
    expect([...(note?.querySelectorAll(".ln, .og") ?? [])].map((n) => n.textContent)).toEqual(["", "", ""]);
    expect(note?.querySelector("code")?.innerHTML).toBe("\\ No newline at end of file");
  });
});

describe("FileDiff: rendering cost", () => {
  afterEach(() => cleanup());

  // 審查：App 重畫（切 tab、對話框、refresh）時 props 沒變，不該把 hunk 的每一行重新上色一遍
  it("test_fileDiff_rerenderWithTheSameProps_doesNotColourAgain", () => {
    vi.mocked(highlight).mockClear();
    const f = file();
    const { rerender } = render(<FileDiff file={f} at={ONE_PARENT} />);
    expect(vi.mocked(highlight).mock.calls.length).toBe(3);
    rerender(<FileDiff file={f} at={ONE_PARENT} />);
    expect(vi.mocked(highlight).mock.calls.length).toBe(3);
  });
});
