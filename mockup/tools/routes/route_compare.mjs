#!/usr/bin/env node
// 走線的兩份實作互比：基準實際畫出的線（wk-shot 跑 routes_paths.js 讀 SVG）= route_cases.mjs 對同一份 GraphData 算的。
// 比：繪製順序逐條相同的 (顏色, 折線)；橋（下層線 + 交點）同一組。
// 先證明比較器會叫（改一個座標 / 一個顏色 / 拿掉一座橋都必須不同），最後跑對照組（--rules old 與 a1 對 routes 都必須不同）。
// 用法：node --experimental-strip-types --no-warnings mockup/tools/routes/route_compare.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { load, measure, route } from "./route_cases.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const REF = here("../../v8-kirazuri-lines-sys.html");
const WK = here("../wk-shot");
// 基準的狀態 → state_routes.mjs 的同一份 GraphData（預設與 ?on= / 殼層批共用同一張圖）
const CASES = [["", "default"], ["state=young", "young"], ["state=routes", "routes"]];

function drawn(params) {
  const url = `file://${REF}?theme=light${params ? `&${params}` : ""}`;
  const out = execFileSync(WK, [url, "1400", "900", "-", here("routes_paths.js"), "ready"], { encoding: "utf8" });
  const json = out.split("\n").find((l) => l.startsWith("{"));
  if (!json) throw new Error(`no JSON from wk-shot for ?${params}: ${out}`);
  return JSON.parse(json);
}

function computed(state, rules) {
  const { tracks, order } = route(load(`state:${state}`), rules);
  const { crossings } = measure({ tracks, stations: [] });
  return {
    lines: order.map(({ color, pts }) => ({ color, pts })),
    crossings: crossings.map((c) => ({ lower: tracks[c.lower].pts, x: c.x, y: c.y })),
  };
}

const key = (o) => JSON.stringify(o);
// 不同的地方（找不到就回空陣列）
function differences(a, b) {
  const out = [];
  if (a.lines.length !== b.lines.length) out.push(`line count ${a.lines.length} vs ${b.lines.length}`);
  a.lines.forEach((l, i) => {
    if (b.lines[i] && key(l) !== key(b.lines[i])) out.push(`line ${i}: ${key(l)} vs ${key(b.lines[i])}`);
  });
  const sort = (list) => list.map((c) => key({ lower: c.lower, x: +c.x.toFixed(3), y: +c.y.toFixed(3) })).sort();
  if (key(sort(a.crossings)) !== key(sort(b.crossings))) out.push(`bridges ${key(sort(a.crossings))} vs ${key(sort(b.crossings))}`);
  return out;
}

let failed = 0;
const say = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); };

const shots = new Map(CASES.map(([params, state]) => [state, drawn(params)]));
// 比較器自測：改壞一處必須被抓到
{
  const base = shots.get("routes");
  const bad = JSON.parse(JSON.stringify(base));
  bad.lines[3].pts[1][0] += 1;
  const badColor = JSON.parse(JSON.stringify(base));
  badColor.lines[0].color = "gunjo";
  const noBridge = { ...base, crossings: base.crossings.slice(1) };
  say(differences(base, bad).length > 0 && differences(base, badColor).length > 0 && differences(base, noBridge).length > 0,
    "selftest: one coordinate, one colour, one bridge off are each caught");
}
for (const [params, state] of CASES) {
  const got = shots.get(state), want = computed(state, "a");
  const diff = differences(got, want);
  say(diff.length === 0, `?${params || "(default)"} = route_cases state:${state} (${got.lines.length} lines, ${got.crossings.length} bridges on ${got.holes} lines)`);
  for (const d of diff.slice(0, 5)) console.log(`      ${d}`);
}
// 對照組：定案前的規則、沒有列界匯流（規則 5）的組合 A，都畫不出基準的 routes
for (const rules of ["old", "a1"]) {
  const diff = differences(shots.get("routes"), computed("routes", rules));
  say(diff.length > 0, `control: route_cases --rules ${rules} differs from ?state=routes (${diff.length} differences)`);
}
console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
