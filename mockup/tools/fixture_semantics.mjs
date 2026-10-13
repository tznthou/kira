#!/usr/bin/env node
// 手寫 fixture（src/dev/fidelity/fixture.ts）vs 真後端在實機 fixture repo 上的輸出（fidelity_dump）。
// 手寫 fixture 若排序、旗標、格式跟真後端不同，D1 截圖比對會過、真實 app 卻長得不一樣。
//
// 用法：node --experimental-strip-types mockup/tools/fixture_semantics.mjs [dump.json]
//   dump 預設 mockup/fidelity-out/fixture-dump.json（由 cargo test fidelity_dump 產生）
// hash 與時間不比（實機 fixture 改寫過歷史，hash 必然不同；D5 允許資料差異），commit 以 subject 對應。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as fx from "../../src/dev/fidelity/fixture.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const dumpPath = process.argv[2] ?? `${here}../fidelity-out/fixture-dump.json`;
const real = JSON.parse(readFileSync(dumpPath, "utf8"));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n     ${detail}` : ""}`);
};
// key 順序無語意：dump 經 serde_json::Value（BTreeMap）會依字母排 key，與 struct 欄位順序不同
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const subject = (m) => m.split("\n")[0];

// ---- 分支清單（側欄）----
const branchRow = (b) => `${b.name}${b.is_remote ? " [remote]" : ""}${b.is_current ? " [current]" : ""}`;
const fxBranches = fx.listBranches.branches.map(branchRow);
const realBranches = real.branches.branches.map(branchRow);
check("list_branches: names, flags, order", same(fxBranches, realBranches),
  `fixture: ${fxBranches.join(" | ")}\n     real:    ${realBranches.join(" | ")}`);
check("list_branches: detached_head_oid", fx.listBranches.detached_head_oid === real.branches.detached_head_oid);
const upstreams = (list) => list.filter((b) => !b.is_remote).map((b) => `${b.name}→${b.upstream?.name ?? "none"}`);
check("list_branches: upstreams", same(upstreams(fx.listBranches.branches), upstreams(real.branches.branches)),
  `fixture: ${upstreams(fx.listBranches.branches)}\n     real:    ${upstreams(real.branches.branches)}`);

// ---- graph ----
const gb = (g) => g.branches.map((b) => `${b.name}${b.is_remote ? " [remote]" : ""}`);
check("graph.branches: names, flags, order", same(gb(fx.graph), gb(real.graph)),
  `fixture: ${gb(fx.graph)}\n     real:    ${gb(real.graph)}`);
check("graph.tags", same(fx.graph.tags.map((t) => t.name), real.graph.tags.map((t) => t.name)));
// v8 Phase 2 契約欄位。head.oid 是資料差異（fixture 用 mockup 的假 hash），只比分支名與「指向第一筆 commit」
check("graph.head.branch", fx.graph.head.branch === real.graph.head.branch,
  `fixture ${fx.graph.head.branch} vs real ${real.graph.head.branch}`);
check("graph.head.oid → newest commit",
  fx.graph.head.oid === fx.graph.commits[0].full_oid && real.graph.head.oid === real.graph.commits[0].full_oid);
check("graph.default_branch", fx.graph.default_branch === real.graph.default_branch,
  `fixture ${fx.graph.default_branch} vs real ${real.graph.default_branch}`);
const remoteSide = (g) => g.branches.map((b) => `${b.name}: upstream=${b.upstream ?? "none"} on_remote=${b.name_on_remote ?? "none"}`);
check("graph.branches: upstream / name_on_remote", same(remoteSide(fx.graph), remoteSide(real.graph)),
  `fixture: ${remoteSide(fx.graph)}\n     real:    ${remoteSide(real.graph)}`);

const n = fx.graph.commits.length;
// fixture 只有前 n 筆：真後端以 limit = n 走 revwalk 時，後面還有 commit 就回 truncated（傾印是不設上限的全部）
check(`graph.truncated: a window of the first ${n} commits`,
  fx.graph.truncated === (real.graph.truncated || real.graph.commits.length > n),
  `fixture ${fx.graph.truncated}; real has ${real.graph.commits.length} commits, truncated=${real.graph.truncated}`);
const fxCommits = fx.graph.commits;
const realCommits = real.graph.commits.slice(0, n);
check(`graph.commits: first ${n} subjects in revwalk order`,
  same(fxCommits.map((c) => subject(c.message)), realCommits.map((c) => subject(c.message))),
  realCommits.map((c, i) => (subject(c.message) === subject(fxCommits[i].message) ? null : `#${i}: fixture "${subject(fxCommits[i].message)}" vs real "${subject(c.message)}"`)).filter(Boolean).join("\n     "));
const refsDiff = fxCommits.map((c, i) => (same(c.refs, realCommits[i]?.refs) ? null : `${subject(c.message)}: fixture ${JSON.stringify(c.refs)} vs real ${JSON.stringify(realCommits[i]?.refs)}`)).filter(Boolean);
check("graph.commits: refs on each commit (order: branches then tags)", refsDiff.length === 0, refsDiff.join("\n     "));
// parents：以 subject 對應；只比兩邊都在視窗內的 parent
const bySubject = (list) => new Map(list.map((c) => [c.full_oid, subject(c.message)]));
const fxSubj = bySubject(fxCommits);
const realSubj = bySubject(real.graph.commits);
const parentDiff = fxCommits.map((c, i) => {
  const r = realCommits[i];
  if (!r || c.parents.length !== r.parents.length) return `${subject(c.message)}: parent count ${c.parents.length} vs ${r?.parents.length}`;
  const bad = c.parents.some((p, k) => fxSubj.has(p) && fxSubj.get(p) !== realSubj.get(r.parents[k]));
  return bad ? `${subject(c.message)}: parents differ` : null;
}).filter(Boolean);
check("graph.commits: parents (count + subjects inside the window)", parentDiff.length === 0, parentDiff.join("\n     "));

// 視窗外的分支（Phase 5 5a step 3，Codex #6）：兩邊都列出、tip 都不在視窗內——fixture 的 commits，
// 真後端的前 n 筆（實機 fixture 只有約 190 筆，正式 1000 筆上限會全部收進來，所以「視窗」照上面的定義）；
// 本機與 origin 是不同的 commit（↑1 ↓2 要兩邊各有自己的 commit；計數本身由下面的 branch_stats 比）
const windowOids = new Set(realCommits.map((c) => c.full_oid));
const beyond = ["feat/t9d-watcher", "origin/feat/t9d-watcher"];
const fxBeyond = beyond.map((name) => fx.graph.branches.find((b) => b.name === name));
const realBeyond = beyond.map((name) => real.graph.branches.find((b) => b.name === name));
check("beyond the window: both refs listed on both sides", fxBeyond.every(Boolean) && realBeyond.every(Boolean),
  `fixture ${fxBeyond.map((b) => !!b)} · real ${realBeyond.map((b) => !!b)}`);
check("beyond the window: no tip inside it",
  fxBeyond.every((b) => b && !fxCommits.some((c) => c.full_oid === b.target))
    && realBeyond.every((b) => b && !windowOids.has(b.target)));
check("beyond the window: the branch and its origin are different commits",
  fxBeyond[0]?.target !== fxBeyond[1]?.target && realBeyond[0]?.target !== realBeyond[1]?.target);

// ---- working tree ----
const files = (list) => list.map((f) => `${f.path}:${f.status}`);
check("status.staged: paths, kinds, order", same(files(fx.status.staged), files(real.status.staged)),
  `fixture: ${files(fx.status.staged)}\n     real:    ${files(real.status.staged)}`);
check("status.unstaged: paths, kinds, order", same(files(fx.status.unstaged), files(real.status.unstaged)),
  `fixture: ${files(fx.status.unstaged)}\n     real:    ${files(real.status.unstaged)}`);
check("status.conflicted / unstaged_truncated",
  same(fx.status.conflicted, real.status.conflicted) && fx.status.unstaged_truncated === real.status.unstaged_truncated);

// ---- 同步狀態 ----
check("ahead_behind", same(fx.aheadBehind, real.ahead_behind), `fixture ${JSON.stringify(fx.aheadBehind)} vs real ${JSON.stringify(real.ahead_behind)}`);
const statsDiff = Object.keys(fx.branchStats).filter((k) => !same(fx.branchStats[k], real.branch_stats[k]));
check("branch_stats", statsDiff.length === 0, statsDiff.map((k) => `${k}: ${JSON.stringify(fx.branchStats[k])} vs ${JSON.stringify(real.branch_stats[k])}`).join("; "));

// ---- diff 格式不變量（兩邊都要滿足）----
function diffInvariants(result) {
  const errs = [];
  for (const f of result.files) {
    for (const h of f.hunks) {
      let oldCount = 0, newCount = 0;
      for (const l of h.lines) {
        if (![" ", "+", "-"].includes(l.origin)) errs.push(`${f.path}: origin ${JSON.stringify(l.origin)}`);
        if (l.content.endsWith("\n")) errs.push(`${f.path}: content keeps a trailing newline`);
        if ((l.origin === "+") !== (l.old_lineno === null)) errs.push(`${f.path}: old_lineno vs origin`);
        if ((l.origin === "-") !== (l.new_lineno === null)) errs.push(`${f.path}: new_lineno vs origin`);
        if (l.origin !== "+") oldCount++;
        if (l.origin !== "-") newCount++;
      }
      if (oldCount !== h.old_lines || newCount !== h.new_lines) errs.push(`${f.path}: hunk counts`);
      const lead = h.lines.findIndex((l) => l.origin !== " ");
      const trail = [...h.lines].reverse().findIndex((l) => l.origin !== " ");
      if (lead > 3 || trail > 3) errs.push(`${f.path}: ${lead}/${trail} context lines (libgit2 default is 3)`);
    }
  }
  return errs;
}
for (const [oid, result] of Object.entries(real.diffs)) {
  const errs = diffInvariants(result);
  check(`real diff ${oid.slice(0, 7)}: format invariants`, errs.length === 0, errs.join("; "));
}
for (const id of ["c9e41f2", "e81d6b0", "7b03d5e"]) {
  const errs = diffInvariants(fx.diffFor(id));
  check(`fixture diff ${id}: format invariants`, errs.length === 0, errs.join("; "));
}
// HEAD commit 的 constants.ts 在實機 fixture 是照基準刻意做出來的 → hunk 應完全相同
const realHead = real.diffs[real.graph.commits[0].full_oid].files.find((f) => f.path.endsWith("constants.ts"));
const fxHead = fx.diffFor("c9e41f2").files.find((f) => f.path.endsWith("constants.ts"));
check("HEAD diff constants.ts: identical hunks", same(realHead?.hunks, fxHead?.hunks));

console.log(`\n${failed === 0 ? "ALL SEMANTICS MATCH" : `${failed} mismatch(es)`} — dump: ${dumpPath}`);
process.exit(failed === 0 ? 0 : 1);
