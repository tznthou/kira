#!/usr/bin/env node
// 0b P4 新狀態的示範資料：對 fidelity fixture 的 GraphData 打補丁，跑 computeRoutes，印出基準要用的
// lane / 線 / 顏色 / 字母 / ref 歸屬 / 強調色。基準的手寫資料必須與這裡一致（不手排）。
// 用法：node --experimental-strip-types --no-warnings mockup/tools/routes/state_routes.mjs [state…]
// STATES 另給 route_cases.mjs 的 state:<名> 用（基準實際畫出的線與第二份走線實作互比）
import { pathToFileURL } from "node:url";
import { computeRoutes } from "../../../src/lib/routeMap.ts";
import { graph as base } from "../../../src/dev/fidelity/fixture.ts";

const TAIL = base.commits[0].full_oid.slice(7);
const full = (id) => id + TAIL;
const clone = (g) => JSON.parse(JSON.stringify(g));
// 基準的預設視窗是截斷的（0b P4）；app 的 fixture 到 Phase 4 才改（fixture.ts:108），這裡先照基準
const fixture = () => ({ ...clone(base), truncated: true });
const local = (name, target, upstream = `origin/${name}`) => ({ name, target: full(target), is_remote: false, upstream, name_on_remote: null });
const remote = (name, target) => ({ name: `origin/${name}`, target: full(target), is_remote: true, upstream: null, name_on_remote: name });
const byRef = (a, b) => {
  // libgit2 列舉：refs/heads/* 在前、refs/remotes/* 在後，各自依名稱
  if (a.is_remote !== b.is_remote) return a.is_remote ? 1 : -1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};
const withRefs = (g) => {
  // 後端 build_ref_map：先分支（含遠端）後 tag
  for (const c of g.commits) {
    c.refs = [
      ...g.branches.filter((b) => b.target === c.full_oid).map((b) => b.name),
      ...g.tags.filter((t) => t.target === c.full_oid).map((t) => t.name),
    ];
  }
  g.branches.sort(byRef);
  return g;
};

export const STATES = {
  default: fixture,
  "new-branch": () => {
    const g = fixture();
    g.branches.push(local("feat/v8-graph", "dd9ba36", null));
    g.head = { oid: full("dd9ba36"), branch: "feat/v8-graph" };
    return withRefs(g);
  },
  "head-beyond": () => {
    const g = fixture();
    g.branches.push(local("feat/old", "0dd5eed"), remote("feat/old", "0dd5eed"));
    g.head = { oid: full("0dd5eed"), branch: "feat/old" };
    g.truncated = true;
    return withRefs(g);
  },
  lodger: () => {
    const g = fixture();
    g.branches.push(local("release/0.1", "63421cf"), remote("release/0.1", "63421cf"));
    return withRefs(g);
  },
  // 0b P5：lodger 下點 release/0.1（checkout 一個沒有自己線的分支）→ 決策 D：仍有自己的字母與偏好色，強調色跟著
  "lodger-checkout": () => {
    const g = STATES.lodger();
    g.head = { oid: full("63421cf"), branch: "release/0.1" };
    return withRefs(g);
  },
  // 0b P5：視窗外的分支（tip 比載入的 23 筆都舊）：側欄有、圖上沒有 → line = null 且 target 不在 commits（寄宿是 target 在）
  beyond: () => {
    const g = fixture();
    g.branches.push(local("feat/t9d-watcher", "5a1c3e8"), remote("feat/t9d-watcher", "5a1c3e8"));
    return withRefs(g);
  },
  // 0b P5：點視窗外的分支 → HEAD 在視窗外（同 head-beyond），字母與顏色照決策 D
  "beyond-checkout": () => {
    const g = STATES.beyond();
    g.head = { oid: full("5a1c3e8"), branch: "feat/t9d-watcher" };
    return withRefs(g);
  },
  "long-refs": () => {
    const g = fixture();
    const long = "feat/t14-unstaged-cap-and-console-discipline";
    g.branches = g.branches.filter((b) => !b.name.endsWith("fix/toolbar-jump"));
    g.branches.push(local(long, "e81d6b0"), remote(long, "e81d6b0"));
    g.tags.push({ name: "v0.1.0", target: full("dd9ba36") });
    // a release branch cut at the tagged commit: with main, both remotes and two tags the row passes the budget
    g.branches.push(local("release/0.1", "dd9ba36"), remote("release/0.1", "dd9ba36"));
    return withRefs(g);
  },
  young: () => {
    const mk = (id, message, parents, ts) => ({
      oid: id, full_oid: full(id), message, parents: parents.map(full), refs: [],
      author: { ...base.commits[0].author, timestamp: ts },
    });
    const g = {
      commits: [
        mk("b41c7e2", "feat: open a repository and list its commits", ["5e0d9a3"], 1791100000),
        mk("5e0d9a3", "docs: add a README", ["a17f3c0"], 1791090000),
        mk("a17f3c0", "Initial commit", [], 1791080000),
      ],
      branches: [local("main", "b41c7e2", null)],
      tags: [], truncated: false,
      head: { oid: full("b41c7e2"), branch: "main" },
      default_branch: null,
    };
    return withRefs(g);
  },
  empty: () => ({ commits: [], branches: [], tags: [], truncated: false, head: { oid: null, branch: "main" }, default_branch: null }),
  // 走線組合 A 的示範（v8-0b-graph-states.md §2.3.2）：跨 3 欄 Z、受限 Z、反向 merge 走空隙、交叉（橋）、
  // 列界匯流（a6f38d1：2 欄的 gutter 併進 legend 的列界改走 Z；d83b2f6：1 欄的 search 走迷你 Z 併進 compass 的列界）
  routes: () => {
    const mk = (id, message, parents, ts) => ({
      oid: id, full_oid: full(id), message, parents: parents.map(full), refs: [],
      author: { ...base.commits[0].author, timestamp: ts },
    });
    const ROWS = [
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
    const g = {
      commits: ROWS.map(([id, message, parents], i) => mk(id, message, parents, 1791200000 - i * 5400)),
      branches: [
        local("feat/search", "3fa2c71"), remote("feat/search", "3fa2c71"),
        local("feat/notes", "b6d0e94", null), local("feat/legend", "58c1a3f", null),
        local("main", "e07b52d"), remote("main", "e07b52d"),
        local("fix/gutter", "4b9c0e2", null), local("fix/compass", "7c4e1a9", null),
      ],
      tags: [], truncated: true,
      head: { oid: full("3fa2c71"), branch: "feat/search" },
      default_branch: "main",
    };
    return withRefs(g);
  },
};

function show(name) {
  const g = STATES[name]();
  let map;
  try { map = computeRoutes(g); } catch (e) { console.log(`\n== ${name}: computeRoutes threw ${e.message}`); return; }
  const lineById = new Map(map.lines.map((l) => [l.id, l]));
  console.log(`\n== ${name}: slots=${map.slotCount} accent=${map.accent} head=${JSON.stringify({ ...map.head, oid: map.head.oid?.slice(0, 7) ?? null })}`);
  for (const s of map.stations) {
    const l = lineById.get(s.line);
    console.log(`  ${s.oid.slice(0, 7)} slot ${l.slot} line ${l.id.padEnd(34)} ${l.color.padEnd(8)} ${l.letter ?? "-"} ${s.role}${s.isHead ? " HEAD" : ""}`);
  }
  const beyond = map.lines.filter((l) => l.stations.length === 0);
  for (const l of beyond) console.log(`  (track) slot ${l.slot} line ${l.id} ${l.color} ${l.letter ?? "-"}`);
  const inWindow = new Set(g.commits.map((c) => c.full_oid));
  for (const r of map.refs) {
    const l = r.line ? lineById.get(r.line) : null;
    // 沒有自己線的分支（決策 C）：寄宿（tip 在視窗內）或視窗外
    const own = !l && r.identity ? ` ${inWindow.has(r.target) ? "lodger" : "beyond"}` : "";
    console.log(`  ref ${r.kind.padEnd(6)} ${r.name.padEnd(48)} identity=${r.identity ?? "-"} line=${r.line ?? "null"}${l ? ` (${l.color} ${l.letter ?? "-"})` : ""}${own}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const want = process.argv.slice(2);
  for (const name of want.length ? want : Object.keys(STATES)) show(name);
}
