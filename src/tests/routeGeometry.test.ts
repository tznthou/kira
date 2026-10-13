import { describe, expect, it } from "vitest";
import { computeRoutes, type RouteMap } from "../lib/routeMap";
import {
  CASING_W,
  FLAKE_R,
  computeGeometry,
  hexPoints,
  pathD,
  ringRadius,
  shinePoints,
  terminusD,
  tickD,
  type Geometry,
} from "../lib/routeGeometry";
import type { BranchRef, CommitNode, GraphData } from "../lib/tauri";
import { graph as fixtureGraph } from "../dev/fidelity/fixture";
import routesGolden from "./fixtures/route-geometry/routes.json";
import youngGolden from "./fixtures/route-geometry/young.json";
import defaultGolden from "./fixtures/route-geometry/default.json";

// 座標速查（基準常數 ROW 34 / LANE 20 / X0 19）：欄 0..4 的 x = 19 39 59 79 99；
// 列 r 的站心 y = 34r + 17（17 51 85 119 153 187 221 …），列界 = 站心 ± 17。
// 期望值一律寫字面數字、不用模組的 X() / Y()：常數被改壞時兩邊才不會一起跟著變

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// ---- 合成歷史（id 直接當 full oid）----

/** [id, parents, message]；由上而下 = revwalk 順序（新到舊）；parent 不在清單裡 = 視窗外 */
type C = [id: string, parents: string[], message?: string];

interface Spec {
  commits: C[];
  local?: Record<string, string>;
  /** remote 分支 → target；name_on_remote = 去掉第一段 */
  remote?: Record<string, string>;
  /** 分支名、{ detached: oid }，或省略 = 讀不到 HEAD（沒有主幹候選時就沒有主幹） */
  head?: string | { detached: string };
  truncated?: boolean;
}

function graphOf(spec: Spec): GraphData {
  const local = Object.entries(spec.local ?? {}).map(
    ([name, target]): BranchRef => ({ name, target, is_remote: false, upstream: null, name_on_remote: null }),
  );
  const remote = Object.entries(spec.remote ?? {}).map(
    ([name, target]): BranchRef => ({
      name,
      target,
      is_remote: true,
      upstream: null,
      name_on_remote: name.slice(name.indexOf("/") + 1),
    }),
  );
  const head =
    spec.head === undefined
      ? { oid: null, branch: null }
      : typeof spec.head === "string"
        ? { oid: local.find((b) => b.name === spec.head)?.target ?? null, branch: spec.head }
        : { oid: spec.head.detached, branch: null };
  return {
    commits: spec.commits.map(([id, parents, message]) => ({
      oid: id.slice(0, 7),
      full_oid: id,
      message: message ?? `commit ${id}`,
      author: { name: "t", email: "t@example.com", timestamp: 0 },
      parents,
      refs: [],
    })),
    branches: [...local, ...remote],
    tags: [],
    truncated: spec.truncated ?? false,
    head,
    default_branch: null,
  };
}

/** 純函式：輸入凍結也能算、兩次結果相同 */
function geometryOf(input: Spec | GraphData) {
  const graph = deepFreeze("truncated" in input && "tags" in input ? input : graphOf(input));
  const routes: RouteMap = deepFreeze(computeRoutes(graph));
  const geo = computeGeometry(routes, graph);
  expect(computeGeometry(routes, graph)).toEqual(geo);
  const edge = (child: string, parent: string) => {
    const found = geo.edges.find((e) => e.child === child && e.parent === parent);
    expect(found, `${child} → ${parent}`).toBeDefined();
    return found?.pts;
  };
  const kind = (oid: string) => geo.stations.find((s) => s.oid === oid)?.kind;
  return { graph, routes, geo, edge, kind };
}

// ---- 示範狀態：照 mockup/tools/routes/state_routes.mjs 重建（CI 沒有 mockup/，不能 import）----

const OID_TAIL = fixtureGraph.commits[0].full_oid.slice(7);
const full = (id: string) => id + OID_TAIL;
const localRef = (name: string, target: string, upstream: string | null = `origin/${name}`): BranchRef => ({
  name,
  target: full(target),
  is_remote: false,
  upstream,
  name_on_remote: null,
});
const remoteRef = (name: string, target: string): BranchRef => ({
  name: `origin/${name}`,
  target: full(target),
  is_remote: true,
  upstream: null,
  name_on_remote: name,
});
const mk = (id: string, message: string, parents: string[], timestamp: number): CommitNode => ({
  oid: id,
  full_oid: full(id),
  message,
  parents: parents.map(full),
  refs: [],
  author: { ...fixtureGraph.commits[0].author, timestamp },
});

/** 後端的樣子：commit 的 refs 先分支後 tag；分支是 libgit2 列舉順序（local 在前、remote 在後，各依名稱） */
function withRefs(g: GraphData): GraphData {
  for (const c of g.commits) {
    c.refs = [
      ...g.branches.filter((b) => b.target === c.full_oid).map((b) => b.name),
      ...g.tags.filter((t) => t.target === c.full_oid).map((t) => t.name),
    ];
  }
  g.branches.sort((a, b) =>
    a.is_remote !== b.is_remote ? (a.is_remote ? 1 : -1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return g;
}

/** 基準的預設視窗（23 列，最底的 merge 兩個 parent 都在視窗外 → 截斷） */
const defaultState = (): GraphData => ({ ...structuredClone(fixtureGraph), truncated: true });

function youngState(): GraphData {
  return withRefs({
    commits: [
      mk("b41c7e2", "feat: open a repository and list its commits", ["5e0d9a3"], 1791100000),
      mk("5e0d9a3", "docs: add a README", ["a17f3c0"], 1791090000),
      mk("a17f3c0", "Initial commit", [], 1791080000),
    ],
    branches: [localRef("main", "b41c7e2", null)],
    tags: [],
    truncated: false,
    head: { oid: full("b41c7e2"), branch: "main" },
    default_branch: null,
  });
}

function routesState(): GraphData {
  // 訊息照 state_routes.mjs（e07b52d 寫 centred；基準寫 centered，不影響走線）
  const rows: [string, string, string[]][] = [
    ["3fa2c71", "feat(search): rank matches by how recently a note was opened", ["9d4e6a0"]],
    ["b6d0e94", "feat(notes): pin a note to the top of its notebook", ["e07b52d"]],
    ["58c1a3f", "feat(legend): show the legend beside the map", ["a6f38d1"]],
    ["e07b52d", "fix: keep the map centred when the window resizes", ["c21f8b7"]],
    ["9d4e6a0", "Merge branch 'main' into feat/search", ["71ae3d9", "c21f8b7"]],
    ["c21f8b7", "feat: open notes from the command palette", ["a6f38d1"]],
    ["4b9c0e2", "fix(gutter): keep the gutter off the scrollbar", ["a6f38d1"]],
    ["71ae3d9", "feat(search): search note titles as you type", ["d83b2f6"]],
    ["a6f38d1", "refactor: move map tiles into their own module", ["0e5d7b4"]],
    ["0e5d7b4", "docs: describe the keyboard shortcuts", ["d83b2f6"]],
    ["7c4e1a9", "fix(compass): point north again after the map resets", ["d83b2f6"]],
    ["d83b2f6", "feat: draw the map from tiles", ["6c1e9a8"]],
    ["6c1e9a8", "chore: add a lint script", ["f4a7d05"]],
    ["f4a7d05", "feat: open a notebook from disk", ["2b8e4c1"]],
  ];
  return withRefs({
    commits: rows.map(([id, message, parents], i) => mk(id, message, parents, 1791200000 - i * 5400)),
    branches: [
      localRef("feat/search", "3fa2c71"),
      remoteRef("feat/search", "3fa2c71"),
      localRef("feat/notes", "b6d0e94", null),
      localRef("feat/legend", "58c1a3f", null),
      localRef("main", "e07b52d"),
      remoteRef("main", "e07b52d"),
      localRef("fix/gutter", "4b9c0e2", null),
      localRef("fix/compass", "7c4e1a9", null),
    ],
    tags: [],
    truncated: true,
    head: { oid: full("3fa2c71"), branch: "feat/search" },
    default_branch: "main",
  });
}

// ---- 黃金資料：route_cases.mjs（走線的第二份實作）的 --json 輸出，檔頭 _source 寫明出處 ----

interface Golden {
  lines: { color: string; pts: number[][] }[];
  crossings: { lower: number[][]; x: number; y: number }[];
}

/** 繪製順序逐條（顏色、折線）相同；橋 = （被挖洞的下層線, 交點）同一組 */
function expectGolden(geo: Geometry, golden: Golden) {
  expect(geo.edges.map(({ color, pts }) => ({ color, pts }))).toEqual(golden.lines);
  const bridges = [...geo.holes].flatMap(([n, holes]) => holes.map((h) => JSON.stringify([geo.edges[n].pts, ...h.at])));
  expect(bridges.sort()).toEqual(golden.crossings.map((c) => JSON.stringify([c.lower, c.x, c.y])).sort());
}

describe("computeGeometry vs route_cases on the reference states", () => {
  // 站型：基準 drawMap（1135-1158）對 applyState 的同一份示範資料畫出的（2026-10-08 以基準原始碼實跑）。
  // 尺寸：基準的 W = X(站的最大欄 + 1) + 8、--gutter = X(站的最大欄) + 24；這些狀態的 slotCount 都 = 站的最大欄 + 1
  it("test_routeGeometry_routesState_matchesRouteCasesWithItsThreeBridges", () => {
    const { geo } = geometryOf(routesState());
    expectGolden(geo, routesGolden);
    expect(routesGolden.crossings).toHaveLength(3);
    expect([geo.width, geo.height, geo.gutter, geo.fadeFrom]).toEqual([107, 506, 103, 470]);
    expect(geo.stations.map((s) => s.kind)).toEqual([
      "head", "terminus", "terminus", "interchange", "interchange", "tick", "terminus",
      "tick", "interchange", "tick", "terminus", "interchange", "tick", "tick",
    ]);
  });

  it("test_routeGeometry_youngState_matchesRouteCasesAndEndsTheLineAtTheRoot", () => {
    const { geo } = geometryOf(youngState());
    expectGolden(geo, youngGolden);
    expect([geo.width, geo.height, geo.gutter, geo.fadeFrom]).toEqual([47, 114, 43, null]);
    expect(geo.stations.map((s) => s.kind)).toEqual(["head", "tick", "terminus"]);
  });

  it("test_routeGeometry_defaultState_matchesRouteCasesAndFadesUnderTheLastRow", () => {
    const { geo } = geometryOf(defaultState());
    expectGolden(geo, defaultGolden);
    expect([geo.width, geo.height, geo.gutter, geo.fadeFrom]).toEqual([87, 812, 83, 776]);
    expect(geo.stations.map((s) => s.kind)).toEqual([
      "head", "terminus", "tick", "tick", "interchange", "interchange", "tick", "tick", "tick", "interchange",
      "tick", "tick", "tick", "tick", "tick", "tick", "tick", "interchange", "interchange", "tick",
      "interchange", "tick", "interchange",
    ]);
  });
});

// ---- 規則 1：跨 1–2 欄且 dx ≤ dy → 單一 45° ----

describe("rule 1: one 45° turn", () => {
  it("test_routeGeometry_oneColumnLinks_forkTurnsAtTheParentMergeAtItself", () => {
    const { edge } = geometryOf({
      commits: [["m3", ["m2", "f1"], "Merge branch 'feat'"], ["f1", ["m1"]], ["m2", ["m1"]], ["m1", []]],
      local: { main: "m3" },
      head: "main",
    });
    // merge：從自己這站 45° 出去、再沿 parent 那欄直下
    expect(edge("m3", "f1")).toEqual([[19, 17], [39, 37], [39, 51]]);
    // fork：沿自己那欄直下、到 parent 前才 45° 轉進去
    expect(edge("f1", "m1")).toEqual([[39, 51], [39, 99], [19, 119]]);
  });

  it("test_routeGeometry_twoColumnLinks_stillTurnOnceWhenTallEnough", () => {
    const fork = geometryOf({
      commits: [["a1", ["m1"]], ["b1", ["m1"]], ["m2", ["m1"]], ["m1", []]],
      local: { main: "m2", a: "a1", b: "b1" },
      head: "main",
    });
    expect(fork.edge("b1", "m1")).toEqual([[59, 51], [59, 79], [19, 119]]);
    const merge = geometryOf({
      commits: [
        ["a2", ["a1"]],
        ["m3", ["m2", "b1"], "Merge branch 'b'"],
        ["m2", ["m1"]],
        ["b1", ["m1"]],
        ["a1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m3", a: "a2" },
      head: "main",
    });
    expect(merge.edge("m3", "b1")).toEqual([[19, 51], [59, 91], [59, 119]]);
  });
});

// ---- 規則 2：跨 3 欄以上或 dx > dy → Z（水平段沿列界）----

describe("rule 2: a Z along the row boundary", () => {
  it("test_routeGeometry_forkAcrossThreeColumns_dropsThenRunsAlongTheBoundaryAboveTheParent", () => {
    const { edge } = geometryOf({
      commits: [["a1", ["m0"]], ["b1", ["m0"]], ["c1", ["m1"]], ["m2", ["m1"]], ["m1", ["m0"]], ["m0", []]],
      local: { main: "m2", a: "a1", b: "b1", c: "c1" },
      head: "main",
    });
    // 欄 3 → 欄 0：直下到 parent 的上一列（119）→ 45° 到列界 136 → 沿列界 → 45° 進站
    expect(edge("c1", "m1")).toEqual([[79, 85], [79, 119], [62, 136], [36, 136], [19, 153]]);
  });

  it("test_routeGeometry_forkWiderThanTall_runsTheZWithoutADrop", () => {
    const { edge } = geometryOf({
      commits: [["a1", ["m0"]], ["b1", ["m1"]], ["m1", ["m0"]], ["m0", []]],
      local: { main: "m1", a: "a1", b: "b1" },
      head: "main",
    });
    // 隔壁列跨 2 欄：dx 40 > dy 34
    expect(edge("b1", "m1")).toEqual([[59, 51], [42, 68], [36, 68], [19, 85]]);
  });

  it("test_routeGeometry_mergeAcrossThreeColumns_runsTheBoundaryThenDownTheParentsColumn", () => {
    const { edge } = geometryOf({
      commits: [
        ["a2", ["a1"]],
        ["b2", ["b1"]],
        ["m3", ["m2", "c1"], "Merge branch 'c'"],
        ["m2", ["m1"]],
        ["c1", ["gone"]],
        ["b1", ["m0"]],
        ["a1", ["m0"]],
        ["m1", ["m0"]],
        ["m0", []],
      ],
      local: { main: "m3", a: "a2", b: "b2" },
      head: "main",
      truncated: true,
    });
    expect(edge("m3", "c1")).toEqual([[19, 85], [36, 102], [62, 102], [79, 119], [79, 153]]);
  });

  it("test_routeGeometry_mergeWiderThanTall_runsTheZStraightIntoTheParent", () => {
    const { edge } = geometryOf({
      commits: [
        ["a2", ["a1"]],
        ["m3", ["m2", "b1"], "Merge branch 'b'"],
        ["b1", ["m1"]],
        ["a1", ["m1"]],
        ["m2", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m3", a: "a2" },
      head: "main",
    });
    expect(edge("m3", "b1")).toEqual([[19, 51], [36, 68], [42, 68], [59, 85]]);
  });
});

// ---- 規則 3：反向 merge（parent 那欄已有直線從上方進站）走空隙；merge 先看這條 ----

describe("rule 3: a reverse merge takes the gap", () => {
  it("test_routeGeometry_reverseMerge_runsDownTheGapBesideTheParentsColumn", () => {
    const { edge } = geometryOf({
      commits: [
        ["m3", ["m2"]],
        ["x2", ["x1", "m2"], "Merge branch 'main' into x"],
        ["m2", ["m1"]],
        ["x1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m3", x: "x2" },
      head: "main",
    });
    // 規則 1 會是 [[39,51],[19,71],[19,85]]，最後 14px 疊在主幹的直線上；改走欄 0 與欄 1 之間的空隙 x = 29
    expect(edge("x2", "m2")).toEqual([[39, 51], [29, 61], [29, 75], [19, 85]]);
  });

  it("test_routeGeometry_reverseMergeWithoutRoom_isOneStraightSlant", () => {
    const { edge, geo } = geometryOf({
      commits: [
        ["a2", ["a1"]],
        ["m3", ["m2"]],
        ["x2", ["x1", "m2"], "Merge branch 'main' into x"],
        ["m2", ["m1"]],
        ["x1", ["m1"]],
        ["a1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m3", a: "a2", x: "x2" },
      head: "main",
    });
    // 跨 2 欄到隔壁列：到空隙要走 30px，只有 34 − 10 = 24 → 一條直線斜接（不是規則 2 的 Z）
    expect(edge("x2", "m2")).toEqual([[59, 85], [19, 119]]);
    // 斜線跨過欄 1 的直線：洞的端點是浮點數，與基準同一個算式算出來
    const run = geo.edges.findIndex((e) => e.child === "a2");
    expect(geo.holes.get(run)).toEqual([{ at: [39, 102], cut: [[33, 107.1], [45, 96.9]] }]);
  });
});

// ---- 規則 4：繪製順序與橋 ----

/** 一站同時 merge 三條線（欄 1 / 2 / 3），三條再各自 fork 回同一站 */
const fanOut: Spec = {
  commits: [
    ["m2", ["m1", "a1", "b1", "c1"], "Merge branches 'a', 'b' and 'c'"],
    ["c1", ["m1"]],
    ["b1", ["m1"]],
    ["a1", ["m1"]],
    ["m1", []],
  ],
  local: { main: "m2" },
  head: "main",
};

describe("rule 4: drawing order and bridges", () => {
  it("test_routeGeometry_links_fillTheirPlacesFromTheFarthestReachToTheNearest", () => {
    const { geo } = geometryOf(fanOut);
    // 軌道順序：m2→m1、m2→a1、m2→b1、m2→c1、c1→m1、b1→m1、a1→m1。直線留在原位；
    // 連接線的位置依跨距 60 → 40 → 20 重排，同跨距維持軌道順序
    expect(geo.edges.map((e) => `${e.child}→${e.parent}`)).toEqual([
      "m2→m1", "m2→c1", "c1→m1", "m2→b1", "b1→m1", "m2→a1", "a1→m1",
    ]);
    expect(geo.edges.map((e) => e.link)).toEqual([false, true, true, true, true, true, true]);
    // 匯在一起的線彼此不切
    expect(geo.holes.size).toBe(0);
  });

  it("test_routeGeometry_bridge_cutsTheStraightStretchWhicheverIsDrawnFirst", () => {
    const { geo } = geometryOf({
      commits: [
        ["a1", ["gone-a"]],
        ["m2", ["m1", "gone-x"], "Merge branch 'feat/x'"],
        ["m1", ["m0", "gone-y"], "Merge branch 'feat/y'"],
        ["m0", ["gone-m"]],
      ],
      local: { main: "m2", a: "a1" },
      head: "main",
      truncated: true,
    });
    const at = (child: string, parent: string) => geo.edges.findIndex((e) => e.child === child && e.parent === parent);
    const z = at("m1", "gone-y");
    const slant = at("m2", "gone-x");
    const run = at("a1", "gone-a");
    expect(run).toBeLessThan(z);
    expect(z).toBeLessThan(slant);
    // 欄 1 的直線比上層兩條都先畫，照樣被挖兩個洞；45° 那條比 Z 晚畫，它的直段照樣被 Z 的列界挖洞。
    // 洞沿上層那段 ±6、裁在那段的範圍內（Z 的列界從 36 起，所以第一個洞左端是 36 不是 33）
    expect([...geo.holes]).toEqual([
      [
        run,
        [
          { at: [39, 102], cut: [[36, 102], [45, 102]] },
          { at: [39, 71], cut: [[33, 65], [45, 77]] },
        ],
      ],
      [slant, [{ at: [59, 102], cut: [[53, 102], [62, 102]] }]],
    ]);
  });

  it("test_routeGeometry_holeWidth_isTheCasingWidth", () => {
    // 洞的寬度由元件畫（stroke-width），值是這裡給的常數：線寬 3.25 + 3.5（基準 1127、1131）
    expect(CASING_W).toBe(6.75);
    expect(pathD([[36, 102], [45, 102]])).toBe("M36 102L45 102");
  });
});

// ---- 橋的預算（基準沒有）----

/** 每列 merge 3 個視窗外、各自不同的舊 commit：每條都直下到底，被後面每一列沿列界的水平段穿過 → 洞數隨列數平方成長 */
const mergesBeyond = (rows: number) =>
  Array.from({ length: rows }, (_, r): C => [`c${r}`, [`c${r + 1}`, `gone-${r}-0`, `gone-${r}-1`, `gone-${r}-2`], "Merge branches"]);

/** n 條 fork 再 merge 回主幹的短分支，fork 與 merge 都只跨一欄、彼此不交叉：只增加搜尋量，不增加洞 */
const sideBranches = (n: number, below: string) =>
  Array.from({ length: n }, (_, i): C[] => [
    [`m${i}`, [`t${i}`, `s${i}`], `Merge branch 's${i}'`],
    [`s${i}`, [`t${i}`]],
    [`t${i}`, [i + 1 < n ? `m${i + 1}` : below]],
  ]).flat();

const holeCount = (geo: Geometry) => [...geo.holes.values()].reduce((n, list) => n + list.length, 0);

describe("bridge budget", () => {
  it("test_routeGeometry_tooManyHoles_drawsNoBridgesAtAllNotTheFirstFiftyThousand", () => {
    // 100 列 43,647 個洞，在預算（5 萬）內照挖；120 列 59,007 個，整張不挖。兩者的搜尋量都遠低於上限
    const kept = geometryOf({ commits: mergesBeyond(100), local: { main: "c0" }, head: "main", truncated: true });
    expect(holeCount(kept.geo)).toBe(43647);
    const over = geometryOf({ commits: mergesBeyond(120), local: { main: "c0" }, head: "main", truncated: true });
    expect(over.geo.holes.size).toBe(0);
    // 線照畫
    expect(over.geo.edges).toHaveLength(480);
  });

  it("test_routeGeometry_tooMuchSearching_drawsNoBridgesThoughTheHolesWouldFit", () => {
    // 30 列（3915 個洞）的上方墊不交叉的短分支：洞數不變。墊 1000 條（搜尋量 935 萬）照挖；
    // 墊 2000 條（3,466 萬，超過 2,000 萬）整張不挖——洞數仍遠在 5 萬內，所以是搜尋量擋下的
    const fewer = geometryOf({ commits: [...sideBranches(1000, "c0"), ...mergesBeyond(30)], local: { main: "m0" }, head: "main", truncated: true });
    expect(holeCount(fewer.geo)).toBe(3915);
    const more = geometryOf({ commits: [...sideBranches(2000, "c0"), ...mergesBeyond(30)], local: { main: "m0" }, head: "main", truncated: true });
    expect(more.geo.holes.size).toBe(0);
  });
});

// ---- 規則 5：列界匯流 ----

describe("rule 5: links join the boundary beside a station", () => {
  it("test_routeGeometry_routesState_twoColumnForkBesideABoundaryRunBecomesAZ", () => {
    const { edge } = geometryOf(routesState());
    // legend 跨 3 欄沿列界 272 進 a6f38d1；gutter 跨 2 欄（規則 1 會是 [[59,221],[59,249],[19,289]]）併進同一條列界
    expect(edge(full("58c1a3f"), full("a6f38d1"))).toEqual([[79, 85], [79, 255], [62, 272], [36, 272], [19, 289]]);
    expect(edge(full("4b9c0e2"), full("a6f38d1"))).toEqual([[59, 221], [59, 255], [42, 272], [36, 272], [19, 289]]);
  });

  it("test_routeGeometry_routesState_oneColumnForkBesideABoundaryRunTakesAMiniZ", () => {
    const { edge } = geometryOf(routesState());
    // compass 受限 Z 沿列界 374 進 d83b2f6；search 跨 1 欄（規則 1 會是 [[39,255],[39,371],[19,391]]）
    // 沿自己那欄直下到列界、沿列界 3px、接同一段 45°
    expect(edge(full("7c4e1a9"), full("d83b2f6"))).toEqual([[59, 357], [42, 374], [36, 374], [19, 391]]);
    expect(edge(full("71ae3d9"), full("d83b2f6"))).toEqual([[39, 255], [39, 374], [36, 374], [19, 391]]);
  });

  it("test_routeGeometry_mergesOutOfAStation_joinTheBoundaryLikeForksInto", () => {
    const { edge } = geometryOf(fanOut);
    // 出站：c 跨 3 欄沿列界 34 出 m2 → b（2 欄）改走 Z、a（1 欄）先接同一段 45° → 沿列界 3px → 直下
    expect(edge("m2", "c1")).toEqual([[19, 17], [36, 34], [62, 34], [79, 51]]);
    expect(edge("m2", "b1")).toEqual([[19, 17], [36, 34], [42, 34], [59, 51], [59, 85]]);
    expect(edge("m2", "a1")).toEqual([[19, 17], [36, 34], [39, 34], [39, 119]]);
    // 進站：c 跨 3 欄沿列界 136 進 m1 → b 改走 Z、a 走迷你 Z
    expect(edge("c1", "m1")).toEqual([[79, 51], [79, 119], [62, 136], [36, 136], [19, 153]]);
    expect(edge("b1", "m1")).toEqual([[59, 85], [59, 119], [42, 136], [36, 136], [19, 153]]);
    expect(edge("a1", "m1")).toEqual([[39, 119], [39, 136], [36, 136], [19, 153]]);
  });

  it("test_routeGeometry_joinedLinks_leaveTheirOtherEndStraightSoNothingCascades", () => {
    const { edge } = geometryOf(fanOut);
    // 改走的線另一端（fork 的子站、merge 的 parent）直進直出：不會在那裡多出一條沿列界的進出，帶動別條
    const vertical = (pts: number[][] | undefined, end: "first" | "last") => {
      const [a, b] = end === "first" ? (pts ?? []).slice(0, 2) : (pts ?? []).slice(-2);
      return a[0] === b[0];
    };
    expect(vertical(edge("m2", "b1"), "last")).toBe(true);
    expect(vertical(edge("m2", "a1"), "last")).toBe(true);
    expect(vertical(edge("b1", "m1"), "first")).toBe(true);
    expect(vertical(edge("a1", "m1"), "first")).toBe(true);
  });

  it("test_routeGeometry_boundaryRunFromOneSide_leavesTheOtherSideAt45", () => {
    const { edge } = geometryOf({
      // 沒有主幹：c 在欄 0、p 在欄 3（origin/p 停在 P，c 的認領停在 P 之前）、r 在欄 4
      commits: [
        ["c1", ["P"]],
        ["f1", ["gone-f"]],
        ["g1", ["gone-g"]],
        ["p2", ["P"]],
        ["r1", ["P"]],
        ["P", ["x"]],
        ["x", []],
      ],
      local: { c: "c1", f: "f1", g: "g1", p: "p2", r: "r1" },
      remote: { "origin/p": "P" },
      truncated: true,
    });
    // c 從左側跨 3 欄沿列界 170 進 P；r 從右側跨 1 欄，那一側沒有沿列界進站的線 → 照舊單一 45°
    expect(edge("c1", "P")).toEqual([[19, 17], [19, 153], [36, 170], [62, 170], [79, 187]]);
    expect(edge("r1", "P")).toEqual([[99, 153], [99, 167], [79, 187]]);
  });
});

// ---- 視窗外 merge、尺寸 ----

describe("window edges and size", () => {
  // 欄 1 的線一路延伸出視窗；主幹兩個 merge 的第二個 parent 都在視窗外 → 軌道線 feat/x 在欄 2、feat/y 在欄 3，
  // 站最多只到欄 1（v8fixture 前 125 列就是這個結構：軌道線在欄 3、站最多到欄 2）
  const beyond: Spec = {
    commits: [
      ["a1", ["gone-a"]],
      ["m2", ["m1", "gone-x"], "Merge branch 'feat/x'"],
      ["m1", ["m0", "gone-y"], "Merge branch 'feat/y'"],
      ["m0", ["gone-m"]],
    ],
    local: { main: "m2", a: "a1" },
    head: "main",
    truncated: true,
  };

  it("test_routeGeometry_mergeBeyondTheWindow_goesToItsTrackLinesColumn", () => {
    const { edge, routes } = geometryOf(beyond);
    expect(routes.lines.filter((l) => l.stations.length === 0).map((l) => [l.id, l.slot])).toEqual([
      ["feat/x", 2],
      ["feat/y", 3],
    ]);
    // 基準的 X(c.lane + 1) 會把兩條都接到欄 1、疊在 a 的線上
    expect(edge("m2", "gone-x")).toEqual([[19, 51], [59, 91], [59, 166]]);
    expect(edge("m1", "gone-y")).toEqual([[19, 85], [36, 102], [62, 102], [79, 119], [79, 166]]);
  });

  it("test_routeGeometry_firstParentBeyondTheWindow_runsStraightToTheBottom", () => {
    const { edge, geo } = geometryOf(beyond);
    expect(edge("a1", "gone-a")).toEqual([[39, 17], [39, 166]]);
    expect(edge("m0", "gone-m")).toEqual([[19, 119], [19, 166]]);
    expect(geo.edges.find((e) => e.child === "a1")?.link).toBe(false);
  });

  it("test_routeGeometry_trackLineRightOfEveryStation_widthAndGutterFollowSlotCount", () => {
    const { geo } = geometryOf(beyond);
    // slotCount 4：寬 = X(4) + 8、--gutter = X(3) + 24。照基準用站的最大欄（1）會是 67 / 63，欄 3 的線心 79 落在列的左留白外
    expect([geo.width, geo.gutter]).toEqual([107, 103]);
  });

  it("test_routeGeometry_truncated_leavesRoomForTheFadeUnderTheLastRow", () => {
    const { geo } = geometryOf(beyond);
    // 4 列 × 34 + 30；淡出從最後一列站心（119）下方 11px 起
    expect([geo.height, geo.fadeFrom]).toEqual([166, 130]);
  });

  it("test_routeGeometry_notTruncated_endsTwelvePixelsUnderTheLastRowWithoutAFade", () => {
    const { geo } = geometryOf({ commits: [["m1", ["m0"]], ["m0", []]], local: { main: "m1" }, head: "main" });
    expect([geo.height, geo.fadeFrom]).toEqual([80, null]);
  });

  it("test_routeGeometry_emptyRepo_isOneColumnWideWithNothingToDraw", () => {
    const { geo, routes } = geometryOf({ commits: [], head: "main" });
    expect(routes.slotCount).toBe(0);
    expect(geo).toEqual({ width: 47, height: 12, gutter: 43, fadeFrom: null, edges: [], holes: new Map(), stations: [] });
  });
});

// ---- 站型：HEAD → 轉乘 → 終點（沒有子 commit 或是根）→ 一般短刻 ----

describe("station kinds", () => {
  it("test_routeGeometry_rootWithAChild_isATerminusThoughRouteMapCallsItAStation", () => {
    const { kind, routes } = geometryOf({ commits: [["m2", ["m1"]], ["m1", ["m0"]], ["m0", []]], local: { main: "m2" }, head: "main" });
    expect(routes.stations[2].role).toBe("station");
    expect(["m2", "m1", "m0"].map(kind)).toEqual(["head", "tick", "terminus"]);
  });

  it("test_routeGeometry_rootWithoutChildren_isATerminus", () => {
    const { kind } = geometryOf({
      commits: [["m1", ["m0"]], ["m0", []], ["p0", []]],
      local: { main: "m1", lone: "p0" },
      head: "main",
    });
    expect(kind("p0")).toBe("terminus");
  });

  it("test_routeGeometry_rootWhereALineForks_isAnInterchange", () => {
    const { kind } = geometryOf({
      commits: [["f1", ["m0"]], ["m1", ["m0"]], ["m0", []]],
      local: { main: "m1", feat: "f1" },
      head: "main",
    });
    expect(kind("m0")).toBe("interchange");
  });

  it("test_routeGeometry_rootAtHead_isTheGoldFlake", () => {
    const detached = geometryOf({ commits: [["m2", ["m1"]], ["m1", ["m0"]], ["m0", []]], local: { main: "m2" }, head: { detached: "m0" } });
    expect(["m2", "m1", "m0"].map(detached.kind)).toEqual(["terminus", "tick", "head"]);
    const lone = geometryOf({ commits: [["m0", []]], local: { main: "m0" }, head: "main" });
    expect(lone.kind("m0")).toBe("head");
  });

  it("test_routeGeometry_twoUnrelatedHistories_eachEndsInATerminusAtBothEnds", () => {
    const { kind } = geometryOf({
      commits: [["m1", ["m0"]], ["p1", ["p0"]], ["m0", []], ["p0", []]],
      local: { main: "m1", "gh-pages": "p1" },
      head: "main",
    });
    expect(["m1", "p1", "m0", "p0"].map(kind)).toEqual(["head", "terminus", "terminus", "terminus"]);
  });

  it("test_routeGeometry_stations_sitOnTheirLinesColumnInTheLinesColour", () => {
    const { geo } = geometryOf({
      commits: [["m3", ["m2", "f1"], "Merge branch 'feat'"], ["f1", ["m1"]], ["m2", ["m1"]], ["m1", []]],
      local: { main: "m3" },
      head: "main",
    });
    expect(geo.stations.map(({ oid, x, y, kind, color }) => [oid, x, y, kind, color])).toEqual([
      ["m3", 19, 17, "head", "trunk"],
      ["f1", 39, 51, "tick", "gunjo"],
      ["m2", 19, 85, "tick", "trunk"],
      ["m1", 19, 119, "interchange", "trunk"],
    ]);
  });
});

// ---- 字串：元件照用；期望值是基準原始碼（996-1003、1150、1155、1157、1180）對同樣輸入算出的 ----

describe("SVG strings", () => {
  it("test_routeGeometry_pathD_writesTheReferencesPathFormat", () => {
    expect(pathD([[39, 17], [39, 153]])).toBe("M39 17L39 153");
    expect(pathD([[19, 85], [36, 102], [62, 102]])).toBe("M19 85L36 102L62 102");
    expect(pathD([[33, 107.1], [45, 96.9]])).toBe("M33 107.1L45 96.9");
  });

  it("test_routeGeometry_goldFlake_mixesRawNumbersAndToFixedLikeTheReference", () => {
    expect(FLAKE_R).toBe(8.4);
    expect(hexPoints(19, 17, FLAKE_R)).toBe("19.00,8.60 26.27,12.80 26.27,21.20 19.00,25.40 11.73,21.20 11.73,12.80");
    expect(hexPoints(59, 4131, FLAKE_R)).toBe(
      "59.00,4122.60 66.27,4126.80 66.27,4135.20 59.00,4139.40 51.73,4135.20 51.73,4126.80",
    );
    expect(shinePoints(19, 17)).toBe("19,8.6 19,17 26.27,12.80");
    expect(shinePoints(59, 4131)).toBe("59,4122.6 59,4131 66.27,4126.80");
  });

  it("test_routeGeometry_stationMarks_andSelectionRing_matchTheReference", () => {
    expect(terminusD(19, 17)).toBe("M12.5 17H25.5");
    expect(tickD(39, 51)).toBe("M39 51H46.5");
    expect([ringRadius(true), ringRadius(false)]).toEqual([12.5, 9.5]);
  });
});
