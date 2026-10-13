#!/usr/bin/env node
// 0b P4 走線的第二份實作與量測：computeRoutes 的欄位 + 走線規則 → 每條軌道的折線（基準 edges() 之外，照規格文字另寫一份），
// 量規則碰到的情況。規則預設 = 組合 A + 列界匯流（v8-0b-graph-states.md §2.3.2，子超 2026-10-08 定）；
// --rules a1 = 實驗室比較時的組合 A（沒有列界匯流）；--rules old = 定案前的基準規則（對照組）。
// 量：往回折 / 交叉 = 橋（斜線或列界水平線穿過別條線的直段，含反向 merge 在空隙裡的直段）/ 擦站（< 9px）/ 同欄直段重疊（健全性）/
//     不同軌道共線重疊（同一站同一側的連接線共用的一段 = 刻意，與其他）/ 反向 merge（parent 那欄有直線從上方進站）
// 輸入：repo 名 → mockup/fidelity-out/route-dumps/dump-<repo>.json（先跑 dump.sh）；state:<名> → state_routes.mjs 的示範資料
// 用法：node --experimental-strip-types --no-warnings mockup/tools/routes/route_cases.mjs [--rules old] [--json] [repo|state:名 …]
//       --json：印第一個輸入的繪製順序折線與橋（route_compare.mjs 拿去跟基準實際畫出的比）；LIMIT=N 只看前 N 列（視窗截斷）
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { computeRoutes } from "../../../src/lib/routeMap.ts";
import { STATES } from "./state_routes.mjs";

const DUMPS = fileURLToPath(new URL("../../fidelity-out/route-dumps/", import.meta.url));
// 與基準 drawMap 同一組常數：列高、欄距、第 0 欄的 x、截斷時最後一列下方留給淡出的高度
const ROW = 34, LANE = 20, X0 = 19, TAIL = 30, EPS = 0.01;
const X = (slot) => X0 + slot * LANE;
const Y = (row) => row * ROW + ROW / 2;

export function load(name) {
  const graph = name.startsWith("state:") ? STATES[name.slice(6)]?.() : JSON.parse(readFileSync(`${DUMPS}dump-${name}.json`, "utf8")).graph;
  if (!graph) throw new Error(`no such state: ${name}`);
  const LIMIT = Number(process.env.LIMIT || 0);
  return LIMIT ? { ...graph, commits: graph.commits.slice(0, LIMIT), truncated: true } : graph;
}

// 每條軌道的折線，順序 = computeRoutes 的軌道順序（commit 由上而下、parent 依序；= 基準 edges() 的順序）
export function route(graph, rules = "a") {
  const map = computeRoutes(graph);
  const lineById = new Map(map.lines.map((l) => [l.id, l]));
  const st = new Map(map.stations.map((s) => [s.oid, s]));
  const slotOf = (oid) => lineById.get(st.get(oid).line).slot;
  const H = map.stations.length * ROW + (graph.truncated ? TAIL : 12);
  const ends = map.tracks.map((t) => {
    const x1 = X(slotOf(t.child)), y1 = Y(st.get(t.child).row);
    if (t.kind !== "beyond") return { t, x1, y1, x2: X(slotOf(t.parent)), y2: Y(st.get(t.parent).row), inside: true };
    // parent 在視窗外：第一個 parent 沿自己的線直下到底，其餘的到自己的軌道線那欄
    return { t, x1, y1, x2: t.parentIndex === 0 ? x1 : X(lineById.get(t.line).slot), y2: H, inside: false };
  });
  // parent 那欄已經有直線從上方進站：視窗內、同一欄的軌道
  const fed = new Set(ends.filter((e) => e.inside && e.x1 === e.x2).map((e) => e.t.parent));
  // Z：水平段沿 parent 上方（fork）/ merge 下方（merge）的列界；fork 先沿自己那欄直下到 parent 的上一列，merge 最後沿 parent 那欄直下
  const zFork = (x1, y1, x2, y2, side) => {
    const boundary = y2 - ROW / 2, pts = [[x1, y1]];
    if (y2 - ROW > y1) pts.push([x1, y2 - ROW]);
    return [...pts, [x1 + side * (ROW / 2), boundary], [x2 - side * (ROW / 2), boundary], [x2, y2]];
  };
  const zMerge = (x1, y1, x2, y2, side) => {
    const boundary = y1 + ROW / 2, pts = [[x1, y1], [x1 + side * (ROW / 2), boundary], [x2 - side * (ROW / 2), boundary], [x2, y1 + ROW]];
    return y2 > y1 + ROW ? [...pts, [x2, y2]] : pts;
  };
  const tracks = ends.map(({ t, x1, y1, x2, y2, inside }) => {
    const k = t.parentIndex, dx = Math.abs(x2 - x1), dy = y2 - y1, side = Math.sign(x2 - x1);
    const make = (pts, how) => ({ child: t.child, parent: t.parent, k, color: lineById.get(t.line).color, pts, how, link: how !== "straight" });
    if (dx === 0) return make([[x1, y1], [x2, y2]], "straight");
    if (rules === "old") {
      return k === 0 ? make([[x1, y1], [x1, y2 - dx], [x2, y2]], "45") : make([[x1, y1], [x2, y1 + dx], [x2, y2]], "45");
    }
    // 規則 3（merge 先看）：反向 merge → 45° 進 parent 那欄旁的空隙（半個欄距）→ 直下 → 45° 進站；放不下第一段 45° 就一條直線斜接
    if (k > 0 && inside && fed.has(t.parent)) {
      const gap = x2 - side * (LANE / 2), down = y1 + Math.abs(gap - x1);
      if (down <= y2 - LANE / 2) return make([[x1, y1], [gap, down], [gap, y2 - LANE / 2], [x2, y2]], "gap");
      return make([[x1, y1], [x2, y2]], "slant");
    }
    // 規則 1：跨 1–2 欄且 dx ≤ dy → 單一 45°；fork 在 parent 端轉、merge 在自己這端轉
    if (dx < 3 * LANE && dx <= dy) {
      return k === 0 ? make([[x1, y1], [x1, y2 - dx], [x2, y2]], "45") : make([[x1, y1], [x2, y1 + dx], [x2, y2]], "45");
    }
    // 規則 2：跨 3 欄以上或 dx > dy → Z
    return make(k === 0 ? zFork(x1, y1, x2, y2, side) : zMerge(x1, y1, x2, y2, side), "z");
  });
  // 規則 5 列界匯流（子超 2026-10-08 定）：一站的某一側只要有連接線沿列界進站（最後一段 = 列界到站心的 17px 45°），
  // 同一側照舊 45° 進站的也併進那條列界：跨 2 欄的改走 Z，跨 1 欄的走迷你 Z（沿自己那欄直下到列界、沿列界 3px、接同一段 45°）。
  // 出站對稱（一側有沿列界出站的：2 欄的 merge 改走 Z，1 欄的先接同一段 45°、沿列界 3px、再直下）。
  // 不會連鎖：2 欄改成的 Z 走的是同一條列界，另一端（fork 的子站、merge 的 parent）是直進直出
  if (rules === "a") {
    const along = (a, b) => Math.abs(b[0] - a[0]) === ROW / 2 && b[1] - a[1] === ROW / 2;
    const into = new Set(), outOf = new Set();
    for (const tr of tracks) {
      const n = tr.pts.length, [a, b] = [tr.pts[n - 2], tr.pts[n - 1]], [c, d] = tr.pts;
      if (along(a, b)) into.add(`${b[0]},${b[1]},${Math.sign(a[0] - b[0])}`);
      if (along(c, d)) outOf.add(`${c[0]},${c[1]},${Math.sign(d[0] - c[0])}`);
    }
    for (const tr of tracks) {
      if (tr.how !== "45") continue;
      const [p, , r] = tr.pts, span = Math.abs(r[0] - p[0]), side = Math.sign(r[0] - p[0]);
      if (!(tr.k === 0 ? into.has(`${r[0]},${r[1]},${-side}`) : outOf.has(`${p[0]},${p[1]},${side}`))) continue;
      if (span === 2 * LANE) {
        tr.pts = tr.k === 0 ? zFork(p[0], p[1], r[0], r[1], side) : zMerge(p[0], p[1], r[0], r[1], side);
        tr.how = "z (joins)";
      } else {
        tr.pts = tr.k === 0
          ? [p, [p[0], r[1] - ROW / 2], [r[0] - side * (ROW / 2), r[1] - ROW / 2], r]
          : [p, [p[0] + side * (ROW / 2), p[1] + ROW / 2], [r[0], p[1] + ROW / 2], r];
        tr.how = "mini-z";
      }
    }
  }
  // 繪製順序：照軌道順序，但連接線佔的那些位置改成依跨距由遠到近（同一站進出的連接線共用的那段 = 近欄的顏色）
  const reach = (tr) => Math.abs(tr.pts[tr.pts.length - 1][0] - tr.pts[0][0]);
  const queue = tracks.filter((tr) => tr.link).sort((a, b) => reach(b) - reach(a));
  const order = tracks.map((tr) => (tr.link ? queue.shift() : tr));
  const stations = map.stations.map((s) => ({ x: X(lineById.get(s.line).slot), row: s.row }));
  return { map, tracks, order, stations, H };
}

export function measure({ tracks, stations }) {
  const segs = [];
  tracks.forEach((tr, i) => tr.pts.forEach((b, s) => { if (s > 0) segs.push({ i, a: tr.pts[s - 1], b }); }));
  const isVertical = (s) => Math.abs(s.a[0] - s.b[0]) < EPS;
  const vertical = segs.filter(isVertical);
  const back = new Set(segs.filter((s) => s.b[1] < s.a[1] - EPS).map((s) => s.i));
  const yAt = (s, x) => s.a[1] + ((x - s.a[0]) / (s.b[0] - s.a[0])) * (s.b[1] - s.a[1]);
  // 交叉 = 橋：非直段穿過別條軌道的直段，交點不在任一方的端點
  const crossings = [];
  for (const s of segs) {
    if (isVertical(s)) continue;
    const lo = Math.min(s.a[0], s.b[0]), hi = Math.max(s.a[0], s.b[0]);
    for (const v of vertical) {
      const x = v.a[0];
      if (v.i === s.i || x <= lo + EPS || x >= hi - EPS) continue;
      const y = yAt(s, x);
      if (y > Math.min(v.a[1], v.b[1]) + EPS && y < Math.max(v.a[1], v.b[1]) - EPS) crossings.push({ upper: s.i, lower: v.i, x, y });
    }
  }
  // 擦站：非直段在中間欄經過別條線的站，距站心 < 9px（站半徑 + 線寬）
  const stationAt = new Set(stations.map((s) => `${s.x}|${s.row}`));
  const grazes = [];
  for (const s of segs) {
    if (isVertical(s)) continue;
    const lo = Math.min(s.a[0], s.b[0]), hi = Math.max(s.a[0], s.b[0]);
    for (let x = X(Math.ceil((lo - X0) / LANE)); x < hi - EPS; x += LANE) {
      if (x <= lo + EPS) continue;
      const y = yAt(s, x), r = Math.round((y - ROW / 2) / ROW);
      if (stationAt.has(`${x}|${r}`) && Math.abs(y - Y(r)) < 9) grazes.push({ i: s.i, x, y, row: r });
    }
  }
  // 不同軌道的共線重疊（直段依 x、水平依 y、斜線依斜率與截距分桶）；同欄直段重疊另列（健全性：應為 0）
  const buckets = new Map();
  for (const s of segs) {
    const dxs = s.b[0] - s.a[0], dys = s.b[1] - s.a[1];
    let key, lo, hi;
    if (Math.abs(dxs) < EPS) [key, lo, hi] = [`v${s.a[0]}`, Math.min(s.a[1], s.b[1]), Math.max(s.a[1], s.b[1])];
    else if (Math.abs(dys) < EPS) [key, lo, hi] = [`h${s.a[1]}`, Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0])];
    else {
      const m = dys / dxs;
      [key, lo, hi] = [`d${m.toFixed(3)}|${(s.a[1] - m * s.a[0]).toFixed(1)}`, Math.min(s.a[0], s.b[0]), Math.max(s.a[0], s.b[0])];
    }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ lo, hi, s, key });
  }
  const overlaps = [];
  for (const list of buckets.values()) {
    list.sort((p, q) => p.lo - q.lo);
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length && list[b].lo < list[a].hi - EPS; b++) {
        const len = Math.min(list[a].hi, list[b].hi) - list[b].lo;
        if (list[a].s.i !== list[b].s.i && len > 1) overlaps.push({ a: list[a].s.i, b: list[b].s.i, key: list[a].key, len });
      }
    }
  }
  const vOverlap = overlaps.filter((o) => o.key.startsWith("v"));
  // 刻意的共用段：兩條連接線進同一個 parent，或出同一個 child（匯進 / 分出同一站）
  const sameStation = (o) => tracks[o.a].parent === tracks[o.b].parent || tracks[o.a].child === tracks[o.b].child;
  const shared = overlaps.filter((o) => !o.key.startsWith("v") && sameStation(o));
  const other = overlaps.filter((o) => !o.key.startsWith("v") && !shared.includes(o));
  // 貼近：不同軌道的兩段沒有碰到（不是交叉、不是匯流的接點、不是共線），中心線卻不到 5px（線寬 3.25，邊緣間隙 < 1.75px）。
  // 上面幾項都量不到這種「擠在一起」：例如跨 3 欄的 Z 沿列界進站，從 1 欄外 45° 進同一站的那條轉角在列界上方 3px。
  // 最近的兩點只要有一點落在對方那條線上（別的段），就是接上了：兩條在那裡有橋 = 橋邊的轉角（子超 2026-10-08 接受，
  // 下層那條在那裡已經挖洞，實際碰不到），沒有橋 = T 型匯流（迷你 Z 的接點），都不算貼近
  const polyDist = (pt, i) => Math.min(...tracks[i].pts.slice(1).map((b, k) => pointSeg(pt, tracks[i].pts[k], b)));
  const bridgedNear = (i, j, pt) => crossings.some((c) => ((c.upper === i && c.lower === j) || (c.upper === j && c.lower === i)) && Math.hypot(c.x - pt[0], c.y - pt[1]) < NEAR);
  const near = [], beside = [];
  const box = segs.map((s) => ({ s, x0: Math.min(s.a[0], s.b[0]), x1: Math.max(s.a[0], s.b[0]), y0: Math.min(s.a[1], s.b[1]), y1: Math.max(s.a[1], s.b[1]) }));
  box.sort((p, q) => p.y0 - q.y0);
  for (let i = 0; i < box.length; i++) {
    for (let j = i + 1; j < box.length && box[j].y0 <= box[i].y1 + NEAR; j++) {
      const [p, q] = [box[i], box[j]];
      if (p.s.i === q.s.i || p.x0 > q.x1 + NEAR || q.x0 > p.x1 + NEAR) continue;
      const d = segDist(p.s.a, p.s.b, q.s.a, q.s.b);
      if (d <= EPS || d >= NEAR) continue;
      const [onP, onQ] = closest(p.s.a, p.s.b, q.s.a, q.s.b);
      const pair = { a: p.s.i, b: q.s.i, d, at: onP };
      if (polyDist(onP, q.s.i) > EPS && polyDist(onQ, p.s.i) > EPS) near.push(pair);
      else if (bridgedNear(p.s.i, q.s.i, onP) || bridgedNear(p.s.i, q.s.i, onQ)) beside.push(pair);
    }
  }
  return { back, crossings, grazes, vOverlap, shared, other, near, beside };
}

const NEAR = 5;
// 點到線段、線段到線段的距離（相交為 0）
function pointSeg(p, a, b) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]], len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function crosses(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
function segDist(a, b, c, d) {
  if (crosses(a, b, c, d)) return 0;
  return Math.min(pointSeg(a, c, d), pointSeg(b, c, d), pointSeg(c, a, b), pointSeg(d, a, b));
}
// 不相交的兩段，最近的一對點（一端在 ab、一端在 cd）：一定有一個是端點
function foot(p, a, b) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]], len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return [a[0] + t * dx, a[1] + t * dy];
}
function closest(a, b, c, d) {
  const cand = [[a, foot(a, c, d)], [b, foot(b, c, d)], [foot(c, a, b), c], [foot(d, a, b), d]];
  return cand.sort((p, q) => Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) - Math.hypot(q[0][0] - q[1][0], q[0][1] - q[1][1]))[0];
}

function report(name, rules) {
  const graph = load(name);
  const r = route(graph, rules);
  const m = measure(r);
  const { tracks, map } = r;
  const short = (oid) => oid.slice(0, 7);
  const tally = (list) => Object.entries(list.reduce((acc, k) => ((acc[k] = (acc[k] ?? 0) + 1), acc), {})).map(([k, n]) => `${k} ${n}`).join(", ");
  const span = (tr) => Math.abs(tr.pts[tr.pts.length - 1][0] - tr.pts[0][0]) / LANE;
  console.log(`\n== ${name}: ${map.stations.length} rows, ${map.slotCount} slots, ${tracks.length} tracks, truncated=${graph.truncated} · rules ${{ old: "old", a1: "A without rule 5" }[rules] ?? "A"}`);
  console.log(`  links by shape: ${tally(tracks.map((tr) => tr.how))}`);
  console.log(`  back-folds: ${m.back.size}`);
  console.log(`  crossings (bridges): ${m.crossings.length} points on ${new Set(m.crossings.map((c) => c.lower)).size} lower tracks`);
  console.log(`  grazes (<9px from a station): ${m.grazes.length}`);
  console.log(`  sanity, same-column straight overlaps: ${m.vOverlap.length}`);
  const reverse = tracks.filter((tr) => tr.how === "gap" || tr.how === "slant");
  if (reverse.length) console.log(`  reverse merges: ${reverse.length} (${tally(reverse.map((tr) => `${tr.how} ${span(tr)}col`))})`);
  // 共用段：依它們匯進 / 分出的那一站，每站一行
  const byStation = new Map();
  for (const o of m.shared) {
    const [a, b] = [tracks[o.a], tracks[o.b]];
    const at = a.parent === b.parent ? `into ${short(a.parent)}` : `out of ${short(a.child)}`;
    const e = byStation.get(at) ?? { links: new Set(), len: 0 };
    e.links.add(a).add(b);
    e.len += o.len;
    byStation.set(at, e);
  }
  console.log(`  shared stretches (links into or out of one station): ${byStation.size} stations`);
  for (const [at, e] of [...byStation].sort((p, q) => q[1].links.size - p[1].links.size).slice(0, 8)) {
    console.log(`    ${at}: ${e.links.size} links (${[...e.links].map((tr) => `${span(tr)}col ${tr.how}${tr.k ? " merge" : ""}`).join(", ")}), ${e.len.toFixed(0)}px in common`);
  }
  if (byStation.size > 8) console.log(`    … ${byStation.size - 8} more`);
  console.log(`  other collinear overlaps (no station in common): ${m.other.length}`);
  for (const o of m.other.slice(0, 6)) {
    const [a, b] = [tracks[o.a], tracks[o.b]];
    console.log(`    ${short(a.child)}→${short(a.parent)} (${a.how}) / ${short(b.child)}→${short(b.parent)} (${b.how}) along ${o.key}, ${o.len.toFixed(1)}px`);
  }
  // 貼近與橋邊轉角：同一對軌道只報一次（取最近的距離）
  const once = (list) => {
    const pairs = new Map();
    for (const n of list) {
      const key = n.a < n.b ? `${n.a}|${n.b}` : `${n.b}|${n.a}`;
      if (!pairs.has(key) || pairs.get(key).d > n.d) pairs.set(key, n);
    }
    return [...pairs.values()];
  };
  const list = once(m.near);
  const kin = (n) => tracks[n.a].parent === tracks[n.b].parent || tracks[n.a].child === tracks[n.b].child;
  const kind = (n) => (kin(n) ? "one station" : "unrelated");
  console.log(`  corners beside a bridge (<${NEAR}px from the line it crosses, accepted): ${once(m.beside).length} pairs`);
  console.log(`  near misses (<${NEAR}px apart, not touching): ${list.length} pairs${list.length ? ` (${tally(list.map(kind))})` : ""}`);
  for (const n of list.sort((p, q) => p.d - q.d).slice(0, 8)) {
    const [a, b] = [tracks[n.a], tracks[n.b]];
    const row = Math.round((n.at[1] - ROW / 2) / ROW);
    console.log(`    ${n.d.toFixed(1)}px near row ${row} (${n.at.map((v) => +v.toFixed(1)).join(",")}): ${short(a.child)}→${short(a.parent)} (${span(a)}col ${a.how}) / ${short(b.child)}→${short(b.parent)} (${span(b)}col ${b.how}) — ${kind(n)}`);
  }
  return { r, m };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const rules = args.includes("--rules") ? args[args.indexOf("--rules") + 1] : "a";
  const names = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--rules");
  if (args.includes("--json")) {
    const { tracks, order } = route(load(names[0]), rules);
    const { crossings } = measure({ tracks, stations: [] });
    console.log(JSON.stringify({
      lines: order.map(({ color, pts }) => ({ color, pts })),
      crossings: crossings.map((c) => ({ lower: tracks[c.lower].pts, x: c.x, y: c.y })),
    }));
  } else {
    for (const name of names.length ? names : ["v8fixture", "kira", "work", "react"]) report(name, rules);
  }
}
