// v8 基準的示範 diff（mockup/v8-kirazuri-lines-sys.html @ 9385aaf）：原始碼逐字抄來，只補型別、縮排少兩格。
// 由 mockup/tools/port_ref_diffs.py 產生；基準的示範 diff 改了就重跑它（手抄會抄錯，跳脫序列也會被換掉）。
// 格式是基準的 { p, s, hunks, binary?, tooLarge?, omitted? }，fromRef() 轉成後端的 DiffFile。
// 只在 dev 的 fidelity 入口使用，不進正式包。
import type { DiffFile } from "@/lib/tauri";
import { file, type RawHunk } from "./fixture";

/** 基準的檔案格式（fileHTML 吃的那種） */
interface RefFile {
  p: string;
  s: "M" | "A" | "D" | "R";
  hunks: RawHunk[];
  binary?: boolean;
  tooLarge?: boolean;
  omitted?: DiffFile["omitted"];
}

const STATUS = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed" } as const;

/** 基準格式 → 後端的 DiffFile（行號與行數照 fixture 的 file() 算）。超過 10 MB 的檔後端回 binary = false
 *  （classify_blob_flags：libgit2 對大檔也設 BINARY，後端讓 too_large 優先），基準的示範資料兩個都標了 */
export function fromRef(f: RefFile): DiffFile {
  const tooLarge = !!f.tooLarge;
  return { ...file(f.p, STATUS[f.s], f.hunks), binary: !!f.binary && !tooLarge, too_large: tooLarge, omitted: f.omitted ?? null };
}

const convert = (diffs: Record<string, RefFile[]>) =>
  Object.fromEntries(Object.entries(diffs).map(([id, files]) => [id, files.map(fromRef)]));

const YOUNG_DIFFS: Record<string, RefFile[]> = {
  // a template literal over three lines (review decision A, 2026-10-12): its first line is a string to the end of the
  // line, the line inside it is code that knows nothing of it, its last line is the closing backtick's string
  b41c7e2: [{ p: "src/main.ts", s: "M", hunks: [{ o: 1, n: 1, ctx: "", lines: [
    " import { invoke } from \"@tauri-apps/api/core\";",
    " ",
    "-console.log(\"kira-new\");",
    "+const commits = await invoke<string[]>(\"list_commits\", { path: \".\" });",
    "+const banner = `Kira",
    "+  ${commits.length} commits on main",
    "+`;",
    "+console.log(banner);",
  ] }] },
  // a line of JSX text holding an expression is not a line of text (Q-H3), so its apostrophe opens a string that runs
  // to the end of the line: here to be seen
  { p: "src/App.tsx", s: "A", hunks: [{ o: 0, n: 1, ctx: "", lines: [
    "+export function App({ branch, commits }: Props) {",
    "+  return (",
    "+    <main>",
    "+      <h1>kira-new</h1>",
    "+      <p>You're in {branch} with {commits.length} new commits</p>",
    "+    </main>",
    "+  );",
    "+}",
  ] }] }],
  "5e0d9a3": [{ p: "README.md", s: "A", hunks: [{ o: 0, n: 1, ctx: "", lines: [
    "+# kira-new", "+", "+A small repository to try Kira on.", "+Run it with `npm run tauri dev` (needs Rust).",
  ] }] }],
  a17f3c0: [{ p: "src/main.ts", s: "A", hunks: [{ o: 0, n: 1, ctx: "", lines: [
    "+import { invoke } from \"@tauri-apps/api/core\";",
    "+",
    "+console.log(\"kira-new\");",
  ] }] }],
};

const ROUTES_DIFFS: Record<string, RefFile[]> = {
  "3fa2c71": [{ p: "src/search/rank.ts", s: "M", hunks: [{ o: 8, n: 8, ctx: "export function rank(", lines: [
    "   const hits = notes.filter((n) => matches(n.title, query));",
    "-  return hits.sort((a, b) => a.title.localeCompare(b.title));",
    "+  // the note you opened last is most likely the one you are after",
    "+  return hits.sort((a, b) => b.openedAt - a.openedAt);",
    " }",
  ] }] }],
  b6d0e94: [{ p: "src/notes/pin.ts", s: "A", hunks: [{ o: 0, n: 1, ctx: "", lines: [
    "+import type { Note } from \"./note\";",
    "+",
    "+export function pinned(notes: Note[]): Note[] {",
    "+  return [...notes.filter((n) => n.pinned), ...notes.filter((n) => !n.pinned)];",
    "+}",
  ] }] }],
  "58c1a3f": [{ p: "src/map/Legend.tsx", s: "A", hunks: [{ o: 0, n: 1, ctx: "", lines: [
    "+export function Legend({ layers }: { layers: Layer[] }) {",
    "+  return (",
    "+    <ul className=\"legend\">",
    "+      {layers.map((l) => <li key={l.id}>{l.name}</li>)}",
    "+    </ul>",
    "+  );",
    "+}",
  ] }] }],
};

// a minified bundle's single line, n characters long: built here, since a 62,000-character line would bury the source
function minified(seed: number, n: number): string {
  const ids = "etnrsaoilcdu";
  let s = '!function(){"use strict";', k = seed;
  while (s.length < n) { k++; const a = ids[k % 12], b = ids[(k * 7) % 12]; s += `var ${a}${k % 97}=function(${a},${b}){return ${a}&&${b}.call(this,${a},${k % 31})},`; }
  return s.slice(0, n);
}

// the merge of #36 at the display limit (B1), files in path order as the backend sends them: two built bundles
// of one long line each use up most of the 256K characters, so the notes after them no longer fit (Total) while
// the small files after the notes still do; the lock file is over 2,000 lines on its own (File). The film is over
// 10 MB (libgit2 skips it), the icon is binary, the release script only changed its mode, and the capability
// file only gained its newline at the end
const LIMITS = (): RefFile[] => [
  { p: "dist/assets/index-4c6dafd.js", s: "M", hunks: [{ o: 1, n: 1, ctx: "", lines: [`-${minified(1, 61900)}`, `+${minified(2, 62010)}`] }] },
  { p: "dist/assets/vendor-9a58413.js", s: "M", hunks: [{ o: 1, n: 1, ctx: "", lines: [`-${minified(3, 61200)}`, `+${minified(4, 61350)}`] }] },
  { p: "docs/demo/kira v8.mov", s: "A", tooLarge: true, binary: true, hunks: [] },
  { p: "docs/notes/v8 port [draft].md", s: "A", omitted: { reason: "Total", lines: 812, bytes: 42188 }, hunks: [] },
  { p: "package-lock.json", s: "M", omitted: { reason: "File", lines: 3412, bytes: 143566 }, hunks: [] },
  { p: "scripts/release.sh", s: "M", hunks: [] },
  // only gains its newline at the end: git's note sits under the line it is about (libgit2's hunk for this file)
  { p: "src-tauri/capabilities/default.json", s: "M", hunks: [{ o: 13, n: 13, ctx: "", lines: [
    "       ]",
    "     }",
    "   ]",
    "-}",
    "\\ No newline at end of file",
    "+}",
  ] }] },
  { p: "src-tauri/icons/icon.icns", s: "M", binary: true, hunks: [] },
  { p: "src/components/Graph/RouteLayer.tsx", s: "R", hunks: [{ o: 1, n: 1, ctx: "", lines: [
    " import { memo } from \"react\";",
    "-import type { LayoutEdge } from \"@/lib/graphLayout\";",
    "+import type { Track } from \"@/lib/routeMap\";",
    " ",
    "-export const GraphCanvas = memo(function GraphCanvas({ edges }: { edges: LayoutEdge[] }) {",
    "+export const RouteLayer = memo(function RouteLayer({ tracks }: { tracks: Track[] }) {",
  ] }] },
];

// a commit that touches more than 500 files: the backend sends the first 500 in path order and says so
const LOCALES = "ar bg cs da de el es fi fr he hu id it ja ko nl no pl pt ro ru sv th tr uk".split(" ");
const NAMESPACES = "app branches changes clone commit dialogs diff errors graph home menu notices prs pull push recent settings sign-in staging toolbar".split(" ");

// a fix that hides what it does with bidirectional controls (Phase 5 Q-T, Trojan Source's stretched string): obeyed,
// the new if reads as a check on the role and a comment; it is one string, so every caller deletes main. The
// function line above it carries a pair of isolates, so the hunk header has controls to name too. The binary
// beside it hides its name the old way: obeyed, scripts/setup<RLO>hs.exe reads as scripts/setupexe.sh. The log
// line holds a bare carriage return: through innerHTML it would read as two lines (review, 2026-10-11)
const BIDI_DIFF = (): RefFile[] => [{ p: "scripts/setup\u202ehs.exe", s: "A", binary: true, hunks: [] },
  { p: "src/lib/github.ts", s: "M", hunks: [{ o: 40, n: 40,
  ctx: "export async function refetchPRs(repo: Repo) { // \u2066readers wait\u2069", lines: [
    "   const role = await getRole(repo);",
    "-  await listPRs(repo);",
    "+  if (role != \"reader\u202e \u2066// Check if owner\u2069 \u2066\") {",
    "+    await deleteBranch(repo, \"main\");",
    "+    log(\"deleted\r\");",
    "+    log(\"split\u2028line\");",
    "+  }",
    "+  await listPRs(repo);",
    " }",
  ] }] }];

const MANY = (): RefFile[] => LOCALES.flatMap((l) => NAMESPACES.map((ns) => ({ p: `src/i18n/${l}/${ns}.json`, s: "M", hunks: [{ o: 3, n: 3, ctx: "", lines: [
  `   "title": "${ns}",`, `-  "refresh": "Refresh",`, `+  "refresh": "Reload",`, ` }`,
] }] })));

export const youngDiffs = () => convert(YOUNG_DIFFS);
export const routesDiffs = () => convert(ROUTES_DIFFS);
export const limitsDiff = () => LIMITS().map(fromRef);
export const manyDiff = () => MANY().map(fromRef);
export const bidiDiff = () => BIDI_DIFF().map(fromRef);
