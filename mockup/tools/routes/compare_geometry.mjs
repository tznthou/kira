#!/usr/bin/env node
// Phase 4a step 4：走線幾何的 TS 模組（src/lib/routeGeometry.ts）與兩個 oracle 互比。
// 1. route_cases.mjs（走線的第二份實作，照規格文字另寫）：四個真 repo 的整份 dump，加上截斷視窗——v8fixture / kira / work 每一個
//    LIMIT、react 每 50 列一個（truncated: true，同 route_cases 的 LIMIT=N）——與 state:routes / young / default。
//    比：繪製順序逐條相同的 (顏色, 折線)；橋（被挖洞的下層線 + 交點）同一組；SVG 高度。route_cases 不算寬與 --gutter，
//    另查它們裝得下實際畫出來的線（最右 x + 28 / + 24 = 基準的留白）——軌道線可能在所有站的右邊（v8-phase4-plan.md 0.4 #11）
// 2. 基準原始碼：從 mockup/v8-kirazuri-lines-sys.html 依標記抽出 edges() / drawMap() 與示範資料（預設 / young / routes），
//    stub 掉 DOM 跑一次，拿它寫進 <svg> 的 innerHTML、寬、高、viewBox 與 --gutter，跟「routeGeometry 的輸出照基準的寫法組成的字串」
//    逐字比。route_cases 不算 SVG 寬、--gutter、站型與洞的字串（v8-phase4-plan.md 0.3），這一段補上；
//    下面的 render() 也就是 graph 元件（4b）要寫出的 SVG 的參考
// 先證明比較器會叫：改一個座標 / 一個顏色 / 拿掉一座橋 / 對調兩條的順序 / 高度差 1 / 寬少一欄 / SVG 改一個字都要被抓到，
// 對照組 route_cases --rules a1（沒有規則 5）與 old（定案前）在 state:routes 上都必須與 TS 不同。
//
// 用法：npx vite-node mockup/tools/routes/compare_geometry.mjs [--selftest]
//   （不能用 node --experimental-strip-types：routeGeometry.ts 從 "./routeMap" 實值 import pushTo，Node 的 ESM 不補副檔名；
//   kira 1d6eae3 起就跑不起來，vite-node 用 vite 的解析器）
//   不帶參數：自測 + 全部比對；--selftest：只跑自測。有任何不同 exit 1。
//   本機工具，不進 CI：dump 在 mockup/fidelity-out/route-dumps/（先跑 dump.sh；kira 的歷史不能進 repo、react 的 dump 5MB）
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeRoutes } from "../../../src/lib/routeMap.ts";
import {
  CASING_W, FLAKE_R, LW, computeGeometry, hexPoints, pathD, shinePoints, terminusD, tickD,
} from "../../../src/lib/routeGeometry.ts";
import { load, measure, route } from "./route_cases.mjs";
import { STATES } from "./state_routes.mjs";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const REF = here("../../v8-kirazuri-lines-sys.html");
const REPOS = ["v8fixture", "kira", "work", "react"];
// react 1000 列：每 50 列一個視窗；其餘每一個 LIMIT
const STEP = { react: 50 };
const key = (o) => JSON.stringify(o);

// ---- 1. route_cases ----

function fromCases(graph, rules = "a") {
  const r = route(graph, rules);
  const { crossings } = measure({ tracks: r.tracks, stations: [] });
  return {
    lines: r.order.map(({ color, pts }) => ({ color, pts })),
    bridges: crossings.map((c) => key([r.tracks[c.lower].pts, c.x, c.y])).sort(),
    height: r.H,
  };
}

function fromTs(graph) {
  const geo = computeGeometry(computeRoutes(graph), graph);
  return {
    lines: geo.edges.map(({ color, pts }) => ({ color, pts })),
    bridges: [...geo.holes].flatMap(([n, holes]) => holes.map((h) => key([geo.edges[n].pts, h.at[0], h.at[1]]))).sort(),
    height: geo.height,
    fit: fit(geo),
  };
}

// 寬與 --gutter 要裝得下畫出來的東西：route_cases 不算這兩個，真 repo 上沒有 oracle → 用基準的留白（最右一欄 + 8 / + 24）
// 對「實際畫到的最右 x」檢查。照搬基準（站的最大欄）時，軌道線在所有站右邊的視窗會在這裡失敗（v8-phase4-plan.md 0.4 #11）
function fit(geo) {
  const xs = [...geo.edges.flatMap((e) => e.pts.map((p) => p[0])), ...geo.stations.map((s) => s.x)];
  if (xs.length === 0) return [];
  const right = Math.max(...xs);
  const out = [];
  if (geo.width !== right + 28) out.push(`width ${geo.width}, but the rightmost line is at x ${right} (want ${right + 28})`);
  if (geo.gutter !== right + 24) out.push(`--gutter ${geo.gutter}, but the rightmost line is at x ${right} (want ${right + 24})`);
  return out;
}

// 不同的地方（相同 = 空陣列）
function differences(want, got) {
  const out = [];
  if (want.lines.length !== got.lines.length) out.push(`line count ${want.lines.length} vs ${got.lines.length}`);
  want.lines.forEach((l, i) => {
    if (key(l) !== key(got.lines[i])) out.push(`line ${i}: ${key(l)} vs ${key(got.lines[i])}`);
  });
  if (key(want.bridges) !== key(got.bridges)) {
    const only = (a, b) => a.filter((x) => !b.includes(x));
    out.push(`bridges ${want.bridges.length} vs ${got.bridges.length}: only route_cases ${only(want.bridges, got.bridges).slice(0, 2).join(" ")} · only TS ${only(got.bridges, want.bridges).slice(0, 2).join(" ")}`);
  }
  if (want.height !== got.height) out.push(`height ${want.height} vs ${got.height}`);
  return [...out, ...(got.fit ?? [])];
}

// ---- 2. 基準原始碼的整張 SVG ----

function baselineSource() {
  const html = readFileSync(REF, "utf8");
  // 依標記切（不靠行號）：找不到就丟錯，基準改版時比對會明確失敗而不是悄悄空過
  const between = (start, end) => {
    const a = html.indexOf(start);
    const b = a < 0 ? -1 : html.indexOf(end, a + start.length);
    if (a < 0 || b < 0) throw new Error(`baseline marker not found: ${JSON.stringify(start)} … ${JSON.stringify(end)}`);
    return html.slice(a, b);
  };
  const data = (name, open, close) => new Function(`return ${between(`  const ${name} = ${open}`, `\n  ${close};`).replace(`  const ${name} = `, "")}\n${close};`)();
  const patch = html.match(/Object\.assign\(LINE, (\{ search: [^}]*\})\)/);
  if (!patch) throw new Error("baseline marker not found: the routes state's LINE patch");
  return {
    code: [
      between("  const ROW = 34", "\n  const reduce"), // ROW / LANE / X0 / LW / X / Y / TAIL / mapHeight / indexOf
      between("  const lc = ", "\n  // a lodger"),
      between("  function hexPoints(", "\n  /* ---------- theme"),
      between("  const zFork = ", "\n  function drawMap()"), // zFork / zMerge / edges
      between("  function drawMap() {", "\n  function drawSelectionRing()"),
    ].join("\n"),
    LINE: data("LINE", "{", "}"),
    routesLine: new Function(`return ${patch[1]}`)(),
    commits: data("commits", "[", "]"),
    YOUNG: data("YOUNG", "[", "]"),
    ROUTES: data("ROUTES", "[", "]"),
  };
}

// 基準的 drawMap() 在 stub 的 DOM 上跑一次：它寫給 <svg> 與捲動區的東西
function drawBaseline(src, { commits, headId, truncated, LINE }) {
  const out = { attrs: {} };
  const $ = (id) => (id === "graph-scroll" ? { style: { setProperty: (_, v) => (out.gutter = v) } } : null);
  const lanesSvg = { setAttribute: (k, v) => (out.attrs[k] = String(v)), set innerHTML(v) { out.svg = v; } };
  new Function("commits", "headId", "walk", "LINE", "$", "lanesSvg", "drawSelectionRing",
    `let firstPaint = false;\n${src.code}\ndrawMap();`)(commits, headId, { truncated }, LINE, $, lanesSvg, () => {});
  return out;
}

// routeGeometry 的輸出照基準 drawMap（1131-1169）的寫法組成字串：數字全部來自 geometry 與 helper，只有標記是照抄
function render(geo) {
  const W = geo.width, H = geo.height;
  const lc = (color) => `var(--l-${color})`;
  const casing = (e) => `<path d="${pathD(e.pts)}" fill="none" stroke="var(--sheet)" stroke-width="${CASING_W}" stroke-linejoin="round"/>`;
  const line = (e, n) => `<path d="${pathD(e.pts)}" fill="none" stroke="${lc(e.color)}" stroke-width="${LW}" stroke-linejoin="round" stroke-linecap="round"${geo.holes.has(n) ? ` mask="url(#hole-${n})"` : ""}/>`;
  const masks = [...geo.holes].map(([n, holes]) => `<mask id="hole-${n}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>${holes.map((h) => `<path d="${pathD(h.cut)}" stroke="#000" stroke-width="${CASING_W}"/>`).join("")}</mask>`).join("");
  let stations = "";
  for (const { x: cx, y: cy, kind, color } of geo.stations) {
    if (kind === "head") {
      stations += `<circle class="" cx="${cx}" cy="${cy}" r="8" fill="none" stroke="var(--gold-leaf)" stroke-width="2" opacity="0"/>`;
      stations += `<circle cx="${cx}" cy="${cy}" r="10.5" fill="var(--sheet)" opacity="0.92"/>`;
      stations += `<polygon points="${hexPoints(cx, cy, FLAKE_R)}" fill="var(--gold-leaf)" stroke="var(--flake-edge)" stroke-width="1.3" stroke-linejoin="round"/>`;
      stations += `<polygon points="${shinePoints(cx, cy)}" fill="oklch(1 0 0 / 0.5)"/>`;
    } else if (kind === "interchange") {
      stations += `<circle cx="${cx}" cy="${cy}" r="5.6" fill="var(--sheet-hi)" stroke="var(--l-trunk)" stroke-width="2.2"/>`;
    } else {
      stations += `<path d="${kind === "terminus" ? terminusD(cx, cy) : tickD(cx, cy)}" stroke="${lc(color)}" stroke-width="${LW}" stroke-linecap="round"/>`;
    }
  }
  let tracks = `<g>${geo.edges.map(casing).join("")}</g><g>${geo.edges.map(line).join("")}</g>`;
  if (masks) tracks = `<defs>${masks}</defs>${tracks}`;
  if (geo.fadeFrom !== null) {
    const from = geo.fadeFrom;
    tracks = `<defs><linearGradient id="run-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`
      + `<mask id="run-on" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect width="${W}" height="${from}" fill="#fff"/><rect y="${from}" width="${W}" height="${H - from}" fill="url(#run-g)"/></mask></defs>`
      + `<g mask="url(#run-on)">${tracks}</g>`;
  }
  return { svg: `${tracks}<g>${stations}</g><g id="sel-ring"></g>`, attrs: { width: String(W), height: String(H), viewBox: `0 0 ${W} ${H}` }, gutter: `${geo.gutter}px` };
}

function svgDifferences(want, got) {
  const out = [];
  for (const k of ["width", "height", "viewBox"]) if (want.attrs[k] !== got.attrs[k]) out.push(`${k} ${want.attrs[k]} vs ${got.attrs[k]}`);
  if (want.gutter !== got.gutter) out.push(`--gutter ${want.gutter} vs ${got.gutter}`);
  if (want.svg !== got.svg) {
    let i = 0;
    while (i < want.svg.length && want.svg[i] === got.svg[i]) i++;
    out.push(`svg differs at char ${i}: …${want.svg.slice(Math.max(0, i - 40), i + 60)}… vs …${got.svg.slice(Math.max(0, i - 40), i + 60)}…`);
  }
  return out;
}

const DEMOS = (src) => [
  ["default", { commits: src.commits, headId: "c9e41f2", truncated: true, LINE: src.LINE }],
  ["young", { commits: src.YOUNG, headId: "b41c7e2", truncated: false, LINE: src.LINE }],
  ["routes", { commits: src.ROUTES, headId: "3fa2c71", truncated: true, LINE: { ...src.LINE, ...src.routesLine } }],
];

// ---- 跑 ----

let failed = 0;
const say = (ok, msg, details = []) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  for (const d of details.slice(0, 5)) console.log(`      ${d}`);
};

function selftest() {
  const base = fromCases(load("state:routes"));
  const tweak = (edit) => {
    const copy = structuredClone(base);
    edit(copy);
    return differences(base, copy).length > 0;
  };
  const caught = [
    tweak((c) => (c.lines[3].pts[1][0] += 1)),
    tweak((c) => (c.lines[0].color = c.lines[0].color === "gunjo" ? "odo" : "gunjo")),
    tweak((c) => c.bridges.shift()),
    tweak((c) => ([c.lines[0], c.lines[1]] = [c.lines[1], c.lines[0]])),
    tweak((c) => (c.height += 1)),
  ];
  say(caught.every(Boolean), `selftest: a coordinate, a colour, a bridge, the order of two lines, the height off by one are each caught (${caught.map((x) => (x ? "caught" : "MISSED")).join(" / ")})`);
  const geo = computeGeometry(computeRoutes(STATES.routes()), STATES.routes());
  const short = fit({ ...geo, width: geo.width - 20, gutter: geo.gutter - 20 });
  say(fit(geo).length === 0 && short.length === 2, "selftest: width and --gutter a column short of the rightmost line are each caught");
  const ts = fromTs(STATES.routes());
  for (const rules of ["a1", "old"]) {
    const diff = differences(fromCases(STATES.routes(), rules), ts);
    say(diff.length > 0, `control: route_cases --rules ${rules} differs from routeGeometry on state:routes (${diff.length} differences)`);
  }
  const src = baselineSource();
  const want = drawBaseline(src, DEMOS(src)[2][1]);
  const got = render(computeGeometry(computeRoutes(STATES.routes()), STATES.routes()));
  const oneChar = { ...got, svg: got.svg.replace('d="M39 ', 'd="M38 ') };
  const gutter = { ...got, gutter: "104px" };
  say(oneChar.svg !== got.svg && svgDifferences(want, oneChar).length > 0 && svgDifferences(want, gutter).length > 0,
    "selftest: one character of the SVG and the --gutter off by one are each caught");
}

function compareRepos() {
  for (const name of REPOS) {
    const graph = load(name);
    const n = graph.commits.length;
    const step = STEP[name] ?? 1;
    const problems = [];
    const whole = fromTs(graph);
    for (const d of differences(fromCases(graph), whole)) problems.push(`whole: ${d}`);
    let windows = 0;
    for (let limit = step; limit <= n; limit += step) {
      const w = { ...graph, commits: graph.commits.slice(0, limit), truncated: true };
      windows++;
      for (const d of differences(fromCases(w), fromTs(w))) problems.push(`LIMIT=${limit}: ${d}`);
    }
    say(problems.length === 0,
      `${name}: whole ${n} rows (${whole.lines.length} lines, ${whole.bridges.length} bridges) + ${windows} truncated windows (every ${step === 1 ? "LIMIT" : `${step} rows`}) = route_cases`,
      problems);
  }
  for (const state of ["routes", "young", "default"]) {
    const graph = load(`state:${state}`);
    const got = fromTs(graph);
    say(differences(fromCases(graph), got).length === 0,
      `state:${state} = route_cases (${got.lines.length} lines, ${got.bridges.length} bridges)`, differences(fromCases(graph), got));
  }
}

function compareBaselineSvg() {
  const src = baselineSource();
  for (const [state, demo] of DEMOS(src)) {
    const want = drawBaseline(src, demo);
    const graph = STATES[state]();
    const got = render(computeGeometry(computeRoutes(graph), graph));
    const diff = svgDifferences(want, got);
    say(diff.length === 0, `baseline drawMap() ${state}: the whole <svg> (${want.svg.length} chars), width / height / viewBox and --gutter ${want.gutter} = routeGeometry`, diff);
  }
}

selftest();
if (!process.argv.includes("--selftest")) {
  compareRepos();
  compareBaselineSvg();
}
console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
