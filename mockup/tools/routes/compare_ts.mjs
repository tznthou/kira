#!/usr/bin/env node
// Phase 2 完成條件 2：TS（src/lib/routeMap.ts）與原型（proto.py）各自實作同一份規則，
// 逐 commit、逐線比對 line / identity / slot / 字母 / 顏色。兩組輸入：
//   1. 真 repo 的 dump（先跑 dump.sh）——完成條件本身
//   2. 合成情境——真 repo 觸發不到的規則（detached HEAD、upstream 歸屬、多 tag、remote 前綴、非 ASCII、parent 上限…）
//      不補這組，`mutate_routes.sh compare` 有一半的規則變異在四個 repo 上都存活
//
// 用法：node --experimental-strip-types mockup/tools/routes/compare_ts.mjs [--show] [repo…]
//   預設 kira / work / react / v8fixture ＋ 全部合成情境；給了 repo 名就只跑那些 repo。原型每次現跑，不讀舊輸出。
//   --show：印出合成情境的線（TS 的結果），對照草稿規則看「兩邊一致」的內容本身對不對
// opt-in，不進 CI：kira 的歷史含私有 skill 名不能進 repo，react 的 dump 有 5MB。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeRoutes, preferredColor } from "../../../src/lib/routeMap.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const dumps = `${here}../../fidelity-out/route-dumps/`;
const show = process.argv.includes("--show");
const args = process.argv.slice(2).filter((a) => a !== "--show");
const repos = args.length > 0 ? args : ["kira", "work", "react", "v8fixture"];

const FIELDS = {
  commits: ["oid", "line", "identity", "slot", "letter", "color"],
  lines: ["id", "identity", "kind", "slot", "color", "letter", "stations"],
  head: ["oid", "line", "identity", "letter"],
  top: ["accent", "slotCount"],
};

const runProto = (argv, input) =>
  JSON.parse(execFileSync("python3", [`${here}proto.py`, ...argv], { encoding: "utf8", maxBuffer: 1 << 28, input }));

function fromTs(graph) {
  const map = computeRoutes(graph);
  const lineById = new Map(map.lines.map((l) => [l.id, l]));
  return {
    commits: map.stations.map((s) => {
      const line = lineById.get(s.line);
      return { oid: s.oid, line: s.line, identity: line?.identity, slot: line?.slot, letter: line?.letter, color: line?.color };
    }),
    lines: map.lines.map((l) => ({
      id: l.id, identity: l.identity, kind: l.kind, slot: l.slot, color: l.color, letter: l.letter, stations: l.stations.length,
    })),
    head: map.head,
    accent: map.accent,
    slotCount: map.slotCount,
  };
}

// 欄位缺漏（undefined）一律算不一致，免得兩邊都缺時被當成相同
const differs = (a, b) => a === undefined || b === undefined || a !== b;

function diff(proto, ts) {
  const out = [];
  for (const part of ["commits", "lines"]) {
    if (proto[part].length !== ts[part].length) out.push(`${part}: ${proto[part].length} vs ${ts[part].length} entries`);
    const n = Math.min(proto[part].length, ts[part].length);
    for (const field of FIELDS[part]) {
      for (let i = 0; i < n; i++) {
        const a = proto[part][i][field];
        const b = ts[part][i][field];
        if (differs(a, b)) out.push(`${part}[${i}].${field}: proto ${JSON.stringify(a)} vs ts ${JSON.stringify(b)}`);
      }
    }
  }
  for (const field of FIELDS.head) {
    if (differs(proto.head[field], ts.head[field])) out.push(`head.${field}: proto ${proto.head[field]} vs ts ${ts.head[field]}`);
  }
  for (const key of FIELDS.top) {
    if (differs(proto[key], ts[key])) out.push(`${key}: proto ${proto[key]} vs ts ${ts[key]}`);
  }
  // 兩邊一致但都錯的情況比對抓不到；線的 id 唯一是契約，各自檢查
  for (const [who, out_] of [["proto", proto], ["ts", ts]]) {
    const ids = out_.lines.map((l) => l.id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length > 0) out.push(`${who}: duplicate line ids ${JSON.stringify([...new Set(dup)])}`);
  }
  return out;
}

// 比對器本身要能失敗：每個欄位各改壞一處，都必須被抓到
function blindSpots(proto, ts) {
  const blind = [];
  const mutate = (label, edit) => {
    const copy = structuredClone(proto);
    edit(copy);
    if (diff(copy, ts).length === 0) blind.push(label);
  };
  for (const part of ["commits", "lines"]) {
    if (proto[part].length === 0) continue;
    for (const field of FIELDS[part]) mutate(`${part}.${field}`, (c) => { c[part][0][field] = "__mutated__"; });
    mutate(`${part}.length`, (c) => { c[part].pop(); });
  }
  for (const field of FIELDS.head) mutate(`head.${field}`, (c) => { c.head[field] = "__mutated__"; });
  for (const key of FIELDS.top) mutate(key, (c) => { c[key] = "__mutated__"; });
  return blind;
}

let failed = 0;
function report(label, graph, proto) {
  const ts = fromTs(graph);
  const blind = blindSpots(proto, ts);
  const problems = diff(proto, ts);
  const ok = problems.length === 0 && blind.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${graph.commits.length} commits · ${ts.lines.length} lines · ` +
    `${problems.length} mismatches${blind.length ? ` · comparator blind to ${blind.join(", ")}` : ""}`);
  for (const p of problems.slice(0, 12)) console.log(`     ${p}`);
  if (problems.length > 12) console.log(`     … ${problems.length - 12} more`);
}

// ---- 合成情境 ----

const full = (label) => createHash("sha1").update(label).digest("hex");

/** rows 由上而下：[label, parents, message?]；branches：[name, target, { remote, upstream, onRemote }]；
 *  target / head.oid 不在 rows 裡 = 視窗外。remote 的 name_on_remote 預設為第一個 `/` 之後 */
function graphOf({ rows, branches = [], tags = [], head = {}, defaultBranch = "main" }) {
  return {
    commits: rows.map(([label, parents, message]) => ({
      oid: full(label).slice(0, 7),
      full_oid: full(label),
      message: message ?? label,
      author: { name: "t", email: "t@example.com", timestamp: 0 },
      parents: parents.map(full),
      refs: [],
    })),
    branches: branches.map(([name, target, o = {}]) => ({
      name,
      target: full(target),
      is_remote: o.remote === true,
      upstream: o.upstream ?? null,
      name_on_remote: o.remote ? (o.onRemote !== undefined ? o.onRemote : name.slice(name.indexOf("/") + 1)) : null,
    })),
    tags: tags.map(([name, target]) => ({ name, target: full(target) })),
    truncated: false,
    head: { oid: head.oid === undefined ? null : full(head.oid), branch: head.branch ?? null },
    default_branch: defaultBranch,
  };
}

// 兩個偏好色相同的分支名：讓位順序決定誰拿到偏好色
const [older, younger] = (() => {
  const names = Array.from({ length: 40 }, (_, i) => `feat/s${i}`);
  for (const a of names) for (const b of names) if (a < b && preferredColor(a) === preferredColor(b)) return [a, b];
  throw new Error("no two names share a preferred colour");
})();
const octopusRoots = Array.from({ length: 70 }, (_, i) => `o${i}`);
const many = Array.from({ length: 30 }, (_, i) => `feat/b${String(i).padStart(2, "0")}`);

const SCENARIOS = {
  "detached HEAD on an anonymous line → head:detached": {
    rows: [["m2", ["m1", "x1"], "custom merge"], ["x1", ["m0"]], ["m1", ["m0"]], ["m0", []]],
    branches: [["main", "m2"]],
    head: { oid: "x1" },
  },
  "detached HEAD on a named line gets HEAD-first colour": {
    rows: [["b1", ["m1"]], ["a3", ["a2"]], ["a2", ["a1"]], ["a1", ["m0"]], ["m1", ["m0"]], ["m0", []]],
    branches: [["main", "m1"], [older, "a3"], [younger, "b1"]],
    head: { oid: "b1" },
  },
  "attached HEAD keeps its preferred colour against an older neighbour": {
    rows: [["b1", ["m1"]], ["a3", ["a2"]], ["a2", ["a1"]], ["a1", ["m0"]], ["m1", ["m0"]], ["m0", []]],
    branches: [["main", "m1"], [older, "a3"], [younger, "b1"]],
    head: { oid: "b1", branch: younger },
  },
  "several locals track one remote → alphabetically first owns it": {
    // 列舉順序 mid → alpha → zeta：「第一個」「最後一個」「字母序最前」各得到不同的 local
    rows: [["s1", ["m0"]], ["d1", ["m0"]], ["z1", ["m0"]], ["a1", ["m0"]], ["m0", []]],
    branches: [["main", "m0"], ["mid", "d1", { upstream: "origin/shared" }], ["alpha", "a1", { upstream: "origin/shared" }],
      ["zeta", "z1", { upstream: "origin/shared" }], ["origin/shared", "s1", { remote: true }]],
  },
  "local with a differently named upstream": {
    rows: [["r1", ["l1"]], ["l1", ["m0"]], ["m0", []]],
    branches: [["main", "m0"], ["mine", "l1", { upstream: "origin/theirs" }], ["origin/theirs", "r1", { remote: true }]],
  },
  "several tags on an anonymous commit → smallest name": {
    rows: [["m2", ["m1", "t1"], "custom merge"], ["t1", ["m0"]], ["m1", ["m0"]], ["m0", []]],
    branches: [["main", "m2"]],
    tags: [["v2", "t1"], ["v10", "t1"], ["release", "t1"]],
  },
  "merge messages: derived remote prefixes (longest first), illegal names, hex": {
    rows: [
      ["m5", ["m4", "p5"], "Merge remote-tracking branch 'fork/team/z'"], ["p5", ["m0"]],
      ["m4", ["m3", "p4"], "Merge remote-tracking branch 'fork/topic'"], ["p4", ["m0"]],
      ["m3", ["m2", "p3"], "Merge branch 'a:b'"], ["p3", ["m0"]],
      ["m2", ["m1", "p2"], "Merge branch 'x..y' into main"], ["p2", ["m0"]],
      ["m1", ["mm", "p1"], "Merge remote-tracking branch 'origin/abcdef1'"], ["p1", ["m0"]],
      ["mm", ["m0", "p0"], "Merge abcdef1234 into main"], ["p0", ["m0"]],
      ["m0", []],
    ],
    branches: [["main", "m5"], ["origin/main", "m5", { remote: true }], ["fork/feat", "m0", { remote: true }],
      ["fork/team/feat", "m0", { remote: true, onRemote: "feat" }]],
  },
  "octopus merge names, and a remote with no name_on_remote": {
    rows: [["m1", ["m0", "q1", "q2", "q3"], "Merge branches 'feat/one', 'feat/two' and 'feat/three'"],
      ["q1", ["m0"]], ["q2", ["m0"]], ["q3", ["m0"]], ["k1", ["m0"]], ["m0", []]],
    branches: [["main", "m1"], ["stale/leftover", "k1", { remote: true, onRemote: null }]],
  },
  "non-ASCII names: ASCII check before uppercase, UTF-8 hash": {
    rows: [["u3", ["m0"]], ["u2", ["m0"]], ["u1", ["m0"]], ["m0", []]],
    branches: [["main", "m0"], ["功能/ßeta-ıx", "u3"], ["fix/ünïcode", "u2"], ["分支", "u1"]],
  },
  "trunk local and remote diverged → second segment is not slot 0": {
    rows: [["r1", ["m0"]], ["l1", ["m0"]], ["m0", []]],
    branches: [["main", "l1"], ["origin/main", "r1", { remote: true }]],
  },
  "octopus with 70 parents (cap 64)": {
    rows: [["oct", ["m0", ...octopusRoots], "Merge branches 'b1', 'b2'"], ...octopusRoots.map((r) => [r, []]), ["m0", []]],
    branches: [["main", "oct"]],
  },
  "2,520 out-of-window merge parents (cap 256) → one shared overflow line": {
    rows: Array.from({ length: 40 }, (_, i) => [`s${i}`, [i + 1 < 40 ? `s${i + 1}` : "gone", ...Array.from({ length: 63 }, (_, j) => `x${j}`)], "Merge"]),
    branches: [["main", "s0"]],
  },
  "second parent outside the window → track line": {
    rows: [["m2", ["m1", "gone1"], "Merge branch 'feat/far'"], ["m1", ["m0", "gone2"], "custom merge"], ["m0", ["gone3"]]],
    branches: [["main", "m2"]],
  },
  "HEAD outside the window": {
    rows: [["m1", ["m0"]], ["m0", []]],
    branches: [["main", "m1"], ["feat/old", "gone"]],
    head: { oid: "gone", branch: "feat/old" },
  },
  "HEAD branch without its own commit": {
    rows: [["m1", ["m0"]], ["m0", []]],
    branches: [["main", "m1"], ["feat/new", "m1"]],
    head: { oid: "m1", branch: "feat/new" },
  },
  "detached HEAD outside the window, no trunk": {
    rows: [["c2", ["c1"]], ["c1", []]],
    branches: [["feat/x", "c2"]],
    head: { oid: "gone" },
    defaultBranch: null,
  },
  "30 overlapping branches exhaust the alphabet": {
    rows: [...many.map((_, i) => [`c${i}`, ["m0"]]), ["m0", []]],
    branches: [["main", "m0"], ...many.map((b, i) => [b, `c${i}`])],
  },
  "branch `tag` diverged next to a tag named `2`": {
    rows: [["m2", ["m1", "t1"], "custom merge"], ["t1", ["m0"]], ["g2", ["m0"]], ["g1", ["m0"]], ["m1", ["m0"]], ["m0", []]],
    branches: [["main", "m2"], ["tag", "g1"], ["origin/tag", "g2", { remote: true }]],
    tags: [["2", "t1"]],
  },
  "empty repo": { rows: [], branches: [], defaultBranch: null },
  // Phase 4：unborn 的 HEAD 帶分支名（HeadInfo 新契約）
  "unborn branch of an empty repo → the trunk": { rows: [], branches: [], head: { branch: "main" }, defaultBranch: null },
  "orphan main beside master, no remote → main is the trunk": {
    rows: [["m1", []]],
    branches: [["master", "m1"]],
    head: { branch: "main" },
    defaultBranch: null,
  },
  "orphan main beside the remote default master → master is the trunk": {
    rows: [["m1", []]],
    branches: [["master", "m1", { upstream: "origin/master" }], ["origin/master", "m1", { remote: true }]],
    head: { branch: "main" },
    defaultBranch: "master",
  },
};

for (const name of repos) {
  report(name, JSON.parse(readFileSync(`${dumps}dump-${name}.json`, "utf8")).graph, runProto(["--json", name]));
}
if (args.length === 0) {
  for (const [label, spec] of Object.entries(SCENARIOS)) {
    const graph = graphOf(spec);
    report(`synthetic: ${label}`, graph, runProto(["--json", "-"], JSON.stringify(graph)));
    if (show) {
      const ts = fromTs(graph);
      const short = (oid) => spec.rows.find(([l]) => full(l) === oid)?.[0] ?? oid?.slice(0, 7) ?? null;
      for (const l of ts.lines) {
        const rows = ts.commits.filter((c) => c.line === l.id).map((c) => short(c.oid));
        console.log(`       ${l.id} · ${l.kind} · slot ${l.slot} · ${l.color} · ${l.letter} · [${rows.join(" ")}]`);
      }
      console.log(`       head ${JSON.stringify({ ...ts.head, oid: short(ts.head.oid) })} · accent ${ts.accent}`);
    }
  }
}
process.exit(failed ? 1 : 0);
