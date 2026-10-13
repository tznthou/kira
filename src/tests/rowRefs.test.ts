import { describe, expect, it } from "vitest";
import { computeRoutes, type RefPlacement } from "../lib/routeMap";
import { rowRefs, type RowRefs } from "../lib/rowRefs";
import type { BranchRef, GraphData } from "../lib/tauri";
import { graph as fixtureGraph } from "../dev/fidelity/fixture";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** 純函式：輸入凍結也能算、兩次結果相同 */
function refsAt(graph: GraphData, oid: string): RowRefs {
  const frozen = deepFreeze(graph);
  const routes = deepFreeze(computeRoutes(frozen));
  const got = rowRefs(routes, oid, frozen.head);
  expect(rowRefs(routes, oid, frozen.head)).toEqual(got);
  return got;
}

const labels = (r: Pick<RowRefs, "shown" | "folded">) => r.shown.map((s) => s.label);

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

const defaultState = (): GraphData => ({ ...structuredClone(fixtureGraph), truncated: true });

function longRefsState(): GraphData {
  const g = defaultState();
  const long = "feat/t14-unstaged-cap-and-console-discipline";
  g.branches = g.branches.filter((b) => !b.name.endsWith("fix/toolbar-jump"));
  g.branches.push(localRef(long, "e81d6b0"), remoteRef(long, "e81d6b0"));
  g.tags.push({ name: "v0.1.0", target: full("dd9ba36") });
  g.branches.push(localRef("release/0.1", "dd9ba36"), remoteRef("release/0.1", "dd9ba36"));
  return withRefs(g);
}

function lodgerState(): GraphData {
  const g = defaultState();
  g.branches.push(localRef("release/0.1", "63421cf"), remoteRef("release/0.1", "63421cf"));
  return withRefs(g);
}

function newBranchState(): GraphData {
  const g = defaultState();
  g.branches.push(localRef("feat/v8-graph", "dd9ba36", null));
  g.head = { oid: full("dd9ba36"), branch: "feat/v8-graph" };
  return withRefs(g);
}

// ---- 合成歷史（id 直接當 full oid）：只有 t1 一站放 ref ----

interface Spec {
  /** local 分支 → target，或 [target, upstream] */
  local?: Record<string, string | [string, string]>;
  /** remote 分支 → target（name_on_remote = 去掉第一段），或 [target, name_on_remote] */
  remote?: Record<string, string | [string, string | null]>;
  tags?: Record<string, string>;
  head?: string | { detached: string };
}

/** t1 在欄 1、從主幹 m1 分出去；ref 依 Spec 的寫法順序列（模擬不照名稱排的列舉） */
function graphOf(spec: Spec): GraphData {
  const local = Object.entries(spec.local ?? {}).map(
    ([name, v]): BranchRef => ({
      name,
      target: typeof v === "string" ? v : v[0],
      is_remote: false,
      upstream: typeof v === "string" ? null : v[1],
      name_on_remote: null,
    }),
  );
  const remote = Object.entries(spec.remote ?? {}).map(
    ([name, v]): BranchRef => ({
      name,
      target: typeof v === "string" ? v : v[0],
      is_remote: true,
      upstream: null,
      name_on_remote: typeof v === "string" ? name.slice(name.indexOf("/") + 1) : v[1],
    }),
  );
  const head =
    spec.head === undefined
      ? { oid: null, branch: null }
      : typeof spec.head === "string"
        ? { oid: local.find((b) => b.name === spec.head)?.target ?? null, branch: spec.head }
        : { oid: spec.head.detached, branch: null };
  return {
    commits: [
      ["t1", ["m1"]],
      ["m1", ["m0"]],
      ["m0", []],
    ].map(([id, parents]) => ({
      oid: id as string,
      full_oid: id as string,
      message: `commit ${id}`,
      author: { name: "t", email: "t@example.com", timestamp: 0 },
      parents: parents as string[],
      refs: [],
    })),
    branches: [{ name: "main", target: "m1", is_remote: false, upstream: null, name_on_remote: null }, ...local, ...remote],
    tags: Object.entries(spec.tags ?? {}).map(([name, target]) => ({ name, target })),
    truncated: false,
    head,
    default_branch: "main",
  };
}

describe("rowRefs on the reference states", () => {
  it("test_rowRefs_defaultFixtureMain_showsMainItsOriginAndTheTag", () => {
    const { shown, folded } = refsAt(defaultState(), full("dd9ba36"));
    expect(shown).toEqual([
      { kind: "local", name: "main", label: "main", color: "trunk", letter: "M", hollow: false, lodge: false },
      { kind: "remote", name: "origin/main", label: "origin", color: "trunk", letter: "M", hollow: true, lodge: false },
      { kind: "tag", name: "v0.1.0-rc.1", label: "v0.1.0-rc.1", color: null, letter: "", hollow: false, lodge: false },
    ]);
    expect(folded).toEqual([]);
  });

  it("test_rowRefs_defaultFixtureHead_isTheHeadBranchOnItsOwnLineWithoutAPill", () => {
    const { shown } = refsAt(defaultState(), full("c9e41f2"));
    expect(shown).toEqual([
      {
        kind: "head",
        name: "feat/t15g-graph-density",
        label: "feat/t15g-graph-density",
        color: "rokusho",
        letter: "T",
        hollow: false,
        lodge: false,
      },
    ]);
  });

  it("test_rowRefs_remoteWithoutItsBranchHere_keepsItsFullName", () => {
    // 4f2a9c1 只有 origin/feat/t15g-graph-density（本機分支已經往前走）：沒有 owner，寫全名、自己的線
    const { shown } = refsAt(defaultState(), full("4f2a9c1"));
    expect(shown.map((s) => [s.label, s.color, s.letter, s.hollow])).toEqual([
      ["origin/feat/t15g-graph-density", "rokusho", "T", true],
    ]);
  });

  it("test_rowRefs_longRefsMain_foldsWhatPassesTheBudgetIntoPlusN", () => {
    // 基準 long-refs 的 dd9ba36：main 4 + origin 6 + release/0.1 11 + origin 6 + v0.1.0 6 = 33；再加 v0.1.0-rc.1 就 44
    const { shown, folded } = refsAt(longRefsState(), full("dd9ba36"));
    expect(labels({ shown, folded })).toEqual(["main", "origin", "release/0.1", "origin", "v0.1.0"]);
    expect(folded).toEqual(["v0.1.0-rc.1"]);
    // release/0.1 與它的 origin 寄宿在主幹上：無字、--l 用主幹的色
    expect(shown.slice(2, 4).map((s) => [s.name, s.color, s.letter, s.hollow, s.lodge])).toEqual([
      ["release/0.1", "trunk", "", false, true],
      ["origin/release/0.1", "trunk", "", true, true],
    ]);
  });

  it("test_rowRefs_spoken_namesEveryRefInOrderTheFoldedTooWithHeadAndTagsMarked", () => {
    // 期望值 = 基準 aria-label 的「Refs:」之後（4b step 0 探針實跑，基準 2026-10-08 的版本）
    const spoken = (graph: GraphData, id: string) => refsAt(graph, full(id)).spoken.join(", ");
    expect(spoken(defaultState(), "c9e41f2")).toBe("feat/t15g-graph-density (HEAD)");
    expect(spoken(defaultState(), "e81d6b0")).toBe("fix/toolbar-jump, origin/fix/toolbar-jump");
    expect(spoken(defaultState(), "dd9ba36")).toBe("main, origin/main, tag v0.1.0-rc.1");
    const detached = defaultState();
    detached.head = { oid: full("7b03d5e"), branch: null };
    expect(spoken(detached, "7b03d5e")).toBe("HEAD (detached)");
    // 收進 +1 的 v0.1.0-rc.1 也念
    expect(spoken(longRefsState(), "dd9ba36")).toBe(
      "main, origin/main, release/0.1, origin/release/0.1, tag v0.1.0, tag v0.1.0-rc.1",
    );
  });

  it("test_rowRefs_longBranchName_isCutAndItsOwnOriginStillFits", () => {
    const { shown, folded } = refsAt(longRefsState(), full("e81d6b0"));
    expect(shown.map((s) => [s.kind, s.name, s.label, s.color, s.letter])).toEqual([
      ["local", "feat/t14-unstaged-cap-and-console-discipline", "feat/t14-unstaged-cap-and-conso…", "shinsha", "U"],
      ["remote", "origin/feat/t14-unstaged-cap-and-console-discipline", "origin", "shinsha", "U"],
    ]);
    expect(folded).toEqual([]);
  });

  it("test_rowRefs_lodger_isHollowWithoutALetterInTheColourOfTheLineItSitsOn", () => {
    const { shown } = refsAt(lodgerState(), full("63421cf"));
    expect(shown).toEqual([
      { kind: "local", name: "release/0.1", label: "release/0.1", color: "trunk", letter: "", hollow: false, lodge: true },
      { kind: "remote", name: "origin/release/0.1", label: "origin", color: "trunk", letter: "", hollow: true, lodge: true },
    ]);
  });

  it("test_rowRefs_newBranchWithoutItsOwnLine_usesTheAccentAndTheHeadLetter", () => {
    // 基準 new-branch：feat/v8-graph 停在 main 的 tip，HEAD pill 帶自己的字母 V 與偏好色辰砂，排在最前面
    const graph = newBranchState();
    const routes = computeRoutes(graph);
    expect([routes.accent, routes.head.letter]).toEqual(["shinsha", "V"]);
    const { shown } = refsAt(graph, full("dd9ba36"));
    expect(shown.map((s) => [s.kind, s.label, s.color, s.letter, s.lodge])).toEqual([
      ["head", "feat/v8-graph", "shinsha", "V", false],
      ["local", "main", "trunk", "M", false],
      ["remote", "origin", "trunk", "M", false],
      ["tag", "v0.1.0-rc.1", null, "", false],
    ]);
  });

  it("test_rowRefs_publishedNewBranchWithoutItsOwnLine_itsOriginTakesTheBranchsLetterAndColour", () => {
    // 4a 盲審的重現（Phase 4 計畫 §6 Q7，子超定 A）：剛開的分支還沒 commit 就 publish，它的 origin 也停在這站。
    // 自己的 remote 跟著分支畫（空心、同字同色），不是寄宿的灰圈——第一筆 commit 之後它本來就是這個樣子
    const graph = newBranchState();
    graph.branches.find((b) => b.name === "feat/v8-graph")!.upstream = "origin/feat/v8-graph";
    graph.branches.push(remoteRef("feat/v8-graph", "dd9ba36"));
    withRefs(graph);
    const routes = computeRoutes(graph);
    expect([routes.accent, routes.head.letter]).toEqual(["shinsha", "V"]);
    expect(refsAt(graph, full("dd9ba36")).shown.slice(0, 2)).toEqual([
      { kind: "head", name: "feat/v8-graph", label: "feat/v8-graph", color: "shinsha", letter: "V", hollow: false, lodge: false },
      { kind: "remote", name: "origin/feat/v8-graph", label: "origin", color: "shinsha", letter: "V", hollow: true, lodge: false },
    ]);
  });

  it("test_rowRefs_detachedHead_putsAHeadPillFirstOnTheStationsLine", () => {
    const at7b = defaultState();
    at7b.head = { oid: full("7b03d5e"), branch: null };
    expect(refsAt(at7b, full("7b03d5e")).shown).toEqual([
      { kind: "head", name: "HEAD", label: "HEAD", color: "rokusho", letter: "T", hollow: false, lodge: false },
    ]);
    // 原本的 HEAD 分支變回一般的本機分支
    expect(refsAt(at7b, full("c9e41f2")).shown.map((s) => s.kind)).toEqual(["local"]);
    const atMain = defaultState();
    atMain.head = { oid: full("dd9ba36"), branch: null };
    expect(refsAt(atMain, full("dd9ba36")).shown.map((s) => [s.kind, s.label, s.color, s.letter])).toEqual([
      ["head", "HEAD", "trunk", "M"],
      ["local", "main", "trunk", "M"],
      ["remote", "origin", "trunk", "M"],
      ["tag", "v0.1.0-rc.1", null, ""],
    ]);
  });

  it("test_rowRefs_commitOutsideTheWindow_hasNoRow", () => {
    expect(refsAt(defaultState(), "0".repeat(40))).toEqual({ shown: [], folded: [], spoken: [] });
  });
});

describe("rowRefs order", () => {
  it("test_rowRefs_unsortedInput_isOrderedByNameWithinEachKind", () => {
    // 列舉順序故意反過來；tag 用 JS 字串比較（v10 在 v2 前）
    const { shown } = refsAt(
      graphOf({
        local: { zeta: ["t1", "origin/zeta"], alpha: ["t1", "origin/alpha"] },
        remote: { "origin/zeta": "t1", "origin/alpha": "t1", "fork/other": "t1" },
        tags: { v2: "t1", v10: "t1" },
      }),
      "t1",
    );
    expect(shown.map((s) => [s.kind, s.name])).toEqual([
      ["local", "alpha"],
      ["remote", "origin/alpha"],
      ["local", "zeta"],
      ["remote", "origin/zeta"],
      ["remote", "fork/other"],
      ["tag", "v10"],
      ["tag", "v2"],
    ]);
  });

  it("test_rowRefs_headBranch_comesFirstWhateverItsName", () => {
    const { shown } = refsAt(
      graphOf({ local: { alpha: "t1", zeta: ["t1", "origin/zeta"] }, remote: { "origin/zeta": "t1" }, head: "zeta" }),
      "t1",
    );
    expect(shown.map((s) => [s.kind, s.label])).toEqual([
      ["head", "zeta"],
      ["remote", "origin"],
      ["local", "alpha"],
    ]);
  });
});

describe("rowRefs own remotes", () => {
  it("test_rowRefs_upstreamWithAnotherName_keepsItsFullNameAmongTheOtherRemotes", () => {
    // feat 追蹤 origin/master：同一個 identity，但名稱不是 <前綴>/feat → 寫全名，不藏掉差異（main 追蹤 origin/master 同理）
    const { shown } = refsAt(
      graphOf({ local: { feat: ["t1", "origin/master"] }, remote: { "origin/master": "t1" }, head: "feat" }),
      "t1",
    );
    expect(shown.map((s) => [s.kind, s.label])).toEqual([
      ["head", "feat"],
      ["remote", "origin/master"],
    ]);
  });

  it("test_rowRefs_sameNameOfAnotherIdentity_isNotItsOwnRemote", () => {
    // origin/feat 的 identity 是追蹤它的 other（不是 feat）：名稱對得上也不算自己的
    const { shown } = refsAt(
      graphOf({
        local: { feat: "t1", other: ["m0", "origin/feat"] },
        remote: { "origin/feat": "t1" },
        head: "feat",
      }),
      "t1",
    );
    expect(shown.map((s) => s.label)).toEqual(["feat", "origin/feat"]);
  });

  it("test_rowRefs_customRefspec_labelIsTheTrackingPrefix", () => {
    // fetch refspec 把 origin 的分支放在 refs/remotes/mirror/*：標籤就是追蹤 ref 的前綴
    const r = refsAt(
      graphOf({ local: { "feat/x": ["t1", "mirror/feat/x"] }, remote: { "mirror/feat/x": ["t1", "feat/x"] }, head: "feat/x" }),
      "t1",
    );
    expect(labels(r)).toEqual(["feat/x", "mirror"]);
  });

  it("test_rowRefs_remoteNameWithASlash_keepsTheWholePrefix", () => {
    const r = refsAt(
      graphOf({
        local: { "feat/x": ["t1", "team/fork/feat/x"] },
        remote: { "team/fork/feat/x": ["t1", "feat/x"] },
        head: "feat/x",
      }),
      "t1",
    );
    expect(labels(r)).toEqual(["feat/x", "team/fork"]);
  });
});

describe("rowRefs budget", () => {
  it("test_rowRefs_names_areCutAtTheCap", () => {
    // 32 字照寫；33 字截成前 31 字 + …（長度寫死、不從 REF_CAP 推：上限被改時測試才會叫）
    const exact = `feat/${"a".repeat(27)}`;
    const over = `feat/${"b".repeat(28)}`;
    expect([exact.length, over.length]).toEqual([32, 33]);
    const { shown } = refsAt(graphOf({ local: { [exact]: "t1" } }), "t1");
    expect(shown[0].label).toBe(exact);
    const cut = refsAt(graphOf({ local: { [over]: "t1" } }), "t1").shown[0];
    expect([cut.label, cut.label.length, cut.name]).toEqual([`feat/${"b".repeat(26)}…`, 32, over]);
  });

  it("test_rowRefs_exactlyTheBudget_showsEverything", () => {
    // feat 4 + origin 6 + 30 字的 tag = 40
    const tag = `t${"x".repeat(29)}`;
    const { shown, folded } = refsAt(
      graphOf({ local: { feat: ["t1", "origin/feat"] }, remote: { "origin/feat": "t1" }, tags: { [tag]: "t1" }, head: "feat" }),
      "t1",
    );
    expect(labels({ shown, folded })).toEqual(["feat", "origin", tag]);
    expect(folded).toEqual([]);
  });

  it("test_rowRefs_overTheBudget_foldsEverythingFromTheFirstThatDoesNotFit", () => {
    // 31 字的 tag 讓合計到 41 → 收；後面的 v1 放得下也照樣收（從第一個超出的起全部）
    const tag = `r${"x".repeat(30)}`;
    const { shown, folded } = refsAt(
      graphOf({
        local: { feat: ["t1", "origin/feat"] },
        remote: { "origin/feat": "t1" },
        tags: { v1: "t1", [tag]: "t1" },
        head: "feat",
      }),
      "t1",
    );
    expect(labels({ shown, folded })).toEqual(["feat", "origin"]);
    expect(folded).toEqual([tag, "v1"]);
  });

  it("test_rowRefs_headBranchFirst_neverFoldsItsOwnOrigin", () => {
    // 分支截到 32 字 + origin 6 = 38 ≤ 40
    const long = `feat/${"q".repeat(40)}`;
    const { shown, folded } = refsAt(
      graphOf({ local: { [long]: ["t1", `origin/${long}`] }, remote: { [`origin/${long}`]: "t1" }, head: long }),
      "t1",
    );
    expect(shown.map((s) => [s.kind, s.label.length])).toEqual([
      ["head", 32],
      ["remote", 6],
    ]);
    expect(folded).toEqual([]);
  });

  it("test_rowRefs_secondBranchesOrigin_foldsWhenTheBudgetRunsOut", () => {
    // feat/ + 15 字 = 20、origin 6、fix/bbbbbb 10 → 36；fix/bbbbbb 的 origin 再 6 就 42 → 收
    const first = `feat/${"a".repeat(15)}`;
    const { shown, folded } = refsAt(
      graphOf({
        local: { [first]: ["t1", `origin/${first}`], "fix/bbbbbb": ["t1", "origin/fix/bbbbbb"] },
        remote: { [`origin/${first}`]: "t1", "origin/fix/bbbbbb": "t1" },
      }),
      "t1",
    );
    expect(labels({ shown, folded })).toEqual([first, "origin", "fix/bbbbbb"]);
    expect(folded).toEqual(["origin/fix/bbbbbb"]);
  });
});

// 一站的 ref 數由 repo 內容決定。JSC（WKWebView）的函式引數上限是 65536，vitest 的 V8 在預設 stack 下
// 約 12 萬就丟 RangeError：20 萬筆讓兩邊都超過，`push(...陣列)` 在哪一邊都撐不住
const MANY = 200_000;

describe("rowRefs scale", () => {
  const routes = computeRoutes(graphOf({ local: { feat: "t1" }, head: "feat" }));
  const at = (extra: RefPlacement[]) =>
    rowRefs({ ...routes, refs: [...routes.refs, ...extra] }, "t1", { oid: "t1", branch: "feat" });

  it("test_rowRefs_manyTagsOnOneCommit_foldsTheRest", () => {
    const { shown, folded } = at(
      Array.from({ length: MANY }, (_, i): RefPlacement => ({
        name: `v${i}`,
        kind: "tag",
        target: "t1",
        identity: null,
        line: null,
      })),
    );
    expect(shown[0].name).toBe("feat");
    expect(shown.length + folded.length).toBe(MANY + 1);
  });

  it("test_rowRefs_manyRemotesOfOneBranch_followTheBranch", () => {
    // 每個都是 feat 自己的 remote（identity feat、名稱 `<前綴>/feat`）：緊跟在 feat 後面，標籤只寫前綴
    const { shown, folded } = at(
      Array.from({ length: MANY }, (_, i): RefPlacement => ({
        name: `r${i}/feat`,
        kind: "remote",
        target: "t1",
        identity: "feat",
        line: null,
      })),
    );
    expect(shown.slice(0, 2).map((s) => s.label)).toEqual(["feat", "r0"]);
    expect(shown.length + folded.length).toBe(MANY + 1);
  });
});
