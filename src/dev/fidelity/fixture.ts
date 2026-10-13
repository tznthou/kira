// v8 複刻比對用的 fixture：內容與 mockup/v8-kirazuri-lines-sys.html 的 demo 資料逐筆對齊，
// 排序與格式則依真實後端語意（分支依 ref 名字母序、status 依路徑排序、近期清單依開啟時間、
// PR 依建立時間新到舊）。兩邊不一致時改的是 mockup，不是這裡 —— 否則比對會過，真實 app 卻做不到。
//
// 只在 dev 的 fidelity.html 入口使用，不進正式包。
import type {
  AheadBehindInfo,
  AuthStatus,
  BranchRef,
  BranchStats,
  CommitNode,
  DiffFile,
  DiffLine,
  GraphData,
  ListBranchesResult,
  PullRequestInfo,
  RecentRepo,
  RepoInfo,
  TagRef,
  WorkingTreeStatus,
} from "@/lib/tauri";

/** 中性的家目錄：公開 repo 不放真實使用者路徑。畫面顯示的 `~/Documents/kira` 與 mockup 相同。 */
export const HOME = "/Users/kira";
export const REPO_PATH = `${HOME}/Documents/kira`;
export const REPO_ID = "fixture-kira";

/** 截圖時凍結的「現在」：PR 的 "2h ago" 等相對時間由它推算。14:31 = 基準自己的時鐘（新 commit 的時刻），
 *  `prs-rate` 的「Try again after 14:32」才在它之後（Phase 5 Q-R；原本 16:30，重置時刻變成已過） */
export const NOW = Date.parse("2026-10-03T14:31:00+08:00");

// mockup 的 tooltip 完整 oid 是「7 碼 id + 固定假尾碼」，照抄 tooltip 才會一樣
const OID_TAIL = "5f0a3c9e1b2d48a7c6e0f9d3b1a24e8c07".slice(0, 33);
export const full = (id: string) => id + OID_TAIL;

export const AUTHOR = { name: "tznthou", email: "tznthou@users.noreply.github.com" };

/** mockup 的時間字串一律以台北時間解讀 */
export function unix(t: string): number {
  return Math.floor(Date.parse(`${t.replace(/\//g, "-").replace(" ", "T")}:00+08:00`) / 1000);
}

const HEAD_BRANCH = "feat/t15g-graph-density";

// [短 hash, subject, parents, 時間] —— 順序即 revwalk 順序（新到舊）
const LOG: Array<[string, string, string[], string]> = [
  ["c9e41f2", "feat(t15g): scale lane gutter to container width before the subject column", ["7b03d5e"], "2026/10/03 14:22"],
  ["e81d6b0", "fix(toolbar): give Refresh a fixed min-width so the toolbar stops shifting", ["63421cf"], "2026/10/03 11:05"],
  ["7b03d5e", "refactor(graph): extract the lane-width budget into layout constants", ["4f2a9c1"], "2026/10/02 22:41"],
  ["4f2a9c1", "test(graph): add a 17-lane density fixture from react history", ["dd9ba36"], "2026/10/02 21:10"],
  ["dd9ba36", "docs: backfill README history for 05-21 and 07-30", ["63421cf"], "2026/07/30 23:58"],
  ["63421cf", "Merge pull request #36 from tznthou/feat/t15f-motion", ["314e219", "4c6dafd"], "2026/07/30 22:31"],
  ["4c6dafd", "docs: correct outdated stack and animation claims after t15f", ["9a58413"], "2026/07/30 22:12"],
  ["9a58413", "chore: apply review findings — 2 items", ["4f709e5"], "2026/07/30 21:40"],
  ["4f709e5", "feat(t15f): add restrained motion for tab entry and list hover", ["314e219"], "2026/07/30 19:03"],
  ["314e219", "Merge pull request #34 from tznthou/feat/t15e-graph-layout", ["e255b9c", "9a70f3f"], "2026/07/29 23:20"],
  ["9a70f3f", "chore: apply review findings — 10 items", ["9b08a69"], "2026/07/29 22:48"],
  ["9b08a69", "feat(graph): surface commit history truncation to the UI", ["9d9dfb1"], "2026/07/29 21:15"],
  ["9d9dfb1", "refactor(staging): use shared ErrorBanner for conflict notice", ["932c96b"], "2026/07/29 20:02"],
  ["932c96b", "fix(diff): reserve space for macOS overlay scrollbar", ["357dfda"], "2026/07/29 18:37"],
  ["357dfda", "fix(pr): refetch pull requests on toolbar refresh", ["7e42383"], "2026/07/29 17:20"],
  ["7e42383", "feat(graph): right-align ref pills to the container edge", ["de312e2"], "2026/07/29 15:54"],
  ["de312e2", "fix(graph): recycle lane indices after branch merge", ["e255b9c"], "2026/07/29 14:09"],
  ["e255b9c", "docs: update README status table + CHANGELOG for T15 visual polish", ["7c90e13"], "2026/06/08 23:10"],
  ["7c90e13", "Merge pull request #32 from tznthou/feat/t15d-theme-parity", ["a592721", "1fd83dc"], "2026/06/08 22:04"],
  ["1fd83dc", "feat(t15d): theme parity — graph-specific tokens for ink/paper balance", ["a592721"], "2026/06/08 21:30"],
  ["a592721", "Merge pull request #31 from tznthou/feat/t15b-graph-craft", ["86023a3", "561874d"], "2026/06/08 19:46"],
  ["561874d", "feat(t15b): graph craft — bullseye nodes, pill ref labels, layout fixes", ["86023a3"], "2026/06/08 18:12"],
  ["86023a3", "Merge pull request #30 from tznthou/feat/t15c-state-design", ["ef4e8b9", "0f108fd"], "2026/06/08 16:30"],
];

// 分支：libgit2 的列舉是 loose ref（依名稱）接 packed ref，不是整體字母序；側欄與 graph 由前端自己排
// （routeMap.byName，本機在前、遠端在後）。這裡照排好的順序寫，只是好讀
// feat/t9d-watcher（0b P5 / Phase 5 5a）：舊分支，它與它的 upstream 的 tip 都早於這 23 筆——在側欄、不在圖上
// （決策 C）。本機一筆沒推、origin 兩筆沒拉（↑1 ↓2），所以兩個 tip 是不同的 commit；都不在 LOG 裡
const BRANCHES: Array<[name: string, target: string, isRemote: boolean]> = [
  ["feat/t15g-graph-density", "c9e41f2", false],
  ["feat/t9d-watcher", "5a1c3e8", false],
  ["fix/toolbar-jump", "e81d6b0", false],
  ["main", "dd9ba36", false],
  ["origin/feat/t15e-graph-layout", "9a70f3f", true],
  ["origin/feat/t15f-motion", "4c6dafd", true],
  ["origin/feat/t15g-graph-density", "4f2a9c1", true],
  ["origin/feat/t9d-watcher", "a8f30c6", true],
  ["origin/fix/toolbar-jump", "e81d6b0", true],
  ["origin/main", "dd9ba36", true],
];
const TAGS: Array<[name: string, target: string]> = [["v0.1.0-rc.1", "dd9ba36"]];

function buildGraph(): GraphData {
  const branches: BranchRef[] = BRANCHES.map(([name, target, is_remote]) => ({
    name,
    target: full(target),
    is_remote,
    // 實機 fixture repo：三條 local 都追蹤 origin 的同名分支；remote 在遠端上的名字 = 去掉 origin/
    upstream: is_remote ? null : `origin/${name}`,
    name_on_remote: is_remote ? name.replace(/^origin\//, "") : null,
  }));
  const headTip = BRANCHES.find(([name, , isRemote]) => name === HEAD_BRANCH && !isRemote)?.[1];
  const tags: TagRef[] = TAGS.map(([name, target]) => ({ name, target: full(target) }));
  const commits: CommitNode[] = LOG.map(([id, message, parents, t]) => ({
    oid: id,
    full_oid: full(id),
    message,
    author: { ...AUTHOR, timestamp: unix(t) },
    parents: parents.map(full),
    // 後端 build_ref_map：先分支（含遠端）後 tag，名稱即 shorthand
    refs: [
      ...BRANCHES.filter(([, target]) => target === id).map(([name]) => name),
      ...TAGS.filter(([, target]) => target === id).map(([name]) => name),
    ],
  }));
  // mockup 只畫到 86023a3；它的兩個 parent 不在清單內：依真後端的語意這就是截斷（取滿上限、後面還有），
  // 畫面上延伸到底的線在最後一列下方淡出，接頁尾（基準 0b P4 起的預設）
  return {
    commits,
    branches,
    tags,
    truncated: true,
    head: { oid: headTip ? full(headTip) : null, branch: HEAD_BRANCH },
    default_branch: "main",
  };
}

export const graph: GraphData = buildGraph();

export const repoInfo: RepoInfo = {
  path: REPO_PATH,
  head_branch: HEAD_BRANCH,
  branches: BRANCHES.map(([name, target, is_remote]) => ({ name, oid: full(target), is_remote })),
  remotes: ["origin"],
};

export const listBranches: ListBranchesResult = {
  branches: BRANCHES.map(([name, , is_remote]) => ({
    name,
    is_current: name === HEAD_BRANCH,
    is_remote,
    upstream: is_remote ? null : { name: `origin/${name}`, tracking_ref_exists: true },
  })),
  detached_head_oid: null,
};

export const branchStats: Record<string, BranchStats> = {
  "feat/t15g-graph-density": { ahead: 2, behind: 0 },
  "feat/t9d-watcher": { ahead: 1, behind: 2 },
  "fix/toolbar-jump": { ahead: 0, behind: 0 },
  main: { ahead: 0, behind: 0 },
};

export const aheadBehind: AheadBehindInfo = {
  ahead: 2,
  behind: 0,
  has_upstream: true,
  tracking_ref_exists: true,
  upstream_remote: "origin",
  upstream_branch: HEAD_BRANCH,
};

/** libgit2 status 依路徑排序 */
export const status: WorkingTreeStatus = {
  staged: [
    { path: "src/components/CommitGraph/GraphCanvas.tsx", status: "Modified" },
    { path: "src/lib/graphLayout.ts", status: "Modified" },
  ],
  unstaged: [
    { path: "docs/PLAN.md", status: "Modified" },
    { path: "src/components/CommitGraph/CommitNode.tsx", status: "Modified" },
    { path: "src/tests/laneGutter.test.ts", status: "New" },
  ],
  conflicted: [],
  unstaged_truncated: false,
};

/** 後端 open 時把 repo 插到最前面：時間單調遞減 */
export const recentRepos: RecentRepo[] = [
  { path: REPO_PATH, last_opened: unix("2026/10/03 09:12") },
  { path: `${HOME}/Documents/kira-smoke/work`, last_opened: unix("2026/07/30 20:41") },
  { path: `${HOME}/Documents/kira-smoke/react`, last_opened: unix("2026/07/29 22:05") },
  { path: `${HOME}/Documents/BlueprintBuddy`, last_opened: unix("2026/07/28 18:30") },
];

export const auth: AuthStatus = { authenticated: true, username: "tznthou" };

const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

/** GitHub list PRs 未帶 sort → 依建立時間新到舊（編號大的在前；編號即建立先後） */
export const prs: PullRequestInfo[] = [
  {
    number: 39,
    title: "chore(deps): pin tauri to the version resolved in Cargo.lock",
    state: "open",
    author: "tznthou",
    created_at: hoursAgo(84),
    updated_at: hoursAgo(77),
    // 這個 PR 的 head 不在任何 ref 上 → 沒有路線圓標（mockup 同）
    head_sha: "3b8d0e6a1f2c4d5e6f708192a3b4c5d6e7f80912",
    html_url: "https://github.com/tznthou/kira/pull/39",
    draft: false,
    review_state: "changes_requested",
    check_status: "failure",
  },
  {
    number: 38,
    title: "Give Refresh a fixed min-width so the toolbar stops shifting",
    state: "open",
    author: "tznthou",
    created_at: hoursAgo(120),
    updated_at: hoursAgo(2.1),
    head_sha: full("e81d6b0"),
    html_url: "https://github.com/tznthou/kira/pull/38",
    draft: false,
    review_state: "approved",
    check_status: "pending",
  },
  {
    number: 37,
    title: "T15g: adaptive lane gutter for dense histories",
    state: "open",
    author: "tznthou",
    created_at: hoursAgo(144),
    updated_at: hoursAgo(26),
    head_sha: full("4f2a9c1"),
    html_url: "https://github.com/tznthou/kira/pull/37",
    draft: true,
    review_state: null,
    check_status: "success",
  },
];

// ---- diff ----

/** 同 mockup 的 `{ o, n, ctx, lines }`；ctx = 後端 `DiffHunk.context`（c9e41f2 的是 fixture repo 真後端給的） */
export type RawHunk = { o: number; n: number; ctx: string; lines: string[] };

/** 依 mockup 的 fileHTML 規則算行號：context 兩邊都 +1、`+` 只動新側、`-` 只動舊側。`\` 開頭的是 git 的
 *  「\ No newline at end of file」，照 libgit2 實際送的樣子（Phase 5 Q-N，實測）：origin 看上一行（`-` → `>`、
 *  `+` → `<`、context → `=`），內容開頭帶一個換行，行號沿用上一行，不算進行數 */
export function file(path: string, status: DiffFile["status"], hunks: RawHunk[]): DiffFile {
  return {
    path,
    status,
    binary: false,
    too_large: false,
    omitted: null,
    hunks: hunks.map(({ o, n, ctx, lines }) => {
      let oldNo = o;
      let newNo = n;
      let oldCount = 0;
      let newCount = 0;
      const out: DiffLine[] = [];
      for (const raw of lines) {
        const origin = raw[0];
        const content = raw.slice(1);
        const prev = out.at(-1);
        if (origin === "\\") {
          const marker = prev?.origin === "-" ? ">" : prev?.origin === "+" ? "<" : "=";
          out.push({ origin: marker, content: `\n${raw}`, old_lineno: prev?.old_lineno ?? null, new_lineno: prev?.new_lineno ?? null });
        } else if (origin === "+") {
          newCount++;
          out.push({ origin, content, old_lineno: null, new_lineno: newNo++ });
        } else if (origin === "-") {
          oldCount++;
          out.push({ origin, content, old_lineno: oldNo++, new_lineno: null });
        } else {
          oldCount++;
          newCount++;
          out.push({ origin: " ", content, old_lineno: oldNo++, new_lineno: newNo++ });
        }
      }
      return { old_start: o, old_lines: oldCount, new_start: n, new_lines: newCount, context: ctx, lines: out };
    }),
  };
}

export const DIFFS: Record<string, DiffFile[]> = {
  c9e41f2: [
    file("src/components/CommitGraph/constants.ts", "Modified", [{ o: 13, n: 13, ctx: "export const HASH_COL_WIDTH = 60;", lines: [
      "  *  否則文字截斷長度與欄位寬度會對不上。 */",
      " export const SUBJECT_TEXT_WIDTH = 320;",
      " ",
      "+/** lane 區最多吃容器寬度的比例；超過就壓縮 lane 間距，",
      "+ *  訊息欄寬度維持 SUBJECT_TEXT_WIDTH 不被擠掉。 */",
      "+export const LANE_GUTTER_MAX_RATIO = 0.38;",
      "+",
      " /** subject 文字截斷字數。見 SUBJECT_TEXT_WIDTH 的耦合說明。 */",
      " export const SUBJECT_MAX_CHARS = 50;",
    ] }]),
    file("src/lib/graphLayout.ts", "Modified", [{ o: 112, n: 112, ctx: "export function computeLayout(", lines: [
      "   const maxLane = Math.max(0, ...nodes.map((n) => n.x));",
      "   const edges = buildEdges(nodes);",
      "-  return { nodes, edges, maxLane };",
      "+  const gutter = Math.min(",
      "+    (maxLane + 1) * CELL_WIDTH,",
      "+    containerWidth * LANE_GUTTER_MAX_RATIO,",
      "+  );",
      "+  const cellWidth = gutter / (maxLane + 1);",
      "+  return { nodes, edges, maxLane, cellWidth };",
      " }",
    ] }]),
  ],
  e81d6b0: [
    file("src/App.tsx", "Modified", [{ o: 301, n: 301, ctx: "function App() {", lines: [
      "           <button",
      "             onClick={() => void handleRefresh({ refreshPRs: true })}",
      "             disabled={refreshing || pushPullOp !== null}",
      "-            className=\"px-3 py-1 text-sm bg-surface-2 hover:bg-surface-3 disabled:bg-surface-1 disabled:cursor-not-allowed rounded\"",
      "+            className=\"min-w-[6.75rem] px-3 py-1 text-sm bg-surface-2 hover:bg-surface-3 disabled:bg-surface-1 disabled:cursor-not-allowed rounded transition-colors duration-100 ease-out\"",
      "           >",
      "             {refreshing ? \"Refreshing...\" : \"Refresh\"}",
      "           </button>",
    ] }]),
    file("src/components/ui/Button.tsx", "Modified", [{ o: 31, n: 31, ctx: "export const Button = forwardRef<HTMLButtonElement, ButtonProps>(", lines: [
      "     ref,",
      "   ) {",
      "     const classes = cn(",
      "-      \"rounded disabled:cursor-not-allowed transition-colors\",",
      "+      \"rounded disabled:cursor-not-allowed transition-colors duration-100 ease-out\",",
      "       variantClasses[variant],",
      "       sizeClasses[size],",
    ] }]),
  ],
  "7b03d5e": [
    file("src/lib/graphLayout.ts", "Modified", [{ o: 4, n: 4, ctx: "import type { CommitNode } from \"./tauri\";", lines: [
      " import { getBranchColor } from \"./branchColors\";",
      "-const CELL_WIDTH = 24;",
      "+import { CELL_WIDTH, LANE_GUTTER_MAX_RATIO } from \"../components/CommitGraph/constants\";",
      " ",
      " export interface LayoutNode {",
    ] }]),
    file("src/tests/graphDensity.test.ts", "Added", [{ o: 0, n: 1, ctx: "", lines: [
      "+import { describe, expect, it } from \"vitest\";",
      "+import { computeLayout } from \"@/lib/graphLayout\";",
      "+import reactDense from \"./fixtures/react-17-lanes.json\";",
      "+",
      "+describe(\"lane gutter budget\", () => {",
      "+  it(\"keeps the subject column on screen at 17 lanes\", () => {",
      "+    const layout = computeLayout(reactDense, { containerWidth: 722 });",
      "+    expect(layout.cellWidth * 18).toBeLessThanOrEqual(722 * 0.38);",
      "+  });",
      "+});",
    ] }]),
  ],
};

/** mockup：沒有專屬 diff 的 commit 依列序輪流借用三組 diff（routes 換成它自己的三組，見 states.ts） */
export const ROTATION = ["c9e41f2", "e81d6b0", "7b03d5e"];

/** 每筆 PR 展開後的檔（github_get_pr_diff）：全部的檔（D11；基準的 pr.diff 指向同一份 diffs） */
export const PR_DIFFS: Record<number, DiffFile[]> = {
  39: DIFFS["7b03d5e"],
  38: DIFFS.e81d6b0,
  37: DIFFS.c9e41f2,
};
