import { describe, expect, it } from "vitest";
import { computeRoutes } from "../lib/routeMap";
import * as fx from "../dev/fidelity/fixture";
import { diffOf, fixtureFor, type FixtureData } from "../dev/fidelity/states";

// 基準 mockup 在每個 ?on= / ?state= 下的「你在這裡」：圓標字母與 html[data-line]（圓標顏色一律等於
// data-line）。2026-10-06 在 WKWebView 實跑基準讀出（mockup/v8-kirazuri-lines-sys.html 2026-10-05 的版本，
// 讀 #you-rd 與 data-line），不是手推；graph 的狀態 2026-10-08 再跑一次（2026-10-08 的版本，`youare_probe.sh`）。
// 基準的 dropRemote 不重算字母、detach 寫死 t15g 那一站；app 則由 computeRoutes 重算——兩邊不等就要修
// 基準或 fixture，不能等到 D1 比對才發現。
const REFERENCE: Array<[label: string, on: string | null, states: string[], letter: string, line: string]> = [
  ["default", null, [], "T", "rokusho"],
  ["onMain", "main", [], "M", "trunk"],
  ["behind", null, ["behind"], "T", "rokusho"],
  ["diverged", null, ["diverged"], "T", "rokusho"],
  ["noUpstream", null, ["no-upstream"], "T", "rokusho"],
  ["noRemote", null, ["no-remote"], "T", "rokusho"],
  ["detached", null, ["detached"], "T", "rokusho"],
  ["signedOut", null, ["signed-out"], "T", "rokusho"],
  ["connecting", null, ["connecting"], "T", "rokusho"],
  ["accountMenu", null, ["account-menu"], "T", "rokusho"],
  ["errorPush", null, ["error-push"], "T", "rokusho"],
  ["errorPull", null, ["error-pull"], "T", "rokusho"],
  ["errorRefresh", null, ["error-refresh"], "T", "rokusho"],
  ["errorOpen", null, ["error-open"], "T", "rokusho"],
  ["errorAuth", null, ["error-auth"], "T", "rokusho"],
  ["errorSignout", null, ["error-signout"], "T", "rokusho"],
  // graph 的狀態（Phase 4）；loading 時站牌隱藏，另外驗
  ["empty", null, ["empty"], "M", "trunk"],
  ["young", null, ["young"], "M", "trunk"],
  ["routes", null, ["routes"], "S", "shinsha"],
  ["newBranch", null, ["new-branch"], "V", "shinsha"],
  ["headBeyond", null, ["head-beyond"], "O", "odo"],
  ["lodger", null, ["lodger"], "T", "rokusho"],
  ["longRefs", null, ["long-refs"], "T", "rokusho"],
  // ?on= 在狀態之後（Phase 5 5a 第 0 步）：lodger 加進來的 release/0.1 切得過去，換上自己的 A / 辰砂（決策 D）；
  // 基準的 on-after-state 流程讀出（2026-10-11，mockup 工作副本）
  ["lodgerOnRelease", "release/0.1", ["lodger"], "A", "shinsha"],
];

const shared = () => ({
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

describe("fidelity states: 'you are here' matches the reference", () => {
  it.each(REFERENCE)(
    "test_fidelityStates_%s_headLetterAndAccentMatchTheReference",
    (_label, on, states, letter, line) => {
      const routes = computeRoutes(fixtureFor(on, states).graph);
      expect([routes.head.letter, routes.accent]).toEqual([letter, line]);
    },
  );
});

/** 同後端 ahead_behind：upstream 是 origin 的同名分支 */
const tracking = (branch: string, ahead: number, behind: number) => ({
  ahead,
  behind,
  has_upstream: true,
  tracking_ref_exists: true,
  upstream_remote: "origin",
  upstream_branch: branch,
});
const NO_UPSTREAM = {
  ahead: 0,
  behind: 0,
  has_upstream: false,
  tracking_ref_exists: false,
  upstream_remote: null,
  upstream_branch: null,
};

// 多數狀態的字母與強調色和預設相同，上面那組抓不到「轉換根本沒套用」——每個改資料的轉換另外驗
describe("fidelity states: data transforms", () => {
  it("test_fidelityStates_onMain_checksOutMain", () => {
    const d = fixtureFor("main", []);
    expect(d.graph.head.branch).toBe("main");
    expect(d.repoInfo.head_branch).toBe("main");
    expect(d.listBranches.branches.filter((b) => b.is_current).map((b) => b.name)).toEqual(["main"]);
    expect(d.aheadBehind).toEqual(tracking("main", 0, 0));
  });

  // ?on= 在狀態之後（基準開機流程同步改）：lodger 加進來的 release/0.1 切得過去
  it("test_fidelityStates_onAfterStates_checksOutABranchAStateAdds", () => {
    const d = fixtureFor("release/0.1", ["lodger"]);
    const at = fx.graph.commits.find((c) => c.oid === "63421cf")?.full_oid;
    expect(d.graph.head).toEqual({ oid: at, branch: "release/0.1" });
    expect(d.repoInfo.head_branch).toBe("release/0.1");
    expect(d.listBranches.branches.filter((b) => b.is_current).map((b) => b.name)).toEqual(["release/0.1"]);
    expect(d.aheadBehind).toEqual(tracking("release/0.1", 0, 0));
  });

  it("test_fidelityStates_behindAndDiverged_setTheCounts", () => {
    expect(fixtureFor(null, ["behind"]).aheadBehind).toEqual(tracking("feat/t15g-graph-density", 0, 3));
    expect(fixtureFor(null, ["diverged"]).aheadBehind).toEqual(tracking("feat/t15g-graph-density", 2, 3));
    expect(fixtureFor(null, ["diverged"]).branchStats["feat/t15g-graph-density"]).toEqual({ ahead: 2, behind: 3 });
  });

  it("test_fidelityStates_noUpstream_dropsOnlyTheCurrentBranchsRemote", () => {
    const d = fixtureFor(null, ["no-upstream"]);
    const gone = "origin/feat/t15g-graph-density";
    expect(d.graph.branches.map((b) => b.name)).not.toContain(gone);
    expect(d.graph.branches.map((b) => b.name)).toContain("origin/main");
    expect(d.graph.commits.flatMap((c) => c.refs)).not.toContain(gone);
    expect(d.repoInfo.branches.map((b) => b.name)).not.toContain(gone);
    expect(d.listBranches.branches.map((b) => b.name)).not.toContain(gone);
    expect(d.graph.branches.find((b) => b.name === "feat/t15g-graph-density")?.upstream).toBeNull();
    expect(d.graph.branches.find((b) => b.name === "main")?.upstream).toBe("origin/main");
    expect(d.aheadBehind).toEqual(NO_UPSTREAM);
    expect(d.branchStats["feat/t15g-graph-density"]).toEqual({ ahead: null, behind: null });
  });

  it("test_fidelityStates_noRemote_dropsEveryRemote", () => {
    const d = fixtureFor(null, ["no-remote"]);
    expect(d.graph.branches.filter((b) => b.is_remote)).toEqual([]);
    expect(d.graph.commits.flatMap((c) => c.refs).filter((r) => r.startsWith("origin/"))).toEqual([]);
    expect(d.repoInfo.remotes).toEqual([]);
    expect(d.graph.default_branch).toBeNull();
    expect(d.graph.branches.every((b) => b.upstream === null)).toBe(true);
    expect(d.listBranches.branches.every((b) => !b.is_remote && b.upstream === null)).toBe(true);
    expect(d.aheadBehind).toEqual(NO_UPSTREAM);
  });

  it("test_fidelityStates_detached_headLeavesTheBranch", () => {
    const d = fixtureFor(null, ["detached"]);
    const at = fx.graph.commits.find((c) => c.oid === "7b03d5e")?.full_oid;
    expect(d.graph.head).toEqual({ oid: at, branch: null });
    expect(d.repoInfo.head_branch).toBeNull();
    expect(d.listBranches.detached_head_oid).toBe(at);
    expect(d.listBranches.branches.some((b) => b.is_current)).toBe(false);
    expect(d.aheadBehind).toEqual(NO_UPSTREAM);
    // 分支本身不動：feat/t15g-graph-density 仍在 c9e41f2
    expect(d.graph.branches).toEqual(fx.graph.branches);
  });

  // graph 的狀態會重算分支資料：接在 detached 後面時 HEAD 仍是 detached
  it("test_fidelityStates_detachedThenGraphState_staysDetached", () => {
    const at = fx.graph.commits.find((c) => c.oid === "7b03d5e")?.full_oid;
    for (const s of ["lodger", "long-refs"]) {
      const d = fixtureFor(null, ["detached", s]);
      expect(d.graph.head, s).toEqual({ oid: at, branch: null });
      expect(d.listBranches.detached_head_oid, s).toBe(at);
    }
  });

  it("test_fidelityStates_signedOutStates_clearTheAccount", () => {
    for (const s of ["signed-out", "connecting", "error-auth"]) {
      expect(fixtureFor(null, [s]).auth, s).toEqual({ authenticated: false, username: null });
    }
    expect(fixtureFor(null, ["error-signout"]).auth).toEqual(fx.auth);
  });

  it("test_fidelityStates_viewOnlyStates_leaveTheDataAlone", () => {
    for (const s of ["account-menu", "error-push", "error-pull", "error-refresh", "error-open", "error-signout", "error-checkout"]) {
      expect(fixtureFor(null, [s]), s).toEqual(shared());
    }
  });

  // ---- 側欄的狀態（Phase 5 5a，基準 0b P5）----

  // origin 刪了 fix/toolbar-jump、fetch --prune：追蹤分支沒了，upstream 設定還在 → pruned、沒有計數
  it("test_fidelityStates_pruned_upstreamSetButItsRemoteGone", () => {
    const d = fixtureFor(null, ["pruned"]);
    expect(d.graph.branches.map((b) => b.name)).not.toContain("origin/fix/toolbar-jump");
    expect(d.listBranches.branches.map((b) => b.name)).not.toContain("origin/fix/toolbar-jump");
    expect(d.graph.commits.find((c) => c.oid === "e81d6b0")?.refs).toEqual(["fix/toolbar-jump"]);
    const row = d.listBranches.branches.find((b) => b.name === "fix/toolbar-jump");
    expect(row?.upstream).toEqual({ name: "origin/fix/toolbar-jump", tracking_ref_exists: false });
    expect(d.branchStats["fix/toolbar-jump"]).toEqual({ ahead: null, behind: null });
  });

  // 剛開：graph、分支、status、ahead/behind、PR 清單都永不回應；資料本身同預設
  it("test_fidelityStates_opening_holdsTheOpenReadsBack", () => {
    const d = fixtureFor(null, ["opening"]);
    expect(d.pending).toEqual(["git_get_graph", "git_list_branches", "git_get_status", "git_get_ahead_behind", "github_get_prs"]);
    expect({ ...d, pending: [] }).toEqual(shared());
  });

  // ---- 右欄的狀態（5c step 9，基準 0b P5 §4） ----

  it("test_fidelityStates_conflict_threeFilesAndWhatMergedCleanly", () => {
    const d = fixtureFor(null, ["conflict"]);
    expect(d.status.conflicted.map((c) => [c.path, c.conflict_type])).toEqual([
      ["src/App.tsx", "BothModified"],
      ["src/components/Graph/RouteLayer.tsx", "BothModified"],
      ["src/lib/graphLayout.ts", "DeletedByUs"],
    ]);
    expect(d.status.staged.map((f) => f.path)).toEqual(["src/components/Graph/rowRefs.ts", "src/styles/v8.css"]);
    expect(d.status.unstaged).toEqual([]);
    expect({ ...d, status: fx.status }).toEqual(shared());
  });

  // node_modules 沒忽略：5,000 個檔、路徑順序、截斷旗標；staged 照預設
  it("test_fidelityStates_manyChanges_fiveThousandInPathOrder_truncated", () => {
    const d = fixtureFor(null, ["many-changes"]);
    expect(d.status.unstaged.length).toBe(5000);
    expect(d.status.unstaged_truncated).toBe(true);
    expect(d.status.unstaged[0]).toEqual({ path: "docs/PLAN.md", status: "Modified" });
    const paths = d.status.unstaged.map((f) => f.path);
    expect(paths.slice(1).every((p) => p.startsWith("node_modules/.vite/deps/chunk-") && p.endsWith(".js"))).toBe(true);
    expect([...paths].sort()).toEqual(paths);
    expect(new Set(paths).size).toBe(5000);
    expect(d.status.staged).toEqual(fx.status.staged);
  });

  it("test_fidelityStates_changesError_failsTheStatusOnceOnTheLedger", () => {
    const d = fixtureFor(null, ["changes-error"]);
    expect(d.failures).toEqual([
      { cmd: "git_get_status", error: { code: "GIT_ERROR", message: "git operation failed" }, times: 1 },
    ]);
    expect({ ...d, failures: [] }).toEqual(shared());
  });

  it("test_fidelityStates_prStates_listPendingEmptyRateError", () => {
    expect(fixtureFor(null, ["prs-loading"]).pending).toEqual(["github_get_prs"]);
    expect(fixtureFor(null, ["prs-empty"]).prs).toEqual([]);
    // fieldbook 的 origin 在 GitHub、沒有開著的 PR
    expect(fixtureFor(null, ["routes"]).prs).toEqual([]);
    const rate = fixtureFor(null, ["prs-rate"]).failures[0];
    expect(rate.cmd).toBe("github_get_prs");
    expect(rate.error.code).toBe("RATE_LIMITED");
    // 重置時刻 14:32 台北，在凍結的「現在」14:31 之後（Q-R）
    expect(rate.error.reset_at).toBe(Math.floor(fx.NOW / 1000) + 60);
    expect(rate.log).toBe("[kira] getPRs failed: RATE_LIMITED");
    const err = fixtureFor(null, ["prs-error"]).failures[0];
    expect([err.cmd, err.error.code, err.times, err.log]).toEqual(["github_get_prs", "NETWORK_ERROR", 1, "[kira] getPRs failed: NETWORK_ERROR"]);
  });

  it("test_fidelityStates_prDiffStates_pendingErrorEmptyLimitsTooLarge", () => {
    expect(fixtureFor(null, ["pr-diff-loading"]).pending).toEqual(["github_get_pr_diff"]);
    const err = fixtureFor(null, ["pr-diff-error"]).failures[0];
    expect([err.cmd, err.error.code, err.log]).toEqual(["github_get_pr_diff", "NETWORK_ERROR", "[kira] getPRDiff failed: NETWORK_ERROR"]);
    expect(fixtureFor(null, ["pr-diff-empty"]).prDiffs[38]).toEqual([]);
    const limits = fixtureFor(null, ["pr-diff-limits"]).prDiffs[38];
    expect(limits[0].path).toBe("package-lock.json");
    expect(limits[0].omitted).toEqual({ reason: "File", lines: 3412, bytes: 143566 });
    expect(limits.slice(1)).toEqual(fx.PR_DIFFS[38]);
    // 太大：app 不記 console，帳本要它丟了但沒被記
    const large = fixtureFor(null, ["pr-diff-too-large"]).failures[0];
    expect([large.cmd, large.error.code, large.silent]).toEqual(["github_get_pr_diff", "PR_DIFF_TOO_LARGE", true]);
    // 預設：#38 展開是它全部的檔（D11）
    expect(shared().prDiffs[38].length).toBeGreaterThan(1);
  });

  // 開 repo 時讀不到分支清單（Q-B）：假後端回後端形狀的 GIT_ERROR 一次，記在帳上
  it("test_fidelityStates_branchesError_failsTheListOnceOnTheLedger", () => {
    const d = fixtureFor(null, ["branches-error"]);
    expect(d.failures).toEqual([
      { cmd: "git_list_branches", error: { code: "GIT_ERROR", message: "git operation failed" }, times: 1 },
    ]);
    expect({ ...d, failures: [] }).toEqual(shared());
  });

  it("test_fidelityStates_unknownName_throws", () => {
    expect(() => fixtureFor(null, ["detatched"])).toThrow(/unknown state "detatched"/);
    expect(() => fixtureFor("nope", [])).toThrow(/no local branch "nope"/);
  });

  it("test_fidelityStates_leavesTheSharedFixtureUntouched", () => {
    const before = structuredClone(shared());
    fixtureFor("main", ["no-remote", "detached", "signed-out"]);
    fixtureFor(null, ["diverged", "no-upstream"]);
    for (const s of ["empty", "young", "routes", "new-branch", "head-beyond", "lodger", "long-refs", "loading"]) {
      fixtureFor(null, [s]);
    }
    expect(shared()).toEqual(before);
  });
});

// ---- graph 的狀態（Phase 4）：每站的欄 / 顏色 / 字母 = 基準手寫值 ----

/** 每站：短 hash → [欄, 顏色, 字母]；字母只在有 ref 的線上看得到，這裡照 computeRoutes 全列 */
function stationsOf(on: string | null, states: string[]) {
  const d = fixtureFor(on, states);
  const routes = computeRoutes(d.graph);
  const lineById = new Map(routes.lines.map((l) => [l.id, l]));
  const out: Record<string, [number, string]> = {};
  for (const st of routes.stations) {
    const line = lineById.get(st.line)!;
    out[st.oid.slice(0, 7)] = [line.slot, line.color];
  }
  return { d, routes, stations: out, line: (oid: string) => lineById.get(routes.stations.find((st) => st.oid.startsWith(oid))!.line)! };
}

// 預設資料的欄與顏色（基準 797-831：LINE 與每個 commit 的 lane）
const DEFAULT_STATIONS: Record<string, [number, string]> = {
  c9e41f2: [1, "rokusho"], e81d6b0: [2, "murasaki"], "7b03d5e": [1, "rokusho"], "4f2a9c1": [1, "rokusho"],
  dd9ba36: [0, "trunk"], "63421cf": [0, "trunk"], "4c6dafd": [1, "gunjo"], "9a58413": [1, "gunjo"],
  "4f709e5": [1, "gunjo"], "314e219": [0, "trunk"], "9a70f3f": [1, "odo"], "9b08a69": [1, "odo"],
  "9d9dfb1": [1, "odo"], "932c96b": [1, "odo"], "357dfda": [1, "odo"], "7e42383": [1, "odo"],
  de312e2: [1, "odo"], e255b9c: [0, "trunk"], "7c90e13": [0, "trunk"], "1fd83dc": [1, "gunjo"],
  a592721: [0, "trunk"], "561874d": [1, "shinsha"], "86023a3": [0, "trunk"],
};

describe("fidelity states: graph states match the reference's hand-written data", () => {
  it("test_fidelityStates_default_stationsMatchTheReference", () => {
    expect(stationsOf(null, []).stations).toEqual(DEFAULT_STATIONS);
  });

  // 基準 0b P4 起的預設是截斷：最舊那站 86023a3 的 parent 都不在清單內，真後端取滿上限就回 truncated
  // （頁尾與線的淡出靠它；語意對真後端傾印的比對在 mockup/tools/fixture_semantics.mjs）
  it("test_fidelityStates_default_isATruncatedWindow", () => {
    const { d } = stationsOf(null, []);
    expect(d.graph.truncated).toBe(true);
    const listed = new Set(d.graph.commits.map((c) => c.full_oid));
    expect(d.graph.commits.at(-1)?.parents.every((p) => !listed.has(p))).toBe(true);
  });

  // 視窗外的分支（0b P5，Phase 5 5a step 3）：在 graph.branches、tip 不在 commits，本機與 origin 是不同的
  // commit（↑1 ↓2）；路線圖給它 line = null 的 ref，23 站不變（上一條守）；no-remote 下沒有計數
  it("test_fidelityStates_default_hasABranchBeyondTheWindow", () => {
    const { d, routes } = stationsOf(null, []);
    const names = ["feat/t9d-watcher", "origin/feat/t9d-watcher"];
    const refs = d.graph.branches.filter((b) => names.includes(b.name));
    expect(refs.map((b) => b.name)).toEqual(names);
    expect(refs[0].target).not.toBe(refs[1].target);
    const listed = new Set(d.graph.commits.map((c) => c.full_oid));
    expect(refs.some((b) => listed.has(b.target))).toBe(false);
    expect(routes.refs.filter((r) => names.includes(r.name)).map((r) => [r.name, r.line])).toEqual([
      ["feat/t9d-watcher", null],
      ["origin/feat/t9d-watcher", null],
    ]);
    expect(d.branchStats["feat/t9d-watcher"]).toEqual({ ahead: 1, behind: 2 });
    const off = fixtureFor(null, ["no-remote"]);
    expect(off.branchStats["feat/t9d-watcher"]).toEqual({ ahead: null, behind: null });
    expect(off.graph.branches.map((b) => b.name)).not.toContain("origin/feat/t9d-watcher");
  });

  // 基準 1868-1883（ROUTES）與 1936-1937（LINE / LETTER）
  it("test_fidelityStates_routes_stationsMatchTheReference", () => {
    const { stations, line, d } = stationsOf(null, ["routes"]);
    expect(stations).toEqual({
      "3fa2c71": [1, "shinsha"], b6d0e94: [2, "gunjo"], "58c1a3f": [3, "murasaki"], e07b52d: [0, "trunk"],
      "9d4e6a0": [1, "shinsha"], c21f8b7: [0, "trunk"], "4b9c0e2": [2, "odo"], "71ae3d9": [1, "shinsha"],
      a6f38d1: [0, "trunk"], "0e5d7b4": [0, "trunk"], "7c4e1a9": [2, "rokusho"], d83b2f6: [0, "trunk"],
      "6c1e9a8": [0, "trunk"], f4a7d05: [0, "trunk"],
    });
    expect(["3fa2c71", "b6d0e94", "58c1a3f", "e07b52d", "4b9c0e2", "7c4e1a9"].map((id) => line(id).letter)).toEqual(
      ["S", "N", "L", "M", "G", "C"],
    );
    // 訊息文字照基準（state_routes.mjs 寫的是 centred）
    expect(d.graph.commits[3].message).toBe("fix: keep the map centered when the window resizes");
    expect(d.graph.truncated).toBe(true);
    expect(d.repoInfo.path).toBe(`${fx.HOME}/Documents/fieldbook`);
    expect(d.aheadBehind).toEqual(tracking("feat/search", 0, 0));
  });

  // 基準 1844-1848（YOUNG）：三站都在主幹，根是最後一站
  it("test_fidelityStates_young_threeStationsOnTheTrunk", () => {
    const { stations, routes, d } = stationsOf(null, ["young"]);
    expect(stations).toEqual({ b41c7e2: [0, "trunk"], "5e0d9a3": [0, "trunk"], a17f3c0: [0, "trunk"] });
    expect(d.graph.commits.at(-1)?.parents).toEqual([]);
    expect(d.graph.truncated).toBe(false);
    expect(d.repoInfo.remotes).toEqual([]);
    expect(routes.head.oid).toBe(d.graph.commits[0].full_oid);
  });

  it("test_fidelityStates_empty_isAnUnbornRepositoryWithThreeNewFiles", () => {
    const d = fixtureFor(null, ["empty"]);
    expect(d.graph).toMatchObject({ commits: [], branches: [], tags: [], head: { oid: null, branch: "main" } });
    expect(d.repoInfo).toEqual({ path: `${fx.HOME}/Documents/kira-new`, head_branch: null, branches: [], remotes: [] });
    expect(d.listBranches).toEqual({ branches: [], detached_head_oid: null });
    expect(d.aheadBehind).toEqual(NO_UPSTREAM);
    expect(d.status.unstaged.map((f) => f.path)).toEqual(["README.md", "package.json", "src/main.ts"]);
    // 開它時後端把它插到近期清單最前面；入口點的是 repoInfo.path 那一項
    expect(d.recentRepos[0].path).toBe(d.repoInfo.path);
  });

  // 基準 1959-1969：欄與顏色全不變，HEAD 寄宿在主幹那站，強調色是分支自己的辰砂（決策 D）
  it("test_fidelityStates_newBranch_headLodgesOnTheTrunk", () => {
    const { stations, routes, d } = stationsOf(null, ["new-branch"]);
    expect(stations).toEqual(DEFAULT_STATIONS);
    expect(routes.head).toMatchObject({ identity: "feat/v8-graph", letter: "V" });
    expect(routes.head.line).toBe(lineOf(routes, "dd9ba36"));
    expect(d.listBranches.branches.find((b) => b.is_current)?.name).toBe("feat/v8-graph");
    expect(d.aheadBehind).toEqual(NO_UPSTREAM);
  });

  // 基準 1970-1978：HEAD 在視窗外，欄不變
  it("test_fidelityStates_headBeyond_headIsOutsideTheWindow", () => {
    const { stations, routes, d } = stationsOf(null, ["head-beyond"]);
    expect(stations).toEqual(DEFAULT_STATIONS);
    expect(routes.head).toMatchObject({ identity: "feat/old", letter: "O", line: null });
    expect(d.graph.commits.some((c) => c.full_oid === d.graph.head.oid)).toBe(false);
    expect(d.aheadBehind).toEqual(tracking("feat/old", 0, 0));
  });

  // 基準 1979-1984：release/0.1 與它的 origin 停在 #36 的 merge，沒有自己的線
  it("test_fidelityStates_lodger_refsHaveNoLineOfTheirOwn", () => {
    const { stations, routes, d } = stationsOf(null, ["lodger"]);
    expect(stations).toEqual(DEFAULT_STATIONS);
    const placed = routes.refs.filter((r) => r.name.endsWith("release/0.1"));
    expect(placed.map((r) => [r.name, r.line])).toEqual([["release/0.1", null], ["origin/release/0.1", null]]);
    expect(placed.every((r) => r.target.startsWith("63421cf"))).toBe(true);
    // 沒換 HEAD：工具列的計數照預設
    expect(d.aheadBehind).toEqual(fx.aheadBehind);
  });

  // 基準 1985-1999：tj 那條線改名後是 U / 辰砂；main 的 tip 多了寄宿的 release 與 v0.1.0
  it("test_fidelityStates_longRefs_renamedLineAndACrowdedTip", () => {
    const { stations, line, d } = stationsOf(null, ["long-refs"]);
    expect(stations).toEqual({ ...DEFAULT_STATIONS, e81d6b0: [2, "shinsha"] });
    expect(line("e81d6b0").letter).toBe("U");
    const tip = d.graph.commits.find((c) => c.oid === "dd9ba36")!;
    expect(tip.refs).toEqual(["main", "release/0.1", "origin/main", "origin/release/0.1", "v0.1.0-rc.1", "v0.1.0"]);
    expect(d.aheadBehind).toEqual(fx.aheadBehind);
  });

  // loading：資料同預設，只是 graph 永不回應；基準的站牌隱藏、data-line 是主幹（app 沿用首頁的主幹）
  it("test_fidelityStates_loading_holdsTheGraphBack", () => {
    const d = fixtureFor(null, ["loading"]);
    expect(d.pending).toEqual(["git_get_graph"]);
    expect({ ...d, pending: [] }).toEqual(shared());
  });
});

// diff 區的狀態（Phase 5 5b，基準 0b P5 的 applyState 與示範資料）：diff 跟著狀態走、要看的站不是 HEAD 時選它
describe("fidelity states: the diff follows the state", () => {
  const paths = (d: FixtureData, short: string) => diffOf(d, fx.full(short)).files.map((f) => f.path);

  // 沒有專屬 diff 的站依列序輪流借（基準 renderDiff）；routes 換成它自己的三組
  it("test_fidelityStates_default_rowsWithoutADiffBorrowInTurn", () => {
    const d = fixtureFor(null, []);
    expect(d.select).toBeNull();
    const rows = d.graph.commits.slice(3, 6).map((c) => paths(d, c.oid)[0]);
    expect(rows).toEqual(["src/components/CommitGraph/constants.ts", "src/App.tsx", "src/lib/graphLayout.ts"]);
    const routes = fixtureFor(null, ["routes"]);
    expect(paths(routes, "e07b52d")).toEqual(["src/search/rank.ts"]);
    expect(paths(fixtureFor(null, ["young"]), "5e0d9a3")).toEqual(["README.md"]);
  });

  it("test_fidelityStates_diffLimits_selectsTheMergeWithItsFilesInPathOrder", () => {
    const d = fixtureFor(null, ["diff-limits"]);
    expect(d.select).toBe("63421cf");
    const r = diffOf(d, fx.full("63421cf"));
    expect(r.files.map((f) => f.path)).toEqual([
      "dist/assets/index-4c6dafd.js",
      "dist/assets/vendor-9a58413.js",
      "docs/demo/kira v8.mov",
      "docs/notes/v8 port [draft].md",
      "package-lock.json",
      "scripts/release.sh",
      "src-tauri/capabilities/default.json",
      "src-tauri/icons/icon.icns",
      "src/components/Graph/RouteLayer.tsx",
    ]);
    expect(r.truncated).toBe(false);
    // 後端語意：超過 10 MB 的檔不同時是二進位（classify_blob_flags）
    expect([r.files[2].too_large, r.files[2].binary]).toEqual([true, false]);
    expect(r.files[0].hunks[0].lines.map((l) => l.content.length)).toEqual([61900, 62010]);
    // 一個 parent 的 commit 也收合一個 lock 檔，排在最前面
    expect(paths(d, "c9e41f2")).toEqual(["src-tauri/Cargo.lock", ...paths(fixtureFor(null, []), "c9e41f2")]);
  });

  // 只補檔尾換行的檔：libgit2 對它實際給的 hunk（Q-N，throwaway repo 實測）
  it("test_fidelityStates_diffLimits_newlineOnlyFileIsLibgit2sHunk", () => {
    const cap = diffOf(fixtureFor(null, ["diff-limits"]), fx.full("63421cf")).files[6];
    const [hunk] = cap.hunks;
    expect([hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines, hunk.context]).toEqual([13, 4, 13, 4, ""]);
    expect(hunk.lines.map((l) => [l.origin, l.old_lineno, l.new_lineno])).toEqual([
      [" ", 13, 13],
      [" ", 14, 14],
      [" ", 15, 15],
      ["-", 16, null],
      [">", 16, null],
      ["+", null, 16],
    ]);
    expect(hunk.lines[4].content).toBe("\n\\ No newline at end of file");
  });

  // 註記行的 origin 看上一行，跟 libgit2 一樣（實測：- → >、+ → <、context → =），行號沿用上一行
  it("test_fidelityStates_noNewlineNote_takesItsOriginFromTheLineAbove", () => {
    const note = "\\ No newline at end of file";
    const f = fx.file("a.txt", "Modified", [{ o: 3, n: 3, ctx: "", lines: [" c", note, "-d", note, "+d", note] }]);
    expect(f.hunks[0].lines.map((l) => [l.origin, l.old_lineno, l.new_lineno])).toEqual([
      [" ", 3, 3],
      ["=", 3, 3],
      ["-", 4, null],
      [">", 4, null],
      ["+", null, 4],
      ["<", null, 4],
    ]);
    expect([f.hunks[0].old_lines, f.hunks[0].new_lines]).toEqual([2, 2]);
  });

  it("test_fidelityStates_diffMany_isCutAtFiveHundredFiles", () => {
    const d = fixtureFor(null, ["diff-many"]);
    expect(d.select).toBe("314e219");
    const r = diffOf(d, fx.full("314e219"));
    expect([r.files.length, r.truncated]).toEqual([500, true]);
    expect(r.files[0].path).toBe("src/i18n/ar/app.json");
  });

  it("test_fidelityStates_diffEmpty_selectsACommitWithNoFiles", () => {
    const d = fixtureFor(null, ["diff-empty"]);
    expect(d.select).toBe("dd9ba36");
    expect(paths(d, "dd9ba36")).toEqual([]);
  });

  it("test_fidelityStates_diffError_failsTheDiffOnceOnTheLedger", () => {
    const d = fixtureFor(null, ["diff-error"]);
    // getDiff 只印錯誤碼（安全檢查 M01）：帳上寫它印的那一行，入口精確比對
    expect(d.failures).toEqual([
      {
        cmd: "git_get_diff",
        error: { code: "GIT_ERROR", message: "git operation failed" },
        times: 1,
        log: "[kira] getDiff failed: GIT_ERROR",
      },
    ]);
    expect(d.select).toBeNull();
  });

  // 名字藏著 RLO 的二進位檔與 stretched string：字元在執行時從碼位組（src 不放原始字元）
  it("test_fidelityStates_diffBidi_carriesTheControlsTheReferenceHides", () => {
    const d = fixtureFor(null, ["diff-bidi"]);
    expect(d.select).toBe("357dfda");
    const [binary, code] = diffOf(d, fx.full("357dfda")).files;
    expect(binary.path).toBe(`scripts/setup${String.fromCharCode(0x202e)}hs.exe`);
    expect(code.hunks[0].context).toContain(String.fromCharCode(0x2066));
  });
});

const lineOf = (routes: ReturnType<typeof computeRoutes>, short: string) =>
  routes.stations.find((st) => st.oid.startsWith(short))?.line;
