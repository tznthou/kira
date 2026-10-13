/**
 * 路線圖（v8）一站的 ref 標籤：顯示哪些、什麼順序、寫什麼字、圓標是哪條線，放不下的收進「+N」。
 * 純函式，不碰 DOM、不讀 store。
 *
 * 照搬設計基準 `mockup/v8-kirazuri-lines-sys.html` 的 `orderedRefs` / `rowRefs` / `spokenRefs`（1192-1228）與
 * `refHTML`（1184-1190）的資料面。
 * 規則（`.claude/pi-plans/v8-0b-graph-states.md` §4、§5，子超 2026-10-08 定案）：
 *
 * 1. 順序：detached HEAD 停在這站時，最前面一個「HEAD」pill → HEAD 的分支 → 其餘本機分支，每個後面緊接
 *    **自己的** remote-tracking ref → 其他 remote → tag。同類之內依名稱排（JS 字串比較）：`GraphData.branches`
 *    是 libgit2 的列舉順序（loose 排序後接 packed，不是字母序），基準各狀態的同類 ref 只是剛好照名稱寫。
 * 2. 自己的 remote = identity 相同 **且** 名稱是 `<前綴>/<本機名>`，標籤只寫前綴（通常是「origin」；自訂 refspec 下
 *    就是那個追蹤前綴，remote 名稱含 `/` 也照樣整段保留）。同一條線，所以圓標同字母同色。**刻意用名稱判斷**：
 *    名稱不同的 upstream（main 追蹤 origin/master）只寫「origin」會藏掉差異，所以照其他 remote 寫全名。
 * 3. 其他名稱超過 REF_CAP 字元：前 REF_CAP − 1 字 + `…`。一列標籤合計超過 REF_BUDGET 字元：從第一個超出的起
 *    全部收進 +N（`folded` 是全名，給 title 逐行列）；第一個一定顯示（標籤最多 REF_CAP 字 < REF_BUDGET，本來就放得下）。
 *    以字元計（JS 的 length，同基準）——等寬字，字元就是寬度，基準與 app 不必量測就切在同一個地方。
 *    推送後最常見的「分支 + origin」：截斷後 32 + 6 = 38，所以分支排第一時自己的 origin 永遠不會被收。
 * 4. 圓標：HEAD 的分支 = 自己的線色與字母；它還沒有自己的線（剛開、還沒 commit）= 強調色與 HEAD 的字母。
 *    自己的 remote 跟著分支（同字同色、空心），分支還沒有自己的線時也一樣（規則 2 先於下面的寄宿；
 *    Phase 4 計畫 §6 Q7，子超 2026-10-08 定）。
 *    本機 / remote 有自己的線 = 那條線的色與字母，remote 空心。沒有自己的線（寄宿：tip 停在別條線上）=
 *    無字（lodge），`--l` 用這站所在線的色。detached 的 HEAD pill = 這站所在線。tag 沒有圓標（菱形圖示）。
 */
import { byName, pushTo, type Line, type LineColor, type RefPlacement, type RouteMap, type Station } from "./routeMap";
import type { HeadInfo } from "./tauri";

/** 單一名稱最多幾個字元（基準 1197） */
export const REF_CAP = 32;
/** 一列標籤合計最多幾個字元（基準 1197） */
export const REF_BUDGET = 40;

export interface RefLabel {
  kind: "head" | "local" | "remote" | "tag";
  /** 全名；與 label 不同時元件加 title */
  name: string;
  label: string;
  /** 圓標的 `--l`；tag 沒有圓標，為 null */
  color: LineColor | null;
  /** 圓標裡的字：寄宿與 tag 為空字串；線沒有字母時同基準寫「?」 */
  letter: string;
  /** remote 一律空心 */
  hollow: boolean;
  /** 寄宿：空心無字 */
  lodge: boolean;
}

export interface RowRefs {
  shown: RefLabel[];
  /** 收進 +N 的全名，顯示順序 */
  folded: string[];
  /** 列的朗讀：每個 ref 的全名，顯示順序，收進 +N 的也念；HEAD 的分支「<名> (HEAD)」、detached 的 pill
   *  「HEAD (detached)」、tag「tag <名>」（基準 `spokenRefs`） */
  spoken: string[];
}

/** 名稱超過 REF_CAP 字元時尾端截斷（基準 1198） */
export const cutName = (s: string) => (s.length <= REF_CAP ? s : `${s.slice(0, REF_CAP - 1)}…`);

interface Index {
  stations: Map<string, Station>;
  lines: Map<string, Line>;
  refsAt: Map<string, RefPlacement[]>;
  /** `${kind}:${name}`（ref 名不能含 `:`） */
  refByName: Map<string, RefPlacement>;
}

// 每列各算一次，查表免得每列都掃一遍全部的站與 ref。RouteMap 一經算出就不再改，以它為鍵快取不影響結果
const indexes = new WeakMap<RouteMap, Index>();

function indexOf(routes: RouteMap): Index {
  let index = indexes.get(routes);
  if (!index) {
    const refsAt = new Map<string, RefPlacement[]>();
    for (const r of routes.refs) pushTo(refsAt, r.target, r);
    index = {
      stations: new Map(routes.stations.map((s) => [s.oid, s])),
      lines: new Map(routes.lines.map((l) => [l.id, l])),
      refsAt,
      refByName: new Map(routes.refs.map((r) => [`${r.kind}:${r.name}`, r])),
    };
    indexes.set(routes, index);
  }
  return index;
}

/** 圓標的樣子（基準 `roundel()` 的資料面；graph 的列與側欄共用）。`beyond`：tip 不在載入的視窗內，畫虛線圈，
 *  不用 color / letter */
export interface RoundelLook {
  color: LineColor;
  letter: string;
  hollow: boolean;
  lodge: boolean;
  beyond: boolean;
}

/** HEAD 的分支還沒有自己的線（剛開、寄宿、tip 在視窗外）：強調色就是它的偏好色，字母是 HEAD 的字母（決策 D） */
export function headLook(routes: RouteMap, hollow: boolean): RoundelLook {
  return { color: routes.accent, letter: routes.head.letter ?? "?", hollow, lodge: false, beyond: false };
}

/** 照 ref 自己的位置畫：有自己的線 = 線色與字母；tip 停在別條線的站上（寄宿）= 無字，`--l` 是那站的線色；
 *  tip 不在視窗內 = 虛線圈（決策 C）。remote 一律空心 */
export function placementLook(
  routes: RouteMap,
  ref: { kind: "head" | "local" | "remote"; line: string | null; target: string },
): RoundelLook {
  const { stations, lines } = indexOf(routes);
  const hollow = ref.kind === "remote";
  const own = ref.line === null ? undefined : lines.get(ref.line);
  if (own) return { color: own.color, letter: own.letter ?? "?", hollow, lodge: false, beyond: false };
  const station = stations.get(ref.target);
  if (!station) return { color: "trunk", letter: "", hollow, lodge: false, beyond: true };
  return { color: lines.get(station.line)?.color ?? "trunk", letter: "", hollow, lodge: true, beyond: false };
}

/**
 * 側欄一列的圓標（基準 `renderBranches` 的 `roundel` + `wearOwnLine`）。null = 骨架圓點：路線圖還沒回來，
 * 或回來了但裡面沒有這個分支（分支清單先重讀、graph 最後才到的空檔；Phase 5 Q-L）。
 * HEAD 的分支沒有自己的線 → HEAD 的樣子，它自己的 remote 也是（空心；決策 D、Q7）；其餘照自己的位置。
 * 自己的 remote 在整份清單裡找（identity 相同、名稱是 `<前綴>/<本機名>`，同 rowRefs 規則 2）：
 * 分支與它的 remote 不一定停在同一站（feat/t9d-watcher ↑1 ↓2）
 */
export function legendRoundel(
  routes: RouteMap | null,
  branch: { name: string; is_remote: boolean },
  headBranch: string | null,
): RoundelLook | null {
  if (!routes) return null;
  const { refByName } = indexOf(routes);
  const ref = refByName.get(`${branch.is_remote ? "remote" : "local"}:${branch.name}`);
  if (!ref) return null;
  const head = headBranch === null ? undefined : refByName.get(`local:${headBranch}`);
  if (head && head.line === null) {
    if (ref === head) return headLook(routes, false);
    if (ref.kind === "remote" && ref.identity !== null && ref.identity === head.identity && ref.name.endsWith(`/${head.name}`)) {
      return headLook(routes, true);
    }
  }
  return placementLook(routes, { kind: ref.kind === "remote" ? "remote" : "local", line: ref.line, target: ref.target });
}

/**
 * PR 列的「via」（基準 `lineOf` + `roundel(line.br)`，Phase 5c）：head_sha 停的那站上第一個本機 ref（沒有就 remote）
 * 的線——它自己的線，沒有自己的線就是它停靠那站的線（寄宿也畫那條線的字母，同基準）；remote 寫去掉追蹤前綴的
 * 分支名（基準只去 `origin/`；identity 就是後端依 refspec 算好的本機名）。站不在載入的視窗內（ref 指著比載入更早
 * 的 commit）→ 虛線圈，基準沒有這種情況。沒有 ref 停在那一站 → null，不畫 via
 */
export function viaLook(routes: RouteMap, sha: string): { look: RoundelLook; name: string } | null {
  const { refsAt, stations, lines } = indexOf(routes);
  const refs = refsAt.get(sha) ?? [];
  const ref = refs.find((r) => r.kind === "local") ?? refs.find((r) => r.kind === "remote");
  if (!ref) return null;
  const name = ref.kind === "remote" && ref.identity !== null ? ref.identity : ref.name;
  const line = lines.get(ref.line ?? stations.get(sha)?.line ?? "");
  if (!line) return { look: { color: "trunk", letter: "", hollow: false, lodge: false, beyond: true }, name };
  return { look: { color: line.color, letter: line.letter ?? "?", hollow: false, lodge: false, beyond: false }, name };
}

/** 排序與預算用的一筆：ref，或 detached 的 HEAD pill（identity 為 null，不會是誰的 owner） */
interface Item {
  kind: RefLabel["kind"];
  name: string;
  identity: string | null;
  line: string | null;
}

export function rowRefs(routes: RouteMap, oid: string, head: HeadInfo): RowRefs {
  const { stations, refsAt } = indexOf(routes);
  const station = stations.get(oid);
  // 不在視窗內的 commit 沒有列
  if (!station) return { shown: [], folded: [], spoken: [] };
  const list = refsAt.get(oid) ?? [];
  const sorted = (kind: RefPlacement["kind"]): Item[] =>
    list
      .filter((r) => r.kind === kind)
      .sort((a, b) => byName(a.name, b.name))
      .map((r) => ({ kind: r.kind, name: r.name, identity: r.identity, line: r.line }));

  // detached HEAD 在它停的那條線上寫自己的名字
  const pill: Item[] =
    head.branch === null && head.oid === oid ? [{ kind: "head", name: "HEAD", identity: null, line: station.line }] : [];
  const locals = sorted("local");
  const headBranch: Item[] = locals.filter((r) => r.name === head.branch).map((r) => ({ ...r, kind: "head" }));
  const branchesHere = [...pill, ...headBranch, ...locals.filter((r) => r.name !== head.branch)];
  // 每個 remote 的 owner 只找一次，順手依 owner 分組（remotes 已依名稱排，組內順序不變）。本機分支的
  // identity 就是自己的名字、彼此不重複（pill 沒有 identity），所以依 identity 查表等於逐一比對
  const branchOf = new Map<string, Item>();
  for (const b of branchesHere) if (b.identity !== null) branchOf.set(b.identity, b);
  const ownerOf = new Map<Item, Item>();
  const ownRemotes = new Map<Item, Item[]>();
  const otherRemotes: Item[] = [];
  for (const r of sorted("remote")) {
    const b = r.identity === null ? undefined : branchOf.get(r.identity);
    if (b && r.name.endsWith(`/${b.name}`)) {
      ownerOf.set(r, b);
      pushTo(ownRemotes, b, r);
    } else otherRemotes.push(r);
  }
  // 不用 push(...陣列)：一站的 ref 數由 repo 內容決定，函式引數有上限（JSC 65536）
  const ordered = branchesHere.flatMap((b) => [b, ...(ownRemotes.get(b) ?? [])]).concat(otherRemotes, sorted("tag"));

  const roundel = (r: Item): Pick<RefLabel, "color" | "letter" | "hollow" | "lodge"> => {
    if (r.kind === "tag") return { color: null, letter: "", hollow: false, lodge: false };
    // HEAD 的分支還沒有自己的線（決策 D）；其餘照自己的位置——這一站在視窗內，不會是虛線圈。
    // detached 的 pill 的 line 就是這站的線
    const { color, letter, hollow, lodge } =
      r.kind === "head" && r.line === null
        ? headLook(routes, false)
        : placementLook(routes, { kind: r.kind, line: r.line, target: oid });
    return { color, letter, hollow, lodge };
  };

  const shown: RefLabel[] = [];
  const folded: string[] = [];
  let used = 0;
  for (const r of ordered) {
    const owner = ownerOf.get(r);
    const label = owner ? r.name.slice(0, r.name.length - owner.name.length - 1) : cutName(r.name);
    if (folded.length > 0 || (shown.length > 0 && used + label.length > REF_BUDGET)) folded.push(r.name);
    else {
      // 自己的 remote 跟著分支畫：分支有自己的線時兩者本來就同線，沒有時（剛開的 HEAD 分支）也不當寄宿
      shown.push({ kind: r.kind, name: r.name, label, ...(owner ? { ...roundel(owner), hollow: true } : roundel(r)) });
      used += label.length;
    }
  }
  // detached 的 pill 是唯一沒有 identity 的 head（本機分支的 identity 就是自己的名字）
  const spoken = ordered.map((r) =>
    r.kind === "tag"
      ? `tag ${r.name}`
      : r.kind !== "head"
        ? r.name
        : r.identity === null
          ? "HEAD (detached)"
          : `${r.name} (HEAD)`,
  );
  return { shown, folded, spoken };
}
