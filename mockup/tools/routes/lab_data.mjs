#!/usr/bin/env node
// 走線實驗室的資料：真 repo 的 dump 跑 computeRoutes，寫成 lab.html 載入的 lab-data.js；另把基準的
// <style> 抽成 base.css，實驗室的列、線、站、主題都用基準同一份 CSS。
// 輸出在 mockup/fidelity-out/route-lab/（ignored）：kira 的 commit 訊息含私有 skill 名，資料不進版控。
// 用法：node --experimental-strip-types --no-warnings mockup/tools/routes/lab_data.mjs   （先跑 dump.sh）
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeRoutes } from "../../../src/lib/routeMap.ts";
import { STATES } from "./state_routes.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const DUMPS = here("../../fidelity-out/route-dumps/");
const OUT = here("../../fidelity-out/route-lab/");
const REF = here("../../v8-kirazuri-lines-sys.html");

function pack(graph) {
  const map = computeRoutes(graph);
  const lineIdx = new Map(map.lines.map((l, i) => [l.id, i]));
  const rowOf = new Map(map.stations.map((s) => [s.oid, s.row]));
  const tags = new Set(graph.tags.map((t) => t.name));
  const remote = new Set(graph.branches.filter((b) => b.is_remote).map((b) => b.name));
  const byOid = new Map(graph.commits.map((c) => [c.full_oid, c]));
  const rows = map.stations.map((s) => {
    const c = byOid.get(s.oid);
    return {
      id: c.oid,
      s: c.message,
      t: c.author.timestamp,
      line: lineIdx.get(s.line),
      role: s.role,
      head: s.isHead,
      root: c.parents.length === 0,
      refs: c.refs.map((n) => ({ n, k: n === graph.head.branch ? "head" : tags.has(n) ? "tag" : remote.has(n) ? "remote" : "local" })),
    };
  });
  return {
    truncated: graph.truncated,
    lines: map.lines.map((l) => ({ id: l.id, slot: l.slot, color: l.color, letter: l.letter, kind: l.kind })),
    rows,
    tracks: map.tracks.map((t) => ({
      c: rowOf.get(t.child),
      p: rowOf.has(t.parent) ? rowOf.get(t.parent) : -1,
      k: t.parentIndex,
      kind: t.kind,
      line: lineIdx.get(t.line),
    })),
    accent: map.accent,
    slots: map.slotCount,
  };
}

mkdirSync(OUT, { recursive: true });
const repos = {};
for (const name of ["kira", "react", "v8fixture", "work"]) {
  const graph = JSON.parse(readFileSync(`${DUMPS}dump-${name}.json`, "utf8")).graph;
  repos[name] = pack(graph);
  if (name === "v8fixture") {
    // 基準的 23 列（自檢：實驗室「現行」規則畫出來必須與基準 drawMap 同一組路徑）
    repos.v8fixture23 = pack({ ...graph, commits: graph.commits.slice(0, 23), truncated: true });
  }
}
// 基準的示範狀態也當成 repo（實驗室與基準畫同一份 GraphData，方便並排）
repos["state:routes"] = pack(STATES.routes());
writeFileSync(`${OUT}lab-data.js`, `window.LAB = ${JSON.stringify({ generated: new Date().toISOString(), repos })};\n`);
const html = readFileSync(REF, "utf8");
const css = html.slice(html.indexOf("<style>") + "<style>".length, html.indexOf("</style>"));
writeFileSync(`${OUT}base.css`, css);
// 頁面與資料放同一個目錄：wk-shot 只開放讀取頁面所在的目錄
copyFileSync(here("lab.html"), `${OUT}lab.html`);
for (const [name, r] of Object.entries(repos)) console.log(`${name.padEnd(12)} ${String(r.rows.length).padStart(5)} rows ${String(r.slots).padStart(3)} slots ${String(r.tracks.length).padStart(5)} tracks`);
console.log(`wrote ${OUT}lab.html, lab-data.js and base.css (${css.length} chars of the reference's style)`);
