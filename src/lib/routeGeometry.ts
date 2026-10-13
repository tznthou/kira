/**
 * 路線圖（v8）的幾何：把 computeRoutes 的 RouteMap 算成 SVG 要畫的東西——每條軌道的折線與顏色、
 * 繪製順序、交叉處的挖洞、每一站的站型與座標、SVG 的尺寸與 `--gutter`。純函式，不碰 DOM、不讀 store。
 *
 * 照搬設計基準 `mockup/v8-kirazuri-lines-sys.html` 的 `edges()`（1041-1090）與 `drawMap()`（1092-1172）。
 * graph 元件只把這裡的輸出原樣轉成 JSX，所以數字與字串的產生法要與基準逐字相同：座標用同一個算式、
 * 同樣的運算順序（洞的 y 可能是浮點數，算式換個寫法尾數就可能不同），字串用檔尾的 helper 產生。
 * 走線規則（`.claude/pi-plans/v8-0b-graph-states.md` §2.3.2，子超 2026-10-08 定案）：
 *
 * 1. 連接線（fork / merge / 視窗外 merge）跨 1–2 欄且 dx ≤ dy → 單一 45°：fork 在 parent 端轉、
 *    merge 在自己這端轉。
 * 2. 跨 3 欄以上或 dx > dy → Z：沿列界水平走，兩端 45° 進出。fork 先沿自己那欄直下到 parent 的上一列；
 *    merge 最後沿 parent 那欄直下。列界上沒有站，所以水平段不會擦過任何站。
 * 3. 反向 merge（parent 那欄已經有直線從上方進站，例如 main 合進功能分支）→ 45° 進 parent 欄旁的
 *    空隙（半個欄距）→ 直下 → 45° 進站；第一段 45° 放不下就一條直線斜接。merge 先看這條再看 1 / 2。
 * 4. 繪製：套管一組、線一組，都照軌道順序（commit 由上而下、parent 依序），但連接線佔的那些位置改成
 *    依跨距由遠到近重排——進出同一站的共用段因此是近欄的顏色。交叉 = 橋：下層那條的直段挖一個套管寬的洞，
 *    上層線完全不動，所以「斜線與列界水平線在上、直段被挖」跟繪製順序無關。
 * 5. 列界匯流：一站的某一側只要有連接線沿列界進站，同一側照單一 45° 進站的也併進那條列界——跨 2 欄的改走 Z、
 *    跨 1 欄的走迷你 Z（沿自己那欄直下到列界、沿列界 3px、接同一段 45°）。出站對稱。不連鎖：改成的 Z
 *    走同一條列界，另一端直進直出。
 *
 * 與基準不同的只有三處（`.claude/pi-plans/v8-phase4-plan.md` 0.3、0.4 #11、step 6）：
 * - 視窗外 merge 接到那條軌道線自己的欄。基準寫 `X(c.lane + 1)`（1054），只在示範資料上剛好相同；
 *   第二份實作 `mockup/tools/routes/route_cases.mjs` 就是接到軌道線的欄。
 * - SVG 寬與 `--gutter` 用 `routes.slotCount`。基準用「所有站的最大欄」（1095），但視窗外 merge 的軌道線
 *   可能在所有站的右邊（v8fixture 前 125 列：軌道線在欄 3、站最多到欄 2），照搬的話套管會貼到 hash 欄。
 * - 橋有預算（BRIDGE_WORK / BRIDGE_CAP）：交叉多到不合理的圖整張不挖洞。基準只畫示範資料，碰不到。
 */
import { pushTo, type Line, type LineColor, type RouteMap } from "./routeMap";
import type { GraphData } from "./tauri";

/** 列高、欄距、第 0 欄的 x、線寬（基準 965） */
export const ROW = 34;
export const LANE = 20;
export const X0 = 19;
export const LW = 3.25;
/** 截斷時最後一列下方留給淡出的高度（基準 969）；沒截斷只留 END_PAD */
export const TAIL = 30;
const END_PAD = 12;
/** 套管與洞的寬度：線寬兩側各多 1.75（基準 1127、1131） */
export const CASING_W = LW + 3.5;
/** 洞沿上層那段往交點兩側各延伸多少：45° 的斜線也足以蓋過下層線的寬度（基準 1125） */
const HOLE_REACH = 6;
/**
 * 橋的預算（基準沒有）：交叉數可以隨 merge 數平方成長——1000 列各 merge 3 個視窗外的舊 commit，每條都直下到底、
 * 被後面每一條沿列界的水平段穿過，就有 73 萬個洞（每個洞是 mask 裡的一個 `<path>`），每列 63 個時連算都會耗盡記憶體。
 * 搜尋量（非直段數 × 直段數）或洞數超過預算就整張不挖洞：線照畫，交叉處沒有橋。真 repo 量過最多的是 git/git 1000 列：
 * 搜尋量 148 萬、洞 18,331（kernel 80 萬 / 6,926、react 36 萬 / 690；`.claude/pi-plans/v8-phase4-plan.md` step 6）
 */
const BRIDGE_WORK = 20_000_000;
const BRIDGE_CAP = 50_000;

export const X = (slot: number) => X0 + slot * LANE;
export const Y = (row: number) => row * ROW + ROW / 2;

export type Point = [number, number];

export interface Edge {
  child: string;
  /** 可能在視窗外（那條線畫到 SVG 底） */
  parent: string;
  parentIndex: number;
  /** 軌道所屬的線（`Track.line`）的顏色 → `var(--l-${color})` */
  color: LineColor;
  pts: Point[];
  /** 連接線（fork / merge / 視窗外 merge）；同一欄的直線為 false */
  link: boolean;
}

export interface Hole {
  /** 交點：下層直段的 x、上層那段在那裡的 y */
  at: Point;
  /** 挖掉的那段：沿上層那段、交點兩側各 6px（裁在那段的範圍內），畫成寬 CASING_W 的黑線 */
  cut: [Point, Point];
}

/** head：金箔；interchange：轉乘圈；terminus：終點橫槓；tick：一般短刻 */
export type StationKind = "head" | "interchange" | "terminus" | "tick";

export interface StationMark {
  oid: string;
  row: number;
  x: number;
  y: number;
  kind: StationKind;
  /** 這站所在線的顏色：終點橫槓與短刻用。轉乘圈一律是 --l-trunk、金箔是金色（基準 1147-1152） */
  color: LineColor;
}

export interface Geometry {
  width: number;
  height: number;
  /** 寫在捲動區的 `--gutter`（px）：列的左留白，頁尾也照它對齊 hash 欄 */
  gutter: number;
  /** 截斷時淡出從這個 y 開始（最後一列站心下方 11px）；沒截斷為 null */
  fadeFrom: number | null;
  /** 繪製順序（套管一組、線一組都照這個順序） */
  edges: Edge[];
  /** edges 的位置 → 從那條線挖掉的洞，依找到的順序；Map 的順序 = 基準 `<defs>` 裡 mask 的順序 */
  holes: Map<number, Hole[]>;
  /** 列的順序 */
  stations: StationMark[];
}

/** 繪製前的軌道：once = 單一 45° 的連接線（列界匯流只改這種） */
interface Draft extends Edge {
  once: "fork" | "merge" | null;
}

// ---- Z 形（基準 1033-1040）----

/** fork：沿子站那欄直下到 parent 的上一列 → 45° 到 parent 上方的列界 → 沿列界 → 45° 進站 */
function zFork(x1: number, y1: number, x2: number, y2: number, dir: number): Point[] {
  const yb = y2 - ROW / 2;
  const down: Point[] = yb - ROW / 2 > y1 ? [[x1, yb - ROW / 2]] : [];
  return [[x1, y1], ...down, [x1 + (dir * ROW) / 2, yb], [x2 - (dir * ROW) / 2, yb], [x2, y2]];
}

/** merge：45° 到 merge 站下方的列界 → 沿列界 → 45° 進 parent 那欄 → 直下 */
function zMerge(x1: number, y1: number, x2: number, y2: number, dir: number): Point[] {
  const yb = y1 + ROW / 2;
  const down: Point[] = y2 > yb + ROW / 2 ? [[x2, y2]] : [];
  return [[x1, y1], [x1 + (dir * ROW) / 2, yb], [x2 - (dir * ROW) / 2, yb], [x2, yb + ROW / 2], ...down];
}

// ---- 走線（基準 edges()）----

function route(routes: RouteMap, lineById: Map<string, Line>, height: number): Draft[] {
  const rowOf = new Map<string, number>();
  const slotOf = new Map<string, number>();
  for (const s of routes.stations) {
    rowOf.set(s.oid, s.row);
    slotOf.set(s.oid, lineById.get(s.line)?.slot ?? 0);
  }
  // parent 那欄已經有直線從上方進站：視窗內、同一欄的軌道（不論是不是同一條線）
  const fed = new Set<string>();
  for (const t of routes.tracks) {
    if (rowOf.has(t.parent) && slotOf.get(t.child) === slotOf.get(t.parent)) fed.add(t.parent);
  }

  const out: Draft[] = [];
  for (const t of routes.tracks) {
    const line = lineById.get(t.line);
    const k = t.parentIndex;
    const j = rowOf.get(t.parent);
    const x1 = X(slotOf.get(t.child) ?? 0);
    const y1 = Y(rowOf.get(t.child) ?? 0);
    const push = (pts: Point[], link = true, once: Draft["once"] = null) =>
      out.push({ child: t.child, parent: t.parent, parentIndex: k, color: line?.color ?? "trunk", pts, link, once });
    // 視窗外：第一個 parent 沿自己的線直下到底；其餘的到自己的軌道線那欄（基準是 c.lane + 1，見檔頭）
    if (j === undefined && k === 0) {
      push([[x1, y1], [x1, height]], false);
      continue;
    }
    const x2 = j !== undefined ? X(slotOf.get(t.parent) ?? 0) : X(line?.slot ?? 0);
    const y2 = j !== undefined ? Y(j) : height;
    const dx = Math.abs(x2 - x1);
    const dy = y2 - y1;
    const dir = Math.sign(x2 - x1);
    const z = dx >= 3 * LANE || dx > dy;
    if (dx === 0) push([[x1, y1], [x2, y2]], false);
    // fork 在 parent 端轉、merge 在自己這端轉
    else if (k === 0) {
      if (z) push(zFork(x1, y1, x2, y2, dir));
      else push([[x1, y1], [x1, y2 - dx], [x2, y2]], true, "fork");
    } else if (j !== undefined && fed.has(t.parent)) {
      // 規則 3：反向 merge 走 parent 欄旁的空隙；放不下第一段 45° 就一條直線斜接
      const gx = x2 - (dir * LANE) / 2;
      const run = Math.abs(gx - x1);
      push(run <= dy - LANE / 2 ? [[x1, y1], [gx, y1 + run], [gx, y2 - LANE / 2], [x2, y2]] : [[x1, y1], [x2, y2]]);
    } else if (z) push(zMerge(x1, y1, x2, y2, dir));
    else push([[x1, y1], [x2, y1 + dx], [x2, y2]], true, "merge");
  }

  // 規則 5 列界匯流：最後一段是「列界 → 站心」的 17px 45° 就是沿列界進站（第一段同理是出站）。
  // 鍵 = 站心 + 從哪一側；先全部記下再改，改成的 Z 不會再帶動別條（不連鎖）
  const along = (a: Point, b: Point) => Math.abs(b[0] - a[0]) === ROW / 2 && b[1] - a[1] === ROW / 2;
  const into = new Set<string>();
  const outOf = new Set<string>();
  for (const { pts } of out) {
    const [a, b] = pts.slice(-2);
    if (along(a, b)) into.add(`${b[0]},${b[1]} ${Math.sign(a[0] - b[0])}`);
    if (along(pts[0], pts[1])) outOf.add(`${pts[0][0]},${pts[0][1]} ${Math.sign(pts[1][0] - pts[0][0])}`);
  }
  for (const e of out) {
    if (!e.once) continue;
    const [a, , b] = e.pts;
    const dir = Math.sign(b[0] - a[0]);
    const wide = Math.abs(b[0] - a[0]) > LANE;
    if (e.once === "fork" && into.has(`${b[0]},${b[1]} ${-dir}`)) {
      e.pts = wide ? zFork(a[0], a[1], b[0], b[1], dir) : [a, [a[0], b[1] - ROW / 2], [b[0] - (dir * ROW) / 2, b[1] - ROW / 2], b];
    } else if (e.once === "merge" && outOf.has(`${a[0]},${a[1]} ${dir}`)) {
      e.pts = wide ? zMerge(a[0], a[1], b[0], b[1], dir) : [a, [a[0] + (dir * ROW) / 2, a[1] + ROW / 2], [b[0], a[1] + ROW / 2], b];
    }
  }
  return out;
}

/**
 * 橋：斜線或列界水平線穿過別條線的直段 → 那個直段在交點挖洞。同一條線自己不算；
 * 交點落在任一方的端點上（匯流、接點）也不算，所以匯在一起的線彼此不切。超過預算（BRIDGE_WORK / BRIDGE_CAP）回傳空的
 */
function findHoles(order: Edge[]): Map<number, Hole[]> {
  const straight: { n: number; x: number; top: number; bottom: number }[] = [];
  let slanted = 0;
  order.forEach((e, idx) =>
    e.pts.forEach((b, s) => {
      const a = e.pts[s - 1];
      if (!a) return;
      if (a[0] === b[0]) straight.push({ n: idx, x: a[0], top: Math.min(a[1], b[1]), bottom: Math.max(a[1], b[1]) });
      else slanted++;
    }),
  );
  const holes = new Map<number, Hole[]>();
  if (slanted * straight.length > BRIDGE_WORK) return holes;
  let found = 0;
  for (const [idx, e] of order.entries()) {
    for (let s = 1; s < e.pts.length; s++) {
      const a = e.pts[s - 1];
      const b = e.pts[s];
      if (a[0] === b[0]) continue;
      const lo = Math.min(a[0], b[0]);
      const hi = Math.max(a[0], b[0]);
      const at = (x: number) => a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
      for (const v of straight) {
        if (v.n === idx || v.x <= lo || v.x >= hi || at(v.x) <= v.top || at(v.x) >= v.bottom) continue;
        if (++found > BRIDGE_CAP) return new Map();
        const x0 = Math.max(lo, v.x - HOLE_REACH);
        const x1 = Math.min(hi, v.x + HOLE_REACH);
        pushTo(holes, v.n, { at: [v.x, at(v.x)], cut: [[x0, at(x0)], [x1, at(x1)]] });
      }
    }
  }
  return holes;
}

// ---- 繪製（基準 drawMap()）----

export function computeGeometry(routes: RouteMap, graph: GraphData): Geometry {
  const n = routes.stations.length;
  const height = n * ROW + (graph.truncated ? TAIL : END_PAD);
  // 空 repo 沒有線（slotCount 0）：基準不畫 SVG（顯示空狀態），這裡給一欄的寬度，數字才不會是負的
  const slots = Math.max(1, routes.slotCount);
  const width = X(slots) + 8;
  const gutter = X(slots - 1) + 24;

  const lineById = new Map(routes.lines.map((l) => [l.id, l]));
  const all = route(routes, lineById, height);
  // 照軌道順序，但連接線佔的那些位置依跨距由遠到近重排（sort 是穩定的：同跨距維持軌道順序）
  const reach = (e: Edge) => Math.abs(e.pts[e.pts.length - 1][0] - e.pts[0][0]);
  const links = all.filter((e) => e.link).sort((a, b) => reach(b) - reach(a));
  let nl = 0;
  const order = all.map((e) => (e.link ? links[nl++] : e));
  const holes = findHoles(order);

  // 站型照基準的判斷順序（1145-1158）：HEAD → 碰到兩條以上的線 → 沒有子 commit 或是根 → 一般短刻。
  // routeMap 的 role 對「有子 commit 的根」是 station，這裡改成終點（線的兩端都是終點）；HEAD 與轉乘優先
  const stations = routes.stations.map((s): StationMark => {
    const line = lineById.get(s.line);
    const root = graph.commits[s.row]?.parents.length === 0;
    const kind: StationKind = s.isHead
      ? "head"
      : s.role === "interchange"
        ? "interchange"
        : s.role === "terminus" || root
          ? "terminus"
          : "tick";
    return { oid: s.oid, row: s.row, x: X(line?.slot ?? 0), y: Y(s.row), kind, color: line?.color ?? "trunk" };
  });

  return {
    width,
    height,
    gutter,
    // 延伸到視窗外的線在最後一列下方淡出（基準 1164）
    fadeFrom: graph.truncated && n > 0 ? Y(n - 1) + 11 : null,
    edges: order.map(({ child, parent, parentIndex, color, pts, link }) => ({ child, parent, parentIndex, color, pts, link })),
    holes,
    stations,
  };
}

// ---- 字串（元件照用，不自己格式化）----

/** 折線 → `<path d>`（基準 1109）；洞的 cut 也用它，與基準 1127 的寫法產生同一個字串 */
export const pathD = (pts: readonly Point[]) => `M${pts.map((p) => p.join(" ")).join("L")}`;

/** 金箔六角形的半徑（基準 1149） */
export const FLAKE_R = 8.4;

/** 金箔的六角形 `<polygon points>`（基準 996-1003）：頂點朝上，座標 toFixed(2) */
export function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 3) * k - Math.PI / 2;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

/** 金箔的高光三角（基準 1150）：前兩點是原始數字、第三點 toFixed(2)——基準就是混用，照抄 */
export const shinePoints = (cx: number, cy: number) =>
  `${cx},${cy - 8.4} ${cx},${cy} ${(cx + 7.27).toFixed(2)},${(cy - 4.2).toFixed(2)}`;

/** 終點橫槓（基準 1155） */
export const terminusD = (cx: number, cy: number) => `M${cx - 6.5} ${cy}H${cx + 6.5}`;

/** 一般短刻（基準 1157） */
export const tickD = (cx: number, cy: number) => `M${cx} ${cy}H${cx + 7.5}`;

/** 選取圈半徑（基準 1180）：金箔外圈 12.5，其他 9.5 */
export const ringRadius = (isHead: boolean) => (isHead ? 12.5 : 9.5);
