import { describe, expect, it } from "vitest";
import { computeRoutes, letterCandidates, preferredColor, type RouteMap } from "../lib/routeMap";
import type { BranchRef, CommitNode, GraphData } from "../lib/tauri";
import { graph as fixtureGraph } from "../dev/fidelity/fixture";

// ---- 合成歷史 ----

/** [id, parents, message]；由上而下 = revwalk 順序（新到舊） */
type C = [id: string, parents: string[], message?: string];

interface Spec {
  commits: C[];
  /** local 分支：target，或 [target, upstream] */
  local?: Record<string, string | [string, string]>;
  /** remote 分支：target（name_on_remote 預設去掉第一段），或 [target, name_on_remote] */
  remote?: Record<string, string | [string, string | null]>;
  tags?: Record<string, string>;
  /** 分支名、{ detached: oid }，或省略 = unborn */
  head?: string | { detached: string };
  defaultBranch?: string;
}

function graphOf(spec: Spec): GraphData {
  const commits: CommitNode[] = spec.commits.map(([id, parents, message]) => ({
    oid: id.slice(0, 7),
    full_oid: id,
    message: message ?? `commit ${id}`,
    author: { name: "t", email: "t@example.com", timestamp: 0 },
    parents,
    refs: [],
  }));
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
    commits,
    branches: [...local, ...remote],
    tags: Object.entries(spec.tags ?? {}).map(([name, target]) => ({ name, target })),
    truncated: false,
    head,
    default_branch: spec.defaultBranch ?? null,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// ---- 不變式 ----

/** 從公開資料重推每條線的佔用範圍（半列），順便驗證 stations / tracks 彼此一致 */
function spansOf(graph: GraphData, routes: RouteMap): Map<string, [number, number]> {
  const rowOf = new Map(graph.commits.map((c, i) => [c.full_oid, i]));
  const row = (oid: string) => rowOf.get(oid) ?? Number.NaN;
  const n = graph.commits.length;
  const spans = new Map<string, [number, number]>();
  for (const line of routes.lines) {
    const tracksInto = routes.tracks.filter((t) => t.line === line.id && t.kind !== "run");
    if (line.stations.length === 0) {
      const t = tracksInto.find((t) => t.kind === "beyond" && t.parentIndex > 0);
      spans.set(line.id, [2 * row(t?.child ?? "") + 1, 2 * n]);
      continue;
    }
    const top = line.stations[0];
    const bottom = line.stations[line.stations.length - 1];
    const mergeRows = routes.tracks.filter((t) => t.kind === "merge" && t.parent === top).map((t) => row(t.child));
    const down = routes.tracks.find((t) => t.child === bottom && t.parentIndex === 0);
    const start = mergeRows.length > 0 ? 2 * Math.min(...mergeRows) + 1 : 2 * row(top);
    const end = !down ? 2 * row(bottom) : down.kind === "beyond" ? 2 * n : 2 * row(down.parent) - 1;
    spans.set(line.id, [start, end]);
  }
  return spans;
}

const overlaps = (a: [number, number], b: [number, number]) => a[0] <= b[1] && b[0] <= a[1];

function checkInvariants(graph: GraphData, routes: RouteMap, opts: { colors?: boolean } = {}) {
  const byOid = new Map(graph.commits.map((c) => [c.full_oid, c]));
  const lineById = new Map(routes.lines.map((l) => [l.id, l]));

  // 1. 每個 commit 恰屬一條線；每條線的站是連續的 first-parent 鏈
  const owner = new Map<string, string>();
  for (const line of routes.lines) {
    line.stations.forEach((oid, i) => {
      expect(owner.has(oid), `${oid} owned twice`).toBe(false);
      owner.set(oid, line.id);
      if (i + 1 < line.stations.length) expect(byOid.get(oid)?.parents[0]).toBe(line.stations[i + 1]);
    });
  }
  expect(owner.size).toBe(graph.commits.length);
  expect(routes.stations.map((s) => s.line)).toEqual(graph.commits.map((c) => owner.get(c.full_oid)));
  expect(new Set(routes.lines.map((l) => l.id)).size).toBe(routes.lines.length);

  // 2. 同一欄的線範圍不重疊；主幹（至多一條）在第 0 欄
  const spans = spansOf(graph, routes);
  const bySlot = new Map<number, [number, number][]>();
  for (const line of routes.lines) {
    const span = spans.get(line.id);
    if (span) bySlot.set(line.slot, [...(bySlot.get(line.slot) ?? []), span]);
  }
  for (const list of bySlot.values()) {
    list.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < list.length; i++) expect(list[i - 1][1]).toBeLessThan(list[i][0]);
  }
  const trunks = routes.lines.filter((l) => l.kind === "trunk");
  expect(trunks.length).toBeLessThanOrEqual(1);
  for (const t of trunks) expect(t.slot).toBe(0);

  // 3. 有自己的線的 ref 與 HEAD 的 identity 都有字母（重疊的線超過 26 條時除外）；
  //    同一 identity 同字母，字母相同的 identity 範圍互不重疊
  const identityHull = new Map<string, [number, number]>();
  for (const line of routes.lines) {
    const span = spans.get(line.id);
    if (!span) continue;
    const hull = identityHull.get(line.identity);
    identityHull.set(line.identity, hull ? [Math.min(hull[0], span[0]), Math.max(hull[1], span[1])] : span);
  }
  const letterOf = new Map<string, string | null>();
  for (const line of routes.lines) {
    if (letterOf.has(line.identity)) expect(line.letter).toBe(letterOf.get(line.identity));
    letterOf.set(line.identity, line.letter);
  }
  if (routes.head.identity) expect(routes.head.letter).not.toBeNull();
  const withLetter = [...letterOf].filter(([, l]) => l !== null);
  for (let i = 0; i < withLetter.length; i++) {
    for (let j = i + 1; j < withLetter.length; j++) {
      const [a, la] = withLetter[i];
      const [b, lb] = withLetter[j];
      const ha = identityHull.get(a);
      const hb = identityHull.get(b);
      if (la === lb && ha && hb) expect(overlaps(ha, hb), `${a} and ${b} share ${la}`).toBe(false);
    }
  }
  for (const ref of routes.refs) {
    if (ref.line && (letterOf.size <= 26 || routes.lines.length <= 26)) {
      expect(lineById.get(ref.line)?.letter, `${ref.name} has no letter`).not.toBeNull();
    }
  }

  // 4. 顏色：同一 identity 同色；墨只給主幹；HEAD 的線是偏好色；強調色照 HEAD 的 identity；鄰線不同色
  const trunkIdentity = trunks[0]?.identity ?? null;
  const colorOf = new Map<string, string>();
  for (const line of routes.lines) {
    if (colorOf.has(line.identity)) expect(line.color).toBe(colorOf.get(line.identity));
    colorOf.set(line.identity, line.color);
    if (trunkIdentity) expect(line.color === "trunk", line.id).toBe(line.identity === trunkIdentity);
  }
  const headId = routes.head.identity;
  if (!headId || headId === trunkIdentity) {
    expect(routes.accent).toBe("trunk");
  } else if (graph.head.oid === null && trunks.length === 0) {
    // unborn 的 HEAD 分支可能就是還沒有線的主幹：是哪一種由主幹那組測試逐例斷言
    expect(["trunk", preferredColor(headId)]).toContain(routes.accent);
  } else if (colorOf.has(headId)) {
    expect(colorOf.get(headId)).toBe(preferredColor(headId));
    expect(routes.accent).toBe(preferredColor(headId));
  } else {
    expect(routes.accent).toBe(preferredColor(headId));
  }
  if (opts.colors !== false) {
    for (const a of routes.lines) {
      for (const b of routes.lines) {
        if (a.identity >= b.identity) continue;
        const sa = spans.get(a.id);
        const sb = spans.get(b.id);
        const adjacent = Math.abs(a.slot - b.slot) === 1 && sa && sb && overlaps(sa, sb);
        const joined = routes.tracks.some(
          (t) => t.kind !== "run" && t.kind !== "beyond" && [a.id, b.id].includes(t.line) &&
            [owner.get(t.child), owner.get(t.parent)].includes(t.line === a.id ? b.id : a.id),
        );
        if ((adjacent || joined) && a.color !== "trunk") {
          expect(a.color, `${a.id} vs ${b.id}`).not.toBe(b.color);
        }
      }
    }
  }

  // 5. 每個 (child, parent) 恰一條軌道（parent 上限 64）
  for (const c of graph.commits) {
    const own = routes.tracks.filter((t) => t.child === c.full_oid);
    expect(own.map((t) => t.parentIndex)).toEqual(c.parents.slice(0, 64).map((_, k) => k));
  }
}

/** 純函式：輸入凍結也能算、兩次結果相同，並檢查不變式 */
function routesOf(spec: Spec | GraphData, opts: { colors?: boolean } = {}) {
  const graph = deepFreeze("commits" in spec && "truncated" in spec ? spec : graphOf(spec as Spec));
  const routes = computeRoutes(graph);
  expect(computeRoutes(graph)).toEqual(routes);
  checkInvariants(graph, routes, opts);
  return { graph, routes, line: (id: string) => routes.lines.find((l) => l.id === id) };
}

const lineIdOf = (routes: RouteMap, oid: string) => routes.stations.find((s) => s.oid === oid)?.line;

// ---- v8 設計基準的 fixture ----

describe("computeRoutes on the v8 reference fixture", () => {
  // 基準手排的 lane（v8-kirazuri-lines-sys.html），依短 hash
  const REFERENCE_SLOTS: Record<string, number> = {
    c9e41f2: 1, e81d6b0: 2, "7b03d5e": 1, "4f2a9c1": 1, dd9ba36: 0, "63421cf": 0, "4c6dafd": 1,
    "9a58413": 1, "4f709e5": 1, "314e219": 0, "9a70f3f": 1, "9b08a69": 1, "9d9dfb1": 1, "932c96b": 1,
    "357dfda": 1, "7e42383": 1, de312e2: 1, e255b9c: 0, "7c90e13": 0, "1fd83dc": 1, a592721: 0,
    "561874d": 1, "86023a3": 0,
  };

  it("test_routeMap_v8Fixture_slotsMatchHandPlacedReference", () => {
    const { routes } = routesOf(fixtureGraph);
    const slotOf = new Map(routes.lines.map((l) => [l.id, l.slot]));
    const got = Object.fromEntries(
      routes.stations.map((s) => [s.oid.slice(0, 7), slotOf.get(s.line)]),
    );
    expect(got).toEqual(REFERENCE_SLOTS);
  });

  it("test_routeMap_v8Fixture_lettersAndColoursMatchThePrototype", () => {
    const { line } = routesOf(fixtureGraph);
    // 與原型在同一份 23 筆資料上算出的值相同（基準回填表）
    const expected: Record<string, [string | null, string]> = {
      main: ["M", "trunk"],
      "feat/t15g-graph-density": ["T", "rokusho"],
      "fix/toolbar-jump": ["J", "murasaki"],
      "feat/t15f-motion": ["F", "gunjo"],
      "feat/t15e-graph-layout": ["E", "odo"],
      "feat/t15d-theme-parity": [null, "gunjo"],
      "feat/t15b-graph-craft": [null, "shinsha"],
      "feat/t15c-state-design": [null, "odo"],
    };
    for (const [id, [letter, color]] of Object.entries(expected)) {
      expect([line(id)?.letter, line(id)?.color], id).toEqual([letter, color]);
    }
    expect(line("feat/t15c-state-design")).toMatchObject({ stations: [], slot: 1, kind: "inferred" });
    expect(line("feat/t15d-theme-parity")?.kind).toBe("inferred");
  });

  it("test_routeMap_v8Fixture_headIsTheT15gLineAndSetsTheAccent", () => {
    const { routes } = routesOf(fixtureGraph);
    expect(routes.head).toMatchObject({
      line: "feat/t15g-graph-density",
      identity: "feat/t15g-graph-density",
      letter: "T",
    });
    expect(routes.accent).toBe("rokusho");
    expect(routes.stations[0]).toMatchObject({ isHead: true, role: "terminus" });
    expect(routes.refs.find((r) => r.name === "origin/feat/t15g-graph-density")?.line).toBe(
      "feat/t15g-graph-density",
    );
    expect(routes.refs.find((r) => r.name === "v0.1.0-rc.1")).toMatchObject({ kind: "tag", line: null });
  });
});

// ---- 合成歷史 ----

describe("computeRoutes attribution", () => {
  it("test_routeMap_mergedPullRequest_infersTheDeletedBranch", () => {
    const { routes, line } = routesOf({
      commits: [
        ["m3", ["m2", "f2"], "Merge pull request #1 from someone/feat/login"],
        ["f2", ["f1"]],
        ["m2", ["m1"]],
        ["f1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m3" },
      head: "main",
    });
    expect(line("main")).toMatchObject({ kind: "trunk", slot: 0, stations: ["m3", "m2", "m1"] });
    expect(line("feat/login")).toMatchObject({ kind: "inferred", slot: 1, stations: ["f2", "f1"], letter: null });
    expect(routes.tracks.find((t) => t.child === "m3" && t.parent === "f2")).toMatchObject({
      kind: "merge",
      line: "feat/login",
    });
    expect(routes.tracks.find((t) => t.child === "f1")).toMatchObject({ kind: "fork", line: "feat/login" });
    expect(routes.stations.find((s) => s.oid === "m3")?.role).toBe("interchange");
    expect(routes.stations.find((s) => s.oid === "m1")?.role).toBe("interchange");
  });

  it("test_routeMap_unparsableMergeMessage_fallsBackToAnonymous", () => {
    const { line } = routesOf({
      commits: [
        ["m2", ["m1", "f1"], "feat(frontend): merge T3 graph rendering"],
        ["f1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m2" },
      head: "main",
    });
    expect(line("anon:f1")).toMatchObject({ kind: "anonymous", stations: ["f1"] });
  });

  it("test_routeMap_mergeNameWithIllegalCharacters_isIgnored", () => {
    const { line } = routesOf({
      commits: [
        ["m2", ["m1", "f1"], "Merge branch 'bad:name'"],
        ["f1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m2" },
      head: "main",
    });
    expect(line("bad:name")).toBeUndefined();
    expect(line("anon:f1")?.kind).toBe("anonymous");
  });

  it("test_routeMap_sharedTip_higherPriorityOwnsTheLine", () => {
    const commits: C[] = [
      ["x", ["m1"]],
      ["m1", []],
    ];
    const plain = routesOf({ commits, local: { main: "m1", b: "x", a: "x" }, head: "main" });
    expect(lineIdOf(plain.routes, "x")).toBe("a");
    expect(plain.routes.refs.find((r) => r.name === "b")).toMatchObject({ identity: "b", line: null });
    expect(plain.line("a")?.letter).not.toBeNull();

    const onB = routesOf({ commits, local: { main: "m1", b: "x", a: "x" }, head: "b" });
    expect(lineIdOf(onB.routes, "x")).toBe("b");
    expect(onB.routes.refs.find((r) => r.name === "a")?.line).toBeNull();
  });

  it("test_routeMap_stackedBranches_secondForksFromTheFirstsTerminus", () => {
    const { routes, line } = routesOf({
      commits: [
        ["g1", ["f1"]],
        ["f1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m1", "feature-1": "f1", "feature-2": "g1" },
      head: "main",
    });
    expect(line("feature-2")?.stations).toEqual(["g1"]);
    expect(line("feature-1")?.stations).toEqual(["f1"]);
    expect(routes.tracks.find((t) => t.child === "g1")).toMatchObject({ kind: "fork", line: "feature-2" });
  });

  it("test_routeMap_branchCreatedMidLine_takesTheLowerPart", () => {
    // 已知代價：中段新建分支會把下半段歸給它
    const { line } = routesOf({
      commits: [
        ["f3", ["f2"]],
        ["f2", ["f1"]],
        ["f1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m1", feature: "f3", backup: "f2" },
      head: "main",
    });
    expect(line("feature")?.stations).toEqual(["f3"]);
    expect(line("backup")?.stations).toEqual(["f2", "f1"]);
  });

  it("test_routeMap_localAndRemoteOfOneBranch_shareALine", () => {
    const commits: C[] = [
      ["f2", ["f1"]],
      ["f1", ["m1"]],
      ["m1", []],
    ];
    const ahead = routesOf({ commits, local: { main: "m1", feat: "f2" }, remote: { "origin/feat": "f1" }, head: "main" });
    expect(ahead.line("feat")?.stations).toEqual(["f2", "f1"]);
    expect(ahead.routes.refs.find((r) => r.name === "origin/feat")?.line).toBe("feat");

    const behind = routesOf({ commits, local: { main: "m1", feat: "f1" }, remote: { "origin/feat": "f2" }, head: "main" });
    expect(behind.line("feat")?.stations).toEqual(["f2", "f1"]);
    expect(behind.routes.lines.filter((l) => l.identity === "feat")).toHaveLength(1);
  });

  it("test_routeMap_divergedLocalAndRemote_secondSegmentSharesColourAndLetter", () => {
    const { routes, line } = routesOf({
      commits: [
        ["f2", ["f1"]],
        ["r2", ["f1"]],
        ["f1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m1", feat: ["f2", "origin/feat"] },
      remote: { "origin/feat": "r2" },
      head: "main",
    });
    expect(line("feat")?.stations).toEqual(["f2", "f1"]);
    expect(line("feat::2")).toMatchObject({ identity: "feat", kind: "branch", stations: ["r2"] });
    expect(line("feat::2")?.color).toBe(line("feat")?.color);
    expect(line("feat::2")?.letter).toBe(line("feat")?.letter);
    expect(routes.tracks.find((t) => t.child === "r2")).toMatchObject({ kind: "fork", parent: "f1" });
  });

  it("test_routeMap_divergedTrunk_secondSegmentLeavesSlotZero", () => {
    const { line } = routesOf({
      commits: [
        ["m2", ["m1"]],
        ["o2", ["m1"]],
        ["m1", []],
      ],
      local: { main: ["m2", "origin/main"] },
      remote: { "origin/main": "o2" },
      head: "main",
    });
    expect(line("main")).toMatchObject({ kind: "trunk", slot: 0 });
    expect(line("main::2")).toMatchObject({ kind: "branch", color: "trunk", stations: ["o2"] });
    expect(line("main::2")?.slot).not.toBe(0);
  });

  it("test_routeMap_secondSegmentId_neverCollidesWithATagLine", () => {
    // 分支 `tag` 分岔成兩段，旁邊有個名為 `2` 的 tag 落在匿名線上：兩條線的 id 不能都是 `tag:2`
    const { line } = routesOf({
      commits: [
        ["m2", ["m1", "t1"], "custom merge"],
        ["t1", ["m0"]],
        ["g2", ["m0"]],
        ["g1", ["m0"]],
        ["m1", ["m0"]],
        ["m0", []],
      ],
      local: { main: "m2", tag: "g1" },
      remote: { "origin/tag": "g2" },
      tags: { "2": "t1" },
      head: "main",
    });
    expect(line("tag:2")).toMatchObject({ identity: "tag:2", kind: "anonymous", stations: ["t1"] });
    expect(line("tag::2")).toMatchObject({ identity: "tag", kind: "branch", stations: ["g1"] });
  });

  it("test_routeMap_upstreamWithAnotherName_joinsTheIdentity", () => {
    const { routes, line } = routesOf({
      commits: [
        ["f1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m1", "feat-local": ["f1", "origin/feature"] },
      remote: { "origin/feature": "f1" },
      head: "main",
    });
    expect(line("feat-local")?.stations).toEqual(["f1"]);
    expect(routes.refs.find((r) => r.name === "origin/feature")).toMatchObject({ identity: "feat-local", line: "feat-local" });
  });

  it("test_routeMap_severalLocalsTrackOneRemote_alphabeticallyFirstOwnsIt", () => {
    // 列舉順序 mid → alpha → zeta：「第一個」「最後一個」「字母序最前」三種做法各得到不同的 local
    const { routes, line } = routesOf({
      commits: [
        ["s1", ["m1"]],
        ["d1", ["m1"]],
        ["z1", ["m1"]],
        ["a1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m1", mid: ["d1", "origin/shared"], alpha: ["a1", "origin/shared"], zeta: ["z1", "origin/shared"] },
      remote: { "origin/shared": "s1" },
      head: "main",
    });
    expect(routes.refs.find((r) => r.name === "origin/shared")?.identity).toBe("alpha");
    expect(line("alpha")?.stations).toEqual(["s1"]);
    expect(line("alpha::2")?.stations).toEqual(["a1"]);
  });

  it("test_routeMap_remoteWithoutKnownRemote_keepsItsFullName", () => {
    const { line } = routesOf({
      commits: [
        ["g1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m1" },
      remote: { "gone/feat": ["g1", null] },
      head: "main",
    });
    expect(line("gone/feat")?.stations).toEqual(["g1"]);
  });

  it("test_routeMap_sameBranchOnTwoRemotes_isOneIdentity", () => {
    const { routes } = routesOf({
      commits: [
        ["x1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m1" },
      remote: { "origin/x": "x1", "upstream/x": "x1" },
      head: "main",
    });
    expect(routes.refs.filter((r) => r.kind === "remote" && r.identity === "x").map((r) => r.line)).toEqual(["x", "x"]);
  });

  it("test_routeMap_remoteTrackingMergeMessage_stripsTheRemotePrefix", () => {
    const { line } = routesOf({
      commits: [
        ["m2", ["m1", "f1"], "Merge remote-tracking branch 'origin/feature'"],
        ["f1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m2" },
      remote: { "origin/main": "m2" },
      head: "main",
    });
    expect(line("feature")?.stations).toEqual(["f1"]);
  });

  it("test_routeMap_remoteTrackingMergeMessage_longestRemotePrefixFirst", () => {
    // remote `fork` 與 remote `fork/team` 都在：`fork/team/z` 先比長的前綴，得到 z 而不是 team/z
    const { line } = routesOf({
      commits: [
        ["m2", ["m1", "z1"], "Merge remote-tracking branch 'fork/team/z'"],
        ["z1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m2" },
      remote: { "fork/feat": "m1", "fork/team/feat": ["m1", "feat"] },
      head: "main",
    });
    expect(line("z")?.stations).toEqual(["z1"]);
  });

  it("test_routeMap_severalTagsOnAnAnonymousCommit_smallestNameWins", () => {
    const { line } = routesOf({
      commits: [
        ["m2", ["m1", "t1"], "custom merge"],
        ["t1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m2" },
      tags: { v2: "t1", v10: "t1", release: "t1" },
      head: "main",
    });
    expect(line("tag:release")?.stations).toEqual(["t1"]);
  });

  it("test_routeMap_octopusMerge_namesEveryParent", () => {
    const { line } = routesOf({
      commits: [
        ["m2", ["m1", "a1", "b1", "c1"], "Merge branches 'a', 'b' and 'c'"],
        ["a1", ["m1"]],
        ["b1", ["m1"]],
        ["c1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m2" },
      head: "main",
    });
    expect(["a", "b", "c"].map((id) => line(id)?.stations)).toEqual([["a1"], ["b1"], ["c1"]]);
  });

  it("test_routeMap_crissCrossMerges_followFirstParents", () => {
    const { routes, line } = routesOf({
      commits: [
        ["m3", ["m2", "f2"], "Merge branch 'feat'"],
        ["f2", ["f1", "m2"], "Merge branch 'main' into feat"],
        ["m2", ["m1"]],
        ["f1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m3", feat: "f2" },
      head: "main",
    });
    expect(line("main")?.stations).toEqual(["m3", "m2", "m1"]);
    expect(line("feat")?.stations).toEqual(["f2", "f1"]);
    expect(routes.tracks.find((t) => t.child === "f2" && t.parent === "m2")).toMatchObject({ kind: "merge", line: "main" });
  });

  it("test_routeMap_squashMergedBranch_staysAnUnmergedTerminus", () => {
    const { routes, line } = routesOf({
      commits: [
        ["m2", ["m1"], "feat: login (#12)"],
        ["f2", ["f1"]],
        ["f1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m2", feature: "f2" },
      head: "main",
    });
    expect(line("feature")?.stations).toEqual(["f2", "f1"]);
    expect(routes.stations.find((s) => s.oid === "f2")?.role).toBe("terminus");
  });
});

describe("computeRoutes window edges", () => {
  it("test_routeMap_forkPointBeyondWindow_lineRunsToTheBottom", () => {
    const { routes, line } = routesOf({
      commits: [
        ["f2", ["f1"]],
        ["f1", ["old"]],
      ],
      local: { main: "far", feat: "f2" },
      head: "feat",
    });
    // main 在視窗外：主幹沒有線，第 0 欄不保留
    expect(routes.lines.some((l) => l.kind === "trunk")).toBe(false);
    expect(line("feat")?.slot).toBe(0);
    expect(routes.tracks.find((t) => t.child === "f1")).toMatchObject({ kind: "beyond", line: "feat" });
  });

  it("test_routeMap_mergedParentBeyondWindow_becomesATrackOnlyLine", () => {
    const { routes, line } = routesOf({
      commits: [
        ["m3", ["m2", "x9"], "Merge pull request #5 from someone/feat/old"],
        ["m2", ["m1", "y9"], "Merge 0123456789abcdef0123456789abcdef01234567 into main"],
        ["m1", []],
      ],
      local: { main: "m3" },
      head: "main",
    });
    expect(line("feat/old")).toMatchObject({ kind: "inferred", stations: [] });
    expect(line("anon:y9")).toMatchObject({ kind: "anonymous", stations: [] });
    expect(routes.tracks.find((t) => t.parent === "x9")).toMatchObject({ kind: "beyond", line: "feat/old" });
  });
});

describe("computeRoutes HEAD and accent", () => {
  it("test_routeMap_detachedHeadOnAnonymousLine_isHeadDetached", () => {
    const { routes } = routesOf({
      commits: [
        ["d2", ["d1"]],
        ["d1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m1" },
      head: { detached: "d2" },
    });
    expect(routes.head).toMatchObject({ line: "head:detached", identity: "head:detached" });
    expect(routes.head.letter).not.toBeNull();
    expect(routes.accent).toBe(preferredColor("head:detached"));
  });

  it("test_routeMap_detachedHeadOnTrunk_usesTheTrunkAccent", () => {
    const { routes } = routesOf({
      commits: [
        ["m2", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m2" },
      head: { detached: "m1" },
    });
    expect(routes.head).toMatchObject({ line: "main", identity: "main" });
    expect(routes.accent).toBe("trunk");
  });

  it("test_routeMap_newBranchWithoutCommits_keepsItsOwnAccent", () => {
    const { routes } = routesOf({
      commits: [
        ["m2", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m2", "feat/new": "m2" },
      head: "feat/new",
    });
    expect(routes.head).toMatchObject({ line: "main", identity: "feat/new" });
    expect(routes.head.letter).toBe("N");
    expect(routes.accent).toBe(preferredColor("feat/new"));
    expect(routes.refs.find((r) => r.name === "feat/new")?.line).toBeNull();
  });

  it("test_routeMap_headOutsideWindow_keepsIdentityLetterAndAccent", () => {
    const { routes } = routesOf({
      commits: [
        ["m2", ["m1"]],
        ["m1", ["m0"]],
      ],
      local: { main: "m2", old: "o9" },
      head: "old",
    });
    expect(routes.head).toMatchObject({ oid: "o9", line: null, identity: "old" });
    expect(routes.head.letter).not.toBeNull();
    expect(routes.accent).toBe(preferredColor("old"));
  });

  it("test_routeMap_headLineKeepsItsPreferredColourAgainstAnOlderNeighbour", () => {
    // 兩條偏好色相同、相鄰的線：較舊（延伸得較下面）的本來先處理、先拿色。
    // HEAD 優先處理，所以讓位的是舊的那條——強調色不會因為鄰居而跳。
    // 看的是 HEAD 的 identity：detached 停在有名字的線上也一樣
    const names = Array.from({ length: 6 }, (_, i) => `topic-${i}`);
    const pair = names.flatMap((a, i) => names.slice(i + 1).map((b) => [a, b])).find(
      ([a, b]) => preferredColor(a) === preferredColor(b),
    );
    expect(pair).toBeDefined();
    const [older, head] = pair ?? ["", ""];
    for (const headSpec of [head, { detached: "y1" }]) {
      const { routes, line } = routesOf({
        commits: [
          ["y1", ["m3"]],
          ["x2", ["x1"]],
          ["m3", ["m2"]],
          ["x1", ["m1"]],
          ["m2", ["m1"]],
          ["m1", []],
        ],
        local: { main: "m3", [older]: "x2", [head]: "y1" },
        head: headSpec,
      });
      expect(routes.head.identity).toBe(head);
      expect(Math.abs((line(older)?.slot ?? 0) - (line(head)?.slot ?? 0))).toBe(1);
      expect(line(head)?.color).toBe(preferredColor(head));
      expect(line(older)?.color).not.toBe(preferredColor(older));
    }
  });

  it("test_routeMap_unreadableHead_isEmpty", () => {
    // HeadInfo 兩者皆 null = 讀不到 HEAD（unborn 會帶分支名，見主幹那組）
    const { routes } = routesOf({ commits: [] });
    expect(routes).toMatchObject({ lines: [], stations: [], tracks: [], slotCount: 0, accent: "trunk" });
    expect(routes.head).toEqual({ oid: null, line: null, identity: null, letter: null });
  });
});

describe("computeRoutes trunk", () => {
  it("test_routeMap_defaultBranchWinsOverMain", () => {
    const { line } = routesOf({
      commits: [
        ["d1", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m1", develop: "d1" },
      defaultBranch: "develop",
      head: "main",
    });
    expect(line("develop")).toMatchObject({ kind: "trunk", slot: 0, stations: ["d1", "m1"] });
  });

  it("test_routeMap_noTrunk_leavesSlotZeroToTheFirstLine", () => {
    const { routes } = routesOf({
      commits: [
        ["a1", ["r1"]],
        ["b1", ["r1"]],
        ["r1", []],
      ],
      local: { a: "a1", b: "b1" },
      head: { detached: "r1" },
    });
    expect(routes.lines.some((l) => l.kind === "trunk")).toBe(false);
    expect(Math.min(...routes.lines.map((l) => l.slot))).toBe(0);
  });

  it("test_routeMap_trunkIgnoresBranchTipsSittingOnIt", () => {
    const { routes, line } = routesOf({
      commits: [
        ["m3", ["m2"]],
        ["m2", ["m1"]],
        ["m1", []],
      ],
      local: { main: "m3", "release-1": "m2" },
      head: "main",
    });
    expect(line("main")?.stations).toEqual(["m3", "m2", "m1"]);
    expect(routes.refs.find((r) => r.name === "release-1")?.line).toBeNull();
  });

  // unborn：HEAD 指向還沒有 commit 的分支（graphOf 的 head 名字沒有對應的 local → oid null）
  it("test_routeMap_unbornBranchOfAnEmptyRepo_isTheTrunk", () => {
    const { routes } = routesOf({ commits: [], head: "main" });
    expect(routes.accent).toBe("trunk");
    expect(routes.head).toEqual({ oid: null, line: null, identity: "main", letter: "M" });
    expect(routes).toMatchObject({ lines: [], stations: [], slotCount: 0 });
  });

  it("test_routeMap_unbornBranchOfAnEmptyRepo_isTheTrunkWhateverItsName", () => {
    // 不在 main / master 候選裡的名字也一樣：第一筆 commit 之後它是唯一的分支，照樣是主幹
    const { routes } = routesOf({ commits: [], head: "trunk-zero" });
    expect(routes.accent).toBe("trunk");
    expect(routes.head.identity).toBe("trunk-zero");
  });

  it("test_routeMap_orphanBeforeAndAfterItsFirstCommit_keepsTheSameTrunk", () => {
    // 只有 master、沒有 remote 的 repo 裡 git switch --orphan main：候選順序 main 在 master 前，
    // 第一筆 commit 之後 main 是主幹 → 之前也要是，強調色才不會在 commit 前後換掉
    const before = routesOf({ commits: [["m1", []]], local: { master: "m1" }, head: "main" });
    expect(before.routes.accent).toBe("trunk");
    expect(before.routes.head.identity).toBe("main");
    expect(before.line("master")?.kind).toBe("branch");
    const after = routesOf({
      commits: [
        ["o1", []],
        ["m1", []],
      ],
      local: { main: "o1", master: "m1" },
      head: "main",
    });
    expect(after.routes.accent).toBe("trunk");
    expect(after.line("main")?.kind).toBe("trunk");
    expect(after.line("master")?.color).toBe(before.line("master")?.color);
  });

  it("test_routeMap_orphanBesideTheRemoteDefault_usesItsPreferredColour", () => {
    // origin/HEAD 指向 master：主幹是 master，orphan 照決策 D 用自己的偏好色
    const { routes, line } = routesOf({
      commits: [["m1", []]],
      local: { master: ["m1", "origin/master"] },
      remote: { "origin/master": "m1" },
      defaultBranch: "master",
      head: "main",
    });
    expect(line("master")?.kind).toBe("trunk");
    expect(routes.head.identity).toBe("main");
    expect(routes.accent).toBe(preferredColor("main"));
  });

  it("test_routeMap_orphanBesideMain_usesItsPreferredColour", () => {
    const { routes, line } = routesOf({ commits: [["m1", []]], local: { main: "m1" }, head: "feat/orphan" });
    expect(line("main")?.kind).toBe("trunk");
    expect(routes.accent).toBe(preferredColor("feat/orphan"));
    expect(routes.head.letter).not.toBeNull();
  });
});

describe("computeRoutes refs", () => {
  it("test_routeMap_everyRef_carriesItsTarget", () => {
    const { graph, routes } = routesOf({
      commits: [
        ["f1", ["m1"]],
        ["m1", []],
      ],
      local: { main: ["m1", "origin/main"], feat: "f1" },
      remote: { "origin/main": "m1", "origin/feat": "f1" },
      tags: { "v1.0": "m1", "v1.1": "f1" },
      head: "feat",
    });
    const want = [
      ...graph.branches.map((b) => [b.name, b.target]),
      ...graph.tags.map((t) => [t.name, t.target]),
    ];
    expect(routes.refs.map((r) => [r.name, r.target])).toEqual(want);
    // 兩個 tag 指向不同的站：target 沒有接錯位
    expect(routes.refs.filter((r) => r.kind === "tag").map((r) => r.target)).toEqual(["m1", "f1"]);
  });
});

describe("computeRoutes letters", () => {
  it("test_routeMap_letterCandidates_wordInitialsThenLettersThenAlphabet", () => {
    expect(letterCandidates("feat/t15f-motion").slice(0, 6)).toEqual(["T", "F", "M", "O", "I", "N"]);
    expect(letterCandidates("fix/toolbar-jump").slice(0, 2)).toEqual(["T", "J"]);
    expect(letterCandidates("功能/登入")[0]).toBe("A");
    // 先確認是 ASCII 字母才轉大寫：ß 不會變 SS，土耳其文 ı 不會變 I
    expect(letterCandidates("ßı")).toEqual([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"]);
    expect(letterCandidates("x").every((ch) => /^[A-Z]$/.test(ch))).toBe(true);
  });

  it("test_routeMap_moreThan26SequentialBranches_reuseLettersWithoutOverlap", () => {
    // 30 條先後合併、彼此不重疊、都還有 remote ref 的分支：前 26 個全域唯一，之後只和重疊的線不同
    const commits: C[] = [];
    const remote: Record<string, string> = {};
    for (let i = 29; i >= 0; i--) {
      commits.push([`m${i + 1}`, [`m${i}`, `f${i}`], `Merge pull request #${i} from someone/topic-${i}`]);
      commits.push([`f${i}`, [`m${i}`]]);
      remote[`origin/topic-${i}`] = `f${i}`;
    }
    commits.push(["m0", []]);
    const { routes } = routesOf({ commits, local: { main: "m30" }, remote, head: "main" });
    const topics = routes.lines.filter((l) => l.identity.startsWith("topic-"));
    expect(topics).toHaveLength(30);
    expect(topics.every((l) => l.letter !== null)).toBe(true);
  });

  it("test_routeMap_moreThan26OverlappingBranches_overflowHasNoLetter", () => {
    // 30 條同時存在的分支彼此重疊：一次最多分得出 26 個不同字母，再多的沒有字母。
    // main 只佔最後一列、和它們都不重疊，所以第一條溢出的線可以和 main 共用 M
    const names = Array.from({ length: 30 }, (_, i) => `b${String(i).padStart(2, "0")}`);
    const commits: C[] = [...names.map((n): C => [`${n}x`, ["m1"]]), ["m1", []]];
    const local = Object.fromEntries([["main", "m1"], ...names.map((n) => [n, `${n}x`])]);
    const { routes, line } = routesOf({ commits, local, head: "main" });
    const branchLines = routes.lines.filter((l) => l.identity !== "main");
    const lettered = branchLines.filter((l) => l.letter !== null);
    expect(new Set(lettered.map((l) => l.letter)).size).toBe(26);
    expect(line("b25")?.letter).toBe("M");
    expect(branchLines.filter((l) => l.letter === null).map((l) => l.identity)).toEqual(["b26", "b27", "b28", "b29"]);
  });
});

describe("computeRoutes octopus bounds", () => {
  it("test_routeMap_hugeOctopus_isCappedAndFast", () => {
    const parents = ["m1", ...Array.from({ length: 4999 }, (_, i) => `p${i}`)];
    const started = performance.now();
    const { routes } = routesOf({
      commits: [
        ["oct", parents, "Merge branches 'a' and 'b'"],
        ["m1", []],
      ],
      local: { main: "oct" },
      head: "main",
    });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(routes.tracks.filter((t) => t.child === "oct")).toHaveLength(64);
    expect(routes.lines.filter((l) => l.stations.length === 0)).toHaveLength(63);
  });

  // 視窗外的 merge parent 各自一條線、各佔一欄到底，條數由 repo 決定：刻意造出的 repo 每個 commit
  // 都 merge 同一批視窗外的 commit（1000 筆 × 63 = 6.3 萬條），欄位分配變平方級、卡住主執行緒。
  // 超過上限的共用一條溢出線——每條邊照樣有軌道（不變式 5），欄數有上界
  const staleMerges = (n: number): C[] =>
    Array.from({ length: n }, (_, i): C => [`c${i}`, [i + 1 < n ? `c${i + 1}` : "root", ...Array.from({ length: 63 }, (_, j) => `x${j}`)], "Merge"]);

  it("test_routeMap_manyOutOfWindowMerges_shareAnOverflowLine", () => {
    const { routes } = routesOf({ commits: staleMerges(40), local: { main: "c0" }, head: "main" }, { colors: false });
    expect(routes.lines.filter((l) => l.stations.length === 0)).toHaveLength(257);
    expect(routes.slotCount).toBe(258);
  });

  it("test_routeMap_manyOutOfWindowMerges_stayFast", () => {
    const graph = graphOf({ commits: staleMerges(1000), local: { main: "c0" }, head: "main" });
    const started = performance.now();
    const routes = computeRoutes(graph);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(routes.slotCount).toBe(258);
  });
});
