// fidelity 入口的 ?on= 與 ?state=：照基準的 checkout() / applyState()（mockup/v8-kirazuri-lines-sys.html），
// 把 fixture 轉成「真後端在那個狀態下會回的資料」。只管資料；提示、帳號選單、連線中這類畫面狀態
// 由入口在開機後設定（v8 Phase 3 計畫 step 7）。
//
// 基準只改它畫得到的東西：落後 / 分岔只改計數，不畫遠端多出來的 commit——3b 只比 topbar，這裡照做。
// graph 的狀態（Phase 4）：線 / 欄 / 字母 / 顏色由 computeRoutes 算，資料與 mockup/tools/routes/state_routes.mjs
// 打的補丁相同（基準的手寫值也是照它填的），訊息文字照基準。
//
// 只在 dev 的 fidelity 入口與測試使用，不進正式包。
import type {
  AheadBehindInfo,
  AuthStatus,
  BranchRef,
  BranchStats,
  CommitNode,
  DiffFile,
  DiffResult,
  GraphData,
  ListBranchesResult,
  PullRequestInfo,
  RecentRepo,
  RepoInfo,
  WorkingTreeStatus,
} from "@/lib/tauri";
import { byName } from "@/lib/routeMap";
import * as fx from "./fixture";
import { bidiDiff, fromRef, limitsDiff, manyDiff, routesDiffs, youngDiffs } from "./diffs";

export interface FixtureData {
  graph: GraphData;
  repoInfo: RepoInfo;
  listBranches: ListBranchesResult;
  branchStats: Record<string, BranchStats>;
  aheadBehind: AheadBehindInfo;
  auth: AuthStatus;
  /** 開機時的 working tree（stage 操作改的是假後端裡的副本） */
  status: WorkingTreeStatus;
  /** 首頁的近期清單；開機點的是 `repoInfo.path` 那一項 */
  recentRepos: RecentRepo[];
  /** 永不回應的指令：loading = graph 還沒回來、其餘已回來；opening = 剛開，什麼都還沒回來 */
  pending: string[];
  /** 預期的 IPC 錯誤：假後端讓這個指令回錯 times 次（後端的錯誤形狀）。走真實錯誤路徑的狀態會
   *  console.error，入口拿這本帳對：對得上的不算錯，帳外的、沒用完的照樣 FAIL（Phase 5 5a step 10，Codex #4） */
  failures: ExpectedFailure[];
  /** 各 commit 的 diff（短 oid → 檔）；沒有的依列序輪流借 diffRotation 的（同基準 renderDiff） */
  diffs: Record<string, DiffFile[]>;
  diffRotation: string[];
  /** 檔數被截斷（後端只送前 500 個）的 commit */
  diffCut: string[];
  /** 開機後選的站（短 oid）：基準的 diff 狀態選非 HEAD 的 commit；null = 照 app，開 repo 選 HEAD */
  select: string | null;
  /** 開著的 PR（github_get_prs；沒有 GitHub remote、未登入時假後端照後端的順序回錯，不看這裡） */
  prs: PullRequestInfo[];
  /** 每筆 PR 展開後的檔（github_get_pr_diff，全部的檔） */
  prDiffs: Record<number, DiffFile[]>;
}

/** 假後端 git_get_diff 的回應：這一份資料裡那個 commit 的 diff（同基準 renderDiff 的取法） */
export function diffOf(d: FixtureData, fullOid: string): DiffResult {
  const id = fullOid.slice(0, 7);
  const index = Math.max(0, d.graph.commits.findIndex((c) => c.oid === id));
  const files = d.diffs[id] ?? d.diffs[d.diffRotation[index % d.diffRotation.length]];
  return { files: structuredClone(files), truncated: d.diffCut.includes(id) };
}

export interface ExpectedFailure {
  cmd: string;
  /** 後端錯誤的形狀；RATE_LIMITED 多帶 reset_at（5c step 1） */
  error: { code: string; message: string; reset_at?: number | null };
  times: number;
  /** app 在這條錯誤路徑不把錯誤物件交給 console.error 時，它印的那一行（入口拿來精確比對）。
   *  getDiff / getPRs / getPRDiff 只印錯誤碼：IPC 錯誤物件不進 console（5 月安全檢查 M01） */
  log?: string;
  /** app 在這條路什麼都不記（PR 太大是這個 PR 的事實，不是失敗）：帳本要它丟了、但沒被記 */
  silent?: boolean;
}

/** 只改畫面、資料同預設的狀態 */
const VIEW_STATES = new Set([
  "account-menu",
  "error-push",
  "error-pull",
  "error-refresh",
  "error-open",
  "error-signout",
  "error-checkout",
  "error-commit",
]);

/** 後端 KiraError::Git 序列化後的樣子（error.rs：訊息一律遮蔽） */
const GIT_ERROR = { code: "GIT_ERROR", message: "git operation failed" };
/** GitHub 那邊讀不到（github.rs：reqwest 的錯誤一律 NETWORK_ERROR） */
const NETWORK_ERROR = { code: "NETWORK_ERROR", message: "network error" };

/** 基準 many-changes 的 4,999 個 chunk 檔名（同一個雜湊，兩邊的路徑才一樣） */
function hexAt(i: number, len = 8): string {
  let x = Math.imul(i + 1, 2654435761) >>> 0;
  let s = "";
  while (s.length < len) {
    x = Math.imul(x ^ (x >>> 15), 2246822519) >>> 0;
    s += x.toString(16).padStart(8, "0");
  }
  return s.slice(0, len);
}

/** 後端每次讀 status 都依路徑排序（libgit2） */
const byPath = <T extends { path: string }>(list: T[]): T[] =>
  [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

/** 基準的 detach("7b03d5e")：HEAD 離開分支，停在 t15g 線上的一站 */
const DETACH_AT = "7b03d5e";

/** 沒有 upstream 的分支：後端 compute_stats 的降級值 */
const NO_STATS: BranchStats = { ahead: null, behind: null };

/** 後端 ahead_behind 的 no_upstream（沒 upstream、detached、unborn） */
const NO_UPSTREAM: AheadBehindInfo = {
  ahead: 0,
  behind: 0,
  has_upstream: false,
  tracking_ref_exists: false,
  upstream_remote: null,
  upstream_branch: null,
};

/** "origin/feat/x" → origin + feat/x。後端讀的是 branch.<name>.remote / merge；fixture 的追蹤分支一律
 *  照預設 refspec 命名（前綴就是 remote 名），所以從名字拆得回來 */
function upstreamLocation(upstream: string | null): Pick<AheadBehindInfo, "upstream_remote" | "upstream_branch"> {
  const at = upstream?.indexOf("/") ?? -1;
  return upstream && at > 0
    ? { upstream_remote: upstream.slice(0, at), upstream_branch: upstream.slice(at + 1) }
    : { upstream_remote: null, upstream_branch: null };
}

/** 先依序套 `states`，再套 `on`（同基準：狀態加進來的分支也切得過去，例如 lodger 的 release/0.1）。
 *  不認得的名字直接丟錯——拼錯的參數靜默套成預設，截圖會「看起來正常」。 */
export function fixtureFor(on: string | null, states: readonly string[]): FixtureData {
  const d: FixtureData = structuredClone({
    graph: fx.graph,
    repoInfo: fx.repoInfo,
    listBranches: fx.listBranches,
    branchStats: fx.branchStats,
    aheadBehind: fx.aheadBehind,
    auth: fx.auth,
    status: fx.status,
    recentRepos: fx.recentRepos,
    pending: [],
    failures: [],
    diffs: fx.DIFFS,
    diffRotation: fx.ROTATION,
    diffCut: [],
    select: null,
    prs: fx.prs,
    prDiffs: fx.PR_DIFFS,
  });
  for (const state of states) apply(d, state);
  if (on) checkout(d, on);
  return d;
}

function checkout(d: FixtureData, name: string): void {
  const target = d.graph.branches.find((b) => b.name === name && !b.is_remote);
  if (!target) throw new Error(`fidelity: no local branch "${name}"`);
  d.graph.head = { oid: target.target, branch: name };
  d.repoInfo.head_branch = name;
  for (const b of d.listBranches.branches) b.is_current = !b.is_remote && b.name === name;
  d.listBranches.detached_head_oid = null;
  const stats = d.branchStats[name];
  d.aheadBehind = {
    ahead: stats?.ahead ?? 0,
    behind: stats?.behind ?? 0,
    has_upstream: target.upstream !== null,
    // 同後端：upstream 有設定、而且遠端追蹤分支還在
    tracking_ref_exists:
      target.upstream !== null && d.graph.branches.some((b) => b.is_remote && b.name === target.upstream),
    ...upstreamLocation(target.upstream),
  };
}

function apply(d: FixtureData, state: string): void {
  const current = d.repoInfo.head_branch;
  switch (state) {
    case "behind":
      return setSync(d, current, 0, 3);
    case "diverged":
      return setSync(d, current, d.aheadBehind.ahead, 3);
    case "no-upstream":
      if (!current) throw new Error("fidelity: no-upstream needs a branch checked out");
      dropRemotes(d, `origin/${current}`);
      return clearUpstream(d, current);
    case "no-remote":
      dropRemotes(d, null);
      clearUpstream(d, null);
      d.repoInfo.remotes = [];
      // <remote>/HEAD 跟著遠端一起沒了
      d.graph.default_branch = null;
      return;
    case "detached":
      return detach(d);
    case "signed-out":
    case "connecting":
    case "error-auth":
      // connecting 是未登入後按了 Connect；error-auth 是連線失敗後回到未登入（同基準）
      d.auth = { authenticated: false, username: null };
      return;
    // ---- graph 的狀態（Phase 4，基準 applyState） ----
    case "loading":
      d.pending.push("git_get_graph");
      return;
    case "empty":
      return empty(d);
    case "young":
      return young(d);
    case "routes":
      routes(d);
      // fieldbook 的 origin 在 GitHub 上，沒有開著的 PR（基準 panel.prs = "empty"）
      d.prs = [];
      return;
    case "new-branch":
      return newBranch(d);
    case "head-beyond":
      return headBeyond(d);
    case "lodger":
      return lodger(d);
    case "long-refs":
      return longRefs(d);
    // ---- 側欄的狀態（Phase 5 5a，基準 0b P5 的 applyState） ----
    case "opening":
      // 剛開：graph、分支、status、ahead/behind、PR 清單都還沒回來
      d.pending.push("git_get_graph", "git_list_branches", "git_get_status", "git_get_ahead_behind", "github_get_prs");
      return;
    case "pruned":
      return pruned(d);
    case "branches-error":
      // 開 repo 時讀不到分支清單（Q-B）
      d.failures.push({ cmd: "git_list_branches", error: GIT_ERROR, times: 1 });
      return;
    // ---- diff 區的狀態（Phase 5 5b，基準 0b P5 的 applyState） ----
    case "diff-empty":
      // 第一個 parent 跟它沒有差異的 commit（E2）
      d.diffs.dd9ba36 = [];
      d.select = "dd9ba36";
      return;
    case "diff-error":
      // HEAD 的 diff 讀不到（Retry 之後讀得到）
      d.failures.push({ cmd: "git_get_diff", error: GIT_ERROR, times: 1, log: "[kira] getDiff failed: GIT_ERROR" });
      return;
    case "diff-limits":
      d.diffs["63421cf"] = limitsDiff();
      // 一個 parent 的 commit 也收合一個 lock 檔：點它看得到沒有 -m --first-parent 的指令
      d.diffs.c9e41f2 = [
        fromRef({ p: "src-tauri/Cargo.lock", s: "M", omitted: { reason: "File", lines: 2486, bytes: 98112 }, hunks: [] }),
        ...d.diffs.c9e41f2,
      ];
      d.select = "63421cf";
      return;
    case "diff-many":
      d.diffs["314e219"] = manyDiff();
      d.diffCut.push("314e219");
      d.select = "314e219";
      return;
    case "diff-bidi":
      d.diffs["357dfda"] = bidiDiff();
      d.select = "357dfda";
      return;
    // ---- 右欄的狀態（Phase 5 5c，基準 0b P5 的 applyState） ----
    case "conflict":
      // 終端機裡跑的 merge 停在三個檔上；乾淨合進來的已經在 staged（C3）
      d.status = {
        staged: [
          { path: "src/components/Graph/rowRefs.ts", status: "Modified" },
          { path: "src/styles/v8.css", status: "Modified" },
        ],
        unstaged: [],
        conflicted: [
          { path: "src/App.tsx", conflict_type: "BothModified" },
          { path: "src/components/Graph/RouteLayer.tsx", conflict_type: "BothModified" },
          { path: "src/lib/graphLayout.ts", conflict_type: "DeletedByUs" },
        ],
        unstaged_truncated: false,
      };
      return;
    case "many-changes":
      // node_modules 沒忽略：status 依路徑順序停在 5,000 個檔，src/ 的改動在它們之後（C4）
      d.status = {
        ...d.status,
        unstaged: byPath([
          { path: "docs/PLAN.md", status: "Modified" as const },
          ...Array.from({ length: 4999 }, (_, i) => ({
            path: `node_modules/.vite/deps/chunk-${hexAt(i)}.js`,
            status: "New" as const,
          })),
        ]),
        unstaged_truncated: true,
      };
      return;
    case "changes-error":
      // 開 repo 時讀不到 working tree（Q-S）：app 把錯誤物件交給 console.error
      d.failures.push({ cmd: "git_get_status", error: GIT_ERROR, times: 1 });
      return;
    case "prs-loading":
      d.pending.push("github_get_prs");
      return;
    case "prs-empty":
      d.prs = [];
      return;
    case "prs-rate":
      // 重置時刻 14:32（NOW 14:31 之後，Q-R）：右欄寫「Try again after 14:32.」，台北時區才對得上基準
      d.failures.push({
        cmd: "github_get_prs",
        error: { code: "RATE_LIMITED", message: "GitHub API rate limit exceeded", reset_at: fx.unix("2026/10/03 14:32") },
        times: 1,
        log: "[kira] getPRs failed: RATE_LIMITED",
      });
      return;
    case "prs-error":
      d.failures.push({ cmd: "github_get_prs", error: NETWORK_ERROR, times: 1, log: "[kira] getPRs failed: NETWORK_ERROR" });
      return;
    case "pr-diff-loading":
      d.pending.push("github_get_pr_diff");
      return;
    case "pr-diff-error":
      d.failures.push({
        cmd: "github_get_pr_diff",
        error: NETWORK_ERROR,
        times: 1,
        log: "[kira] getPRDiff failed: NETWORK_ERROR",
      });
      return;
    case "pr-diff-empty":
      d.prDiffs[38] = [];
      return;
    case "pr-diff-limits":
      // #38 也改了 lock 檔，單檔就超過顯示上限（B1）；路徑順序
      d.prDiffs[38] = [
        fromRef({ p: "package-lock.json", s: "M", omitted: { reason: "File", lines: 3412, bytes: 143566 }, hunks: [] }),
        ...d.prDiffs[38],
      ];
      return;
    case "pr-diff-too-large":
      // 超過 GitHub 的上限（406 too_large）或 Kira 的 1 MB：一條、沒有 Retry、不記 console（D12）
      d.failures.push({
        cmd: "github_get_pr_diff",
        error: { code: "PR_DIFF_TOO_LARGE", message: "pull request diff too large" },
        times: 1,
        silent: true,
      });
      return;
    default:
      if (!VIEW_STATES.has(state)) throw new Error(`fidelity: unknown state "${state}"`);
  }
}

function setSync(d: FixtureData, current: string | null, ahead: number, behind: number): void {
  if (!current) throw new Error("fidelity: ahead/behind needs a branch checked out");
  d.aheadBehind = {
    ahead,
    behind,
    has_upstream: true,
    tracking_ref_exists: true,
    ...upstreamLocation(`origin/${current}`),
  };
  d.branchStats[current] = { ahead, behind };
}

/** 拿掉遠端追蹤分支：`name` 為 null 時全部拿掉（同基準的 dropRemote） */
function dropRemotes(d: FixtureData, name: string | null): void {
  const gone = new Set(
    d.graph.branches.filter((b) => b.is_remote && (name === null || b.name === name)).map((b) => b.name),
  );
  d.graph.branches = d.graph.branches.filter((b) => !(b.is_remote && gone.has(b.name)));
  for (const c of d.graph.commits) c.refs = c.refs.filter((r) => !gone.has(r));
  d.repoInfo.branches = d.repoInfo.branches.filter((b) => !(b.is_remote && gone.has(b.name)));
  d.listBranches.branches = d.listBranches.branches.filter((b) => !(b.is_remote && gone.has(b.name)));
}

/** 拿掉 upstream 設定：`name` 為 null 時所有本機分支都拿掉 */
function clearUpstream(d: FixtureData, name: string | null): void {
  const hit = (n: string) => name === null || n === name;
  for (const b of d.graph.branches) if (!b.is_remote && hit(b.name)) b.upstream = null;
  for (const b of d.listBranches.branches) if (!b.is_remote && hit(b.name)) b.upstream = null;
  for (const n of Object.keys(d.branchStats)) if (hit(n)) d.branchStats[n] = { ...NO_STATS };
  if (d.repoInfo.head_branch && hit(d.repoInfo.head_branch)) {
    d.aheadBehind = { ...NO_UPSTREAM };
  }
}

/** origin 刪掉了 fix/toolbar-jump、fetch --prune 帶走它的追蹤分支；upstream 設定還在，所以分支說 pruned、
 *  沒有計數可比（後端 tracking_ref_exists = false、stats 降級成 null；基準 pruned） */
function pruned(d: FixtureData): void {
  const name = "fix/toolbar-jump";
  dropRemotes(d, `origin/${name}`);
  for (const b of d.listBranches.branches) {
    if (!b.is_remote && b.name === name) b.upstream = { name: `origin/${name}`, tracking_ref_exists: false };
  }
  d.branchStats[name] = { ...NO_STATS };
}

function detach(d: FixtureData): void {
  const at = d.graph.commits.find((c) => c.oid === DETACH_AT);
  if (!at) throw new Error(`fidelity: no commit ${DETACH_AT}`);
  d.graph.head = { oid: at.full_oid, branch: null };
  d.repoInfo.head_branch = null;
  for (const b of d.listBranches.branches) b.is_current = false;
  d.listBranches.detached_head_oid = at.full_oid;
  // 後端：detached HEAD 一律回 no_upstream（remote.rs ahead_behind）
  d.aheadBehind = { ...NO_UPSTREAM };
}

// ---- graph 的狀態 ----

function local(name: string, target: string, upstream: string | null = `origin/${name}`): BranchRef {
  return { name, target: fx.full(target), is_remote: false, upstream, name_on_remote: null };
}

function remote(name: string, target: string): BranchRef {
  return { name: `origin/${name}`, target: fx.full(target), is_remote: true, upstream: null, name_on_remote: name };
}

function commit(id: string, message: string, parents: string[], t: string): CommitNode {
  return {
    oid: id,
    full_oid: fx.full(id),
    message,
    author: { ...fx.AUTHOR, timestamp: fx.unix(t) },
    parents: parents.map(fx.full),
    refs: [],
  };
}

/** 改過 graph 的分支 / tag / HEAD 之後，把跟著它的資料重算一次，照真後端的語意：分支依 libgit2 迭代
 *  （refs/heads/* 名稱序在前、refs/remotes/* 在後）；每個 commit 的 refs 先分支後 tag（build_ref_map）；
 *  repoInfo / list_branches 從同一份分支來；新的本機分支補上計數（有 upstream 的與 origin 同步 0 / 0，
 *  沒有的照後端的降級值），既有的不動。ahead/behind 只在 HEAD 換了的狀態另外算（checkout） */
function resync(d: FixtureData): void {
  const g = d.graph;
  g.branches.sort((a, b) => (a.is_remote !== b.is_remote ? (a.is_remote ? 1 : -1) : byName(a.name, b.name)));
  for (const c of g.commits) {
    c.refs = [
      ...g.branches.filter((b) => b.target === c.full_oid).map((b) => b.name),
      ...g.tags.filter((t) => t.target === c.full_oid).map((t) => t.name),
    ];
  }
  const tracked = (b: BranchRef) => b.upstream !== null && g.branches.some((r) => r.is_remote && r.name === b.upstream);
  const head = g.head.oid === null ? null : g.head.branch;
  d.repoInfo.head_branch = head;
  d.repoInfo.branches = g.branches.map((b) => ({ name: b.name, oid: b.target, is_remote: b.is_remote }));
  d.listBranches = {
    branches: g.branches.map((b) => ({
      name: b.name,
      is_current: !b.is_remote && b.name === head,
      is_remote: b.is_remote,
      upstream: b.is_remote || b.upstream === null ? null : { name: b.upstream, tracking_ref_exists: tracked(b) },
    })),
    detached_head_oid: g.head.branch === null ? g.head.oid : null,
  };
  const locals = new Set(g.branches.filter((b) => !b.is_remote).map((b) => b.name));
  for (const name of Object.keys(d.branchStats)) if (!locals.has(name)) delete d.branchStats[name];
  for (const b of g.branches) {
    if (!b.is_remote && !(b.name in d.branchStats)) {
      d.branchStats[b.name] = b.upstream === null ? { ...NO_STATS } : { ahead: 0, behind: 0 };
    }
  }
}

/** 換到另一個 repo（基準的 otherRepo）：同一個資料夾旁邊，開它時後端把它插到近期清單最前面；
 *  沒有 remote、沒有 upstream、工作區乾淨，graph 由各狀態填 */
function otherRepo(d: FixtureData, name: string): void {
  const path = `${fx.HOME}/Documents/${name}`;
  d.repoInfo = { path, head_branch: null, branches: [], remotes: [] };
  d.graph = { commits: [], branches: [], tags: [], truncated: false, head: { oid: null, branch: null }, default_branch: null };
  d.branchStats = {};
  d.status = { staged: [], unstaged: [], conflicted: [], unstaged_truncated: false };
  // 剛開的就是「現在」：跟著 fx.NOW，不寫死一個比它晚的時刻（畫面只顯示日期）
  d.recentRepos = [{ path, last_opened: Math.floor(fx.NOW / 1000) }, ...d.recentRepos];
}

// git init：HEAD 指向 main、沒有 commit、沒有 remote；三個還沒 stage 的新檔
function empty(d: FixtureData): void {
  otherRepo(d, "kira-new");
  d.graph.head = { oid: null, branch: "main" };
  d.status.unstaged = ["README.md", "package.json", "src/main.ts"].map((path) => ({ path, status: "New" as const }));
  resync(d);
  d.aheadBehind = { ...NO_UPSTREAM };
}

// 三筆 commit：第一筆是根，線在那裡以橫槓結束
function young(d: FixtureData): void {
  otherRepo(d, "kira-new");
  d.graph.commits = [
    commit("b41c7e2", "feat: open a repository and list its commits", ["5e0d9a3"], "2026/10/03 10:12"),
    commit("5e0d9a3", "docs: add a README", ["a17f3c0"], "2026/10/02 21:40"),
    commit("a17f3c0", "Initial commit", [], "2026/10/02 21:31"),
  ];
  d.graph.branches = [local("main", "b41c7e2", null)];
  resync(d);
  checkout(d, "main");
  Object.assign(d.diffs, youngDiffs());
}

// 走線組合 A 的示範（v8-0b-graph-states.md §2.3.2）：repo fieldbook，與 origin 同步、歷史截斷
function routes(d: FixtureData): void {
  otherRepo(d, "fieldbook");
  d.repoInfo.remotes = ["origin"];
  d.graph.commits = [
    commit("3fa2c71", "feat(search): rank matches by how recently a note was opened", ["9d4e6a0"], "2026/10/03 13:50"),
    commit("b6d0e94", "feat(notes): pin a note to the top of its notebook", ["e07b52d"], "2026/10/03 12:20"),
    commit("58c1a3f", "feat(legend): show the legend beside the map", ["a6f38d1"], "2026/10/03 10:40"),
    commit("e07b52d", "fix: keep the map centered when the window resizes", ["c21f8b7"], "2026/10/02 22:15"),
    commit("9d4e6a0", "Merge branch 'main' into feat/search", ["71ae3d9", "c21f8b7"], "2026/10/02 20:30"),
    commit("c21f8b7", "feat: open notes from the command palette", ["a6f38d1"], "2026/10/02 18:05"),
    commit("4b9c0e2", "fix(gutter): keep the gutter off the scrollbar", ["a6f38d1"], "2026/10/02 15:40"),
    commit("71ae3d9", "feat(search): search note titles as you type", ["d83b2f6"], "2026/10/02 11:25"),
    commit("a6f38d1", "refactor: move map tiles into their own module", ["0e5d7b4"], "2026/10/01 21:10"),
    commit("0e5d7b4", "docs: describe the keyboard shortcuts", ["d83b2f6"], "2026/10/01 17:45"),
    commit("7c4e1a9", "fix(compass): point north again after the map resets", ["d83b2f6"], "2026/10/01 16:10"),
    commit("d83b2f6", "feat: draw the map from tiles", ["6c1e9a8"], "2026/10/01 14:30"),
    commit("6c1e9a8", "chore: add a lint script", ["f4a7d05"], "2026/09/30 22:05"),
    commit("f4a7d05", "feat: open a notebook from disk", ["2b8e4c1"], "2026/09/30 19:20"),
  ];
  d.graph.branches = [
    local("feat/search", "3fa2c71"),
    remote("feat/search", "3fa2c71"),
    local("feat/notes", "b6d0e94", null),
    local("feat/legend", "58c1a3f", null),
    local("main", "e07b52d"),
    remote("main", "e07b52d"),
    local("fix/gutter", "4b9c0e2", null),
    local("fix/compass", "7c4e1a9", null),
  ];
  d.graph.truncated = true; // 最舊那筆的 parent 在視窗外
  d.graph.default_branch = "main";
  resync(d);
  checkout(d, "feat/search");
  Object.assign(d.diffs, routesDiffs());
  d.diffRotation = ["3fa2c71", "b6d0e94", "58c1a3f"];
}

// git switch -c feat/v8-graph 在 main 上：還沒有自己的 commit，HEAD 寄宿在主幹的站（決策 D）
function newBranch(d: FixtureData): void {
  d.graph.branches.push(local("feat/v8-graph", "dd9ba36", null));
  resync(d);
  checkout(d, "feat/v8-graph");
}

// 舊分支 feat/old：tip 比載入的 23 筆都舊（路線規則 §3，HEAD 在視窗外）
function headBeyond(d: FixtureData): void {
  d.graph.branches.push(local("feat/old", "0dd5eed"), remote("feat/old", "0dd5eed"));
  d.graph.truncated = true;
  resync(d);
  checkout(d, "feat/old");
}

// release/0.1 在 #36 的 merge 切出來、沒有自己的 commit：寄宿在主幹
function lodger(d: FixtureData): void {
  d.graph.branches.push(local("release/0.1", "63421cf"), remote("release/0.1", "63421cf"));
  resync(d);
}

// 長分支名有自己的線；main 的 tip 多了寄宿的 release 分支與正式版 tag，那一列超過預算
function longRefs(d: FixtureData): void {
  const long = "feat/t14-unstaged-cap-and-console-discipline";
  d.graph.branches = d.graph.branches.filter((b) => !b.name.endsWith("fix/toolbar-jump"));
  d.graph.branches.push(local(long, "e81d6b0"), remote(long, "e81d6b0"));
  d.graph.tags.push({ name: "v0.1.0", target: fx.full("dd9ba36") });
  d.graph.branches.push(local("release/0.1", "dd9ba36"), remote("release/0.1", "dd9ba36"));
  resync(d);
}
