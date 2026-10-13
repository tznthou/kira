#!/usr/bin/env python3
"""5b step 7：把基準的示範 diff 逐字抄進 app 的 fidelity fixture（src/dev/fidelity/diffs.ts）。
抄的是原始碼文字（含跳脫序列），只補 TypeScript 型別、縮排少兩格；資料格式由 diffs.ts 的 fromRef() 轉成 DiffFile。
手抄會抄錯、工具參數裡的跳脫序列也會被換成原始字元，所以用腳本。一次性的移植，不是同步工具：基準的示範 diff
之後改了，重跑這支、看 diff、再跑 D1。用法：python3 port_ref_diffs.py
"""
import re
import subprocess
from pathlib import Path

KIRA = Path(__file__).resolve().parents[2]
REF = KIRA / "mockup" / "v8-kirazuri-lines-sys.html"
OUT = KIRA / "src" / "dev" / "fidelity" / "diffs.ts"
src = REF.read_text(encoding="utf-8")
rev = subprocess.run(["git", "-C", str(REF.parent), "log", "-1", "--format=%h", "--", REF.name],
                     capture_output=True, text=True, check=True).stdout.strip()
dirty = bool(subprocess.run(["git", "-C", str(REF.parent), "status", "--porcelain", "--", REF.name],
                            capture_output=True, text=True, check=True).stdout.strip())


def block(start, end):
    """start（一行的開頭）到 end（含）之間，連同緊接在上面的註解行；只准出現一次"""
    assert src.count(start) == 1, f"{start!r} found {src.count(start)} times"
    i = src.index(start)
    j = src.index(end, i) + len(end)
    lines = src[:i].split("\n")[:-1]
    k = len(lines)
    while k > 0 and lines[k - 1].lstrip().startswith("//"):
        k -= 1
    comment = "\n".join(lines[k:]) + ("\n" if k < len(lines) else "")
    text = comment + src[i:j]
    return "\n".join(l[2:] if l.startswith("  ") else l for l in text.split("\n"))


TYPES = [
    ("const YOUNG_DIFFS = {", "const YOUNG_DIFFS: Record<string, RefFile[]> = {"),
    ("const ROUTES_DIFFS = {", "const ROUTES_DIFFS: Record<string, RefFile[]> = {"),
    ("function minified(seed, n) {", "function minified(seed: number, n: number): string {"),
    ("const LIMITS = () => [", "const LIMITS = (): RefFile[] => ["),
    ("const BIDI_DIFF = () => [", "const BIDI_DIFF = (): RefFile[] => ["),
    ("const MANY = () => ", "const MANY = (): RefFile[] => "),
]

parts = [
    block("  const YOUNG_DIFFS = {", "\n  };\n"),
    block("  const ROUTES_DIFFS = {", "\n  };\n"),
    block("  function minified(seed, n) {", "\n  }\n"),
    block("  const LIMITS = () => [", "\n  ];\n"),
    block("  const LOCALES = ", ";\n") + block("  const NAMESPACES = ", ";\n"),
    block("  const BIDI_DIFF = () => [", "] }] }];\n"),
    block("  const MANY = () => ", "] }] })));\n"),
]
body = "\n".join(parts)
for old, new in TYPES:
    assert body.count(old) == 1, f"{old!r} found {body.count(old)} times"
    body = body.replace(old, new)

BIDI = set(range(0x202a, 0x202f)) | set(range(0x2066, 0x206a)) | {0x200e, 0x200f, 0x061c}
assert not [c for c in body if ord(c) in BIDI], "raw bidirectional controls in the copied text"

header = f"""// v8 基準的示範 diff（mockup/{REF.name} @ {rev}{" + 未 commit 的改動" if dirty else ""}）：原始碼逐字抄來，只補型別、縮排少兩格。
// 由 mockup/tools/port_ref_diffs.py 產生；基準的示範 diff 改了就重跑它（手抄會抄錯，跳脫序列也會被換掉）。
// 格式是基準的 {{ p, s, hunks, binary?, tooLarge?, omitted? }}，fromRef() 轉成後端的 DiffFile。
// 只在 dev 的 fidelity 入口使用，不進正式包。
import type {{ DiffFile }} from "@/lib/tauri";
import {{ file, type RawHunk }} from "./fixture";

/** 基準的檔案格式（fileHTML 吃的那種） */
interface RefFile {{
  p: string;
  s: "M" | "A" | "D" | "R";
  hunks: RawHunk[];
  binary?: boolean;
  tooLarge?: boolean;
  omitted?: DiffFile["omitted"];
}}

const STATUS = {{ M: "Modified", A: "Added", D: "Deleted", R: "Renamed" }} as const;

/** 基準格式 → 後端的 DiffFile（行號與行數照 fixture 的 file() 算）。超過 10 MB 的檔後端回 binary = false
 *  （classify_blob_flags：libgit2 對大檔也設 BINARY，後端讓 too_large 優先），基準的示範資料兩個都標了 */
export function fromRef(f: RefFile): DiffFile {{
  const tooLarge = !!f.tooLarge;
  return {{ ...file(f.p, STATUS[f.s], f.hunks), binary: !!f.binary && !tooLarge, too_large: tooLarge, omitted: f.omitted ?? null }};
}}

const convert = (diffs: Record<string, RefFile[]>) =>
  Object.fromEntries(Object.entries(diffs).map(([id, files]) => [id, files.map(fromRef)]));

"""
footer = """
export const youngDiffs = () => convert(YOUNG_DIFFS);
export const routesDiffs = () => convert(ROUTES_DIFFS);
export const limitsDiff = () => LIMITS().map(fromRef);
export const manyDiff = () => MANY().map(fromRef);
export const bidiDiff = () => BIDI_DIFF().map(fromRef);
"""
OUT.write_text(header + body + footer, encoding="utf-8")
print(f"wrote {OUT.relative_to(KIRA)} from {REF.name} @ {rev}{' (dirty)' if dirty else ''}: {len(body)} chars")
