/**
 * 路線圖（v8）：把 GraphData 算成「每個 commit 屬於哪條線、線在哪一欄、線的字母與顏色、
 * 每條邊怎麼上色」。純函式，不碰 DOM、不讀 store。畫成 SVG 的幾何在 routeGeometry.ts，
 * 每站的 ref 標籤在 rowRefs.ts。
 *
 * git 不記錄 commit 是在哪個分支上做的，所以歸屬一定是推論。規則：
 *
 * 1. 歸屬：依序認領——主幹 → HEAD 的分支 → 其他 local 分支 → 只有 remote 的分支 →
 *    merge 訊息推得到名字的 parent → 其餘匿名。每次從 tip 沿 first parent 往下收，碰到
 *    已認領、出了視窗、或別的分支的 tip 就停；主幹不看最後一條，否則停在主幹上的舊分支
 *    會把主幹切斷。同名的 local / remote 是同一個 identity（remote 用後端依 refspec 算好的
 *    name_on_remote，或追蹤它的 local 名）；接得上就是同一條線，分岔時第二段是
 *    `<identity>::2`。identity 本身不會出現 `::`：分支名不能有 `:`，`tag:` / `anon:` 前綴只有一個；
 *    只用單一 `:` 的話，分支 `tag` 的第二段會和名為 `2` 的 tag 的匿名線 `tag:2` 撞名。
 * 2. 欄位：主幹固定第 0 欄。每條線佔用的範圍以「半列」計——從 merge 斜進來、或斜出去接
 *    分岔點的那一段只佔該列的上半或下半，所以前後兩條線可以在同一站交接、共用一欄——
 *    依起點排序，各取最小的空欄。
 * 3. 字母：取分支名最後一段的詞首、再取其他字母、最後 A–Z 補位（只認 ASCII 字母）；先全
 *    視窗唯一，26 個用完後只和範圍重疊的線不同。HEAD 的分支一定有字母（站牌要用）。
 * 4. 顏色：主幹是墨；其他線的偏好色由名稱的 FNV-1a（UTF-8）決定，同名永遠同偏好；撞到鄰線
 *    （相鄰欄且範圍重疊，或分岔 / merge 相接）就依序讓位。HEAD 的線最先處理、永遠拿到偏好色，
 *    介面的強調色跟著它，refresh 不會跳色。
 * 5. 強調色：看 HEAD 的分支，不看 HEAD 那一站落在哪條線——剛開、還沒 commit 的分支用自己
 *    的偏好色。
 *
 * 平手一律有明確順序（見各段註解），同樣的輸入一定得到同樣的輸出。
 */
import type { BranchRef, CommitNode, GraphData } from "./tauri";

/** 單一 commit 最多處理幾個 parent：parent 數由 repo 內容決定（`git commit-tree` 對 -p 沒有上限），
 *  不設限的話惡意 repo 一個 commit 就能卡住主執行緒。 */
const MAX_PARENTS_PER_COMMIT = 64;

/** 視窗外 merge parent 的軌道線最多幾條，超過的共用一條溢出線。這種線各佔一欄到底、條數由 repo
 *  決定：每個 commit 都 merge 同一批視窗外 commit 的 repo，1000 筆就有 6.3 萬條，欄位分配變平方級。
 *  真實 repo 遠低於此（react 最新 1000 筆只有 1 條）。 */
const MAX_BEYOND_LINES = 256;

/** 依序即 hash 索引與讓位循環的順序 */
const PIGMENTS = ["rokusho", "gunjo", "shinsha", "murasaki", "odo"] as const;

export type LineColor = "trunk" | (typeof PIGMENTS)[number];
export type LineKind = "trunk" | "branch" | "inferred" | "anonymous";

export interface Line {
  /** = identity；同一 identity 的第二段起為 `${identity}::2` */
  id: string;
  identity: string;
  kind: LineKind;
  /** full oid，上→下；第 2+ parent 在視窗外時為空（只有軌道） */
  stations: string[];
  slot: number;
  color: LineColor;
  /** tip 在視窗內的分支、以及 HEAD 的分支才有 */
  letter: string | null;
}

export interface Track {
  child: string;
  parent: string;
  parentIndex: number;
  /** run：同一條線；fork：分支的第一站接回分岔點；merge：第 2+ parent；beyond：parent 在視窗外 */
  kind: "run" | "fork" | "merge" | "beyond";
  /** 上色依據（Line.id） */
  line: string;
}

export interface Station {
  oid: string;
  row: number;
  line: string;
  /** interchange：碰到兩個以上 identity；terminus：視窗內沒有子 commit */
  role: "station" | "interchange" | "terminus";
  isHead: boolean;
}

export interface RefPlacement {
  name: string;
  kind: "local" | "remote" | "tag";
  /** 指向的 commit（full oid；tag 已 peel） */
  target: string;
  /** tag 為 null */
  identity: string | null;
  /** 這個 ref 自己的線。null：tip 停在別條線上（寄宿）、在視窗外、或是 tag */
  line: string | null;
}

export interface RouteMap {
  lines: Line[];
  stations: Station[];
  tracks: Track[];
  refs: RefPlacement[];
  head: { oid: string | null; line: string | null; identity: string | null; letter: string | null };
  accent: LineColor;
  slotCount: number;
}

/** 認領優先序；也是欄位 / 字母 / 顏色的同級排序依據 */
const TIER = { trunk: 0, head: 1, local: 2, remote: 3, inferred: 4, beyond: 5, anonymous: 6 } as const;
type Tier = keyof typeof TIER;

interface Seg {
  id: string;
  identity: string;
  tier: Tier;
  stations: string[];
  /** 以本線頂站為第 2+ parent 的 merge commit 所在列 */
  mergeRows: number[];
  /** 底站的 first parent 所在列（在別條線上）；根 commit 或在視窗外為 null */
  forkRow: number | null;
  /** 佔用範圍（半列：列 r 在 2r），閉區間 */
  start: number;
  end: number;
  slot: number;
  /** 認領順序 */
  order: number;
}

// ---- merge 訊息 ----

const PR_MERGE = /^Merge pull request #\d+ from [^/\s]+\/(\S+)/;
const OCTOPUS_MERGE = /^Merge branches ((?:'[^']+'(?:, | and )?)+)/;
const GIT_MERGE =
  /^Merge (?:(remote-tracking )?branch )?'?([^'\s]+)'?(?: of \S+)?(?: into '?([^'\s]+)'?)?\s*$/;
const HEX_OID = /^[0-9a-f]{7,40}$/;
/** 訊息是 repo 內容、不可信：含 ref 名禁用字元的一律當作沒有名字（也保住 identity 不含 `:`，線的 id 才不會撞） */
// eslint-disable-next-line no-control-regex
const ILLEGAL_REF_NAME = /[\s:~^?*[\\\x00-\x1f\x7f]|\.\./;

const branchName = (name: string | undefined): string | null =>
  name && !ILLEGAL_REF_NAME.test(name) ? name : null;

interface MergeNames {
  /** 第 2..n 個 parent 依序的分支名 */
  parents: (string | null)[];
  /** merge commit 本身所在的分支（`… into y`） */
  into: string | null;
}

function parseMerge(subject: string, stripRemote: (name: string) => string): MergeNames {
  const octopus = OCTOPUS_MERGE.exec(subject);
  if (octopus) {
    return { parents: [...octopus[1].matchAll(/'([^']+)'/g)].map((m) => branchName(m[1])), into: null };
  }
  const pr = PR_MERGE.exec(subject);
  if (pr) return { parents: [branchName(pr[1])], into: null };
  const git = GIT_MERGE.exec(subject);
  if (git) {
    // Sapling 的 `Merge <hex> into y` 沒有分支名
    const second = HEX_OID.test(git[2]) ? null : git[1] ? stripRemote(git[2]) : git[2];
    return { parents: [branchName(second ?? undefined)], into: branchName(git[3]) };
  }
  return { parents: [], into: null };
}

// ---- 字母與顏色 ----

const WORD_BREAK = /[-_.\s]+|(?<=\D)(?=\d)|(?<=\d)(?=\D)/;
const ASCII_LETTER = /^[A-Za-z]$/;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** 分支名最後一段的詞首 → 其他字母 → A–Z。先確認是 ASCII 字母再轉大寫——`ß` 轉大寫會變
 *  `SS`、土耳其文的 `ı` 會變成 `I`。 */
export function letterCandidates(identity: string): string[] {
  const last = identity.slice(identity.lastIndexOf("/") + 1);
  const out: string[] = [];
  const add = (ch: string | undefined) => {
    if (!ch || !ASCII_LETTER.test(ch)) return;
    const upper = ch.toUpperCase();
    if (!out.includes(upper)) out.push(upper);
  };
  for (const word of last.split(WORD_BREAK)) add(word[0]);
  for (const ch of last) add(ch);
  for (const ch of ALPHABET) add(ch);
  return out;
}

const utf8 = new TextEncoder();

/** FNV-1a 32-bit，對 UTF-8 bytes 算（用 UTF-16 code unit 算，非 ASCII 名稱會得到不同的值） */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of utf8.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function preferredColor(identity: string): LineColor {
  return PIGMENTS[fnv1a(identity) % PIGMENTS.length];
}

export const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function computeRoutes(graph: GraphData): RouteMap {
  const { commits } = graph;
  const n = commits.length;
  const rowOf = new Map<string, number>();
  const byOid = new Map<string, CommitNode>();
  commits.forEach((c, row) => {
    rowOf.set(c.full_oid, row);
    byOid.set(c.full_oid, c);
  });
  const parentsOf = (c: CommitNode) => c.parents.slice(0, MAX_PARENTS_PER_COMMIT);
  const subjectOf = (c: CommitNode) => c.message.split("\n", 1)[0];

  // ---- identity ----
  // 好幾條 local 追蹤同一條 remote 時，remote 歸名稱字母序最前面的 local
  const upstreamOwner = new Map<string, string>();
  for (const b of graph.branches.filter((b) => !b.is_remote).sort((x, y) => byName(x.name, y.name))) {
    if (b.upstream && !upstreamOwner.has(b.upstream)) upstreamOwner.set(b.upstream, b.name);
  }
  const identityOf = (b: BranchRef): string =>
    b.is_remote ? (upstreamOwner.get(b.name) ?? b.name_on_remote ?? b.name) : b.name;

  // merge 訊息裡的 remote-tracking 名（`origin/x`）：用 branches 推得的前綴去掉，長的先比
  const remotePrefixes = new Set<string>();
  for (const b of graph.branches) {
    if (b.is_remote && b.name_on_remote && b.name.endsWith(`/${b.name_on_remote}`)) {
      remotePrefixes.add(b.name.slice(0, b.name.length - b.name_on_remote.length));
    }
  }
  const prefixes = [...remotePrefixes].sort((a, b) => b.length - a.length || byName(a, b));
  const stripRemote = (name: string) => {
    const prefix = prefixes.find((p) => name.startsWith(p) && name.length > p.length);
    return prefix ? name.slice(prefix.length) : name;
  };

  interface Tip {
    row: number;
    oid: string;
    local: boolean;
  }
  const refIdentities = new Set<string>();
  const tipsOf = new Map<string, Tip[]>();
  const tipOwners = new Map<string, Set<string>>();
  for (const b of graph.branches) {
    const identity = identityOf(b);
    refIdentities.add(identity);
    const row = rowOf.get(b.target);
    if (row === undefined) continue;
    pushTo(tipsOf, identity, { row, oid: b.target, local: !b.is_remote });
    tipOwners.set(b.target, (tipOwners.get(b.target) ?? new Set()).add(identity));
  }

  // 主幹：依序取第一個有 ref 的 identity（tip 不必在視窗內；不在時主幹沒有線，第 0 欄不保留）。
  // unborn 的 HEAD 分支（還沒有 commit，所以也還沒有 ref）當作有：第一筆 commit 之後它就有 ref、照樣
  // 落在同一個候選位置，強調色才不會在第一筆 commit 前後換掉
  const unbornHead = graph.head.oid === null ? graph.head.branch : null;
  const trunk =
    [graph.default_branch, "main", "master", graph.head.branch].find(
      (id): id is string => id != null && (refIdentities.has(id) || id === unbornHead),
    ) ?? null;

  // ---- 認領 ----
  const segs: Seg[] = [];
  const lineOf = new Map<string, Seg>();
  const segCount = new Map<string, number>();

  const newSeg = (identity: string, tier: Tier): Seg => {
    const count = (segCount.get(identity) ?? 0) + 1;
    segCount.set(identity, count);
    const seg: Seg = {
      id: count === 1 ? identity : `${identity}::${count}`,
      identity,
      tier,
      stations: [],
      mergeRows: [],
      forkRow: null,
      start: 0,
      end: 0,
      slot: 0,
      order: segs.length,
    };
    segs.push(seg);
    return seg;
  };

  const claim = (identity: string, tier: Tier, start: string, stopAtOtherTips: boolean) => {
    if (!rowOf.has(start) || lineOf.has(start)) return;
    const seg = newSeg(identity, tier);
    let oid: string | undefined = start;
    while (oid !== undefined && rowOf.has(oid) && !lineOf.has(oid)) {
      const owners = tipOwners.get(oid);
      if (stopAtOtherTips && oid !== start && owners && [...owners].some((o) => o !== identity)) break;
      lineOf.set(oid, seg);
      seg.stations.push(oid);
      oid = byOid.get(oid)?.parents[0];
    }
  };

  const tipsByRow = (identity: string) => [...(tipsOf.get(identity) ?? [])].sort((a, b) => a.row - b.row);

  // 1. 主幹不看別人的 tip。主幹第一段佔第 0 欄；local / remote 分岔出的第二段照一般線排
  if (trunk) {
    for (const tip of tipsByRow(trunk)) {
      const tier: Tier = segCount.has(trunk) ? (tip.local ? "local" : "remote") : "trunk";
      claim(trunk, tier, tip.oid, false);
    }
  }
  // 2. HEAD 的分支
  const headBranch = graph.head.branch;
  if (headBranch && headBranch !== trunk) {
    for (const tip of tipsByRow(headBranch)) claim(headBranch, "head", tip.oid, true);
  }
  // 3. 其他 local、4. 只有 remote：依 tip 所在最上面的列，再同依名稱字母序
  const rest = [...tipsOf.keys()]
    .filter((id) => id !== trunk && id !== headBranch)
    .map((id) => {
      const tips = tipsByRow(id);
      return { id, top: tips[0].row, local: tips.some((t) => t.local) };
    })
    .sort((a, b) => a.top - b.top || byName(a.id, b.id));
  for (const tier of ["local", "remote"] as const) {
    for (const r of rest.filter((r) => r.local === (tier === "local"))) {
      for (const tip of tipsByRow(r.id)) claim(r.id, tier, tip.oid, true);
    }
  }
  // 5. merge 訊息推論（依 merge commit 由上而下，同一 merge 依 parent 順序）；
  //    parent 在視窗外的先記下，最後建成沒有站的軌道線
  const beyond: { child: string; parentIndex: number; row: number; identity: string }[] = [];
  commits.forEach((c, row) => {
    const parents = parentsOf(c);
    if (parents.length < 2) return;
    const names = parseMerge(subjectOf(c), stripRemote).parents;
    for (let k = 1; k < parents.length; k++) {
      const name = names[k - 1] ?? null;
      if (!rowOf.has(parents[k])) {
        beyond.push({ child: c.full_oid, parentIndex: k, row, identity: name ?? `anon:${parents[k].slice(0, 7)}` });
      } else if (name) {
        claim(name, "inferred", parents[k], true);
      }
    }
  });
  // 6. 匿名：merge commit 用 `into y` 命名；有 tag 用字母序最小的 tag；否則 anon:<短 oid>
  const tagsAt = new Map<string, string[]>();
  for (const t of graph.tags) pushTo(tagsAt, t.target, t.name);
  for (const c of commits) {
    if (lineOf.has(c.full_oid)) continue;
    const into = parentsOf(c).length > 1 ? parseMerge(subjectOf(c), stripRemote).into : null;
    const tag = [...(tagsAt.get(c.full_oid) ?? [])].sort(byName)[0];
    const identity = into ?? (tag ? `tag:${tag}` : `anon:${c.full_oid.slice(0, 7)}`);
    claim(identity, into ? "inferred" : "anonymous", c.full_oid, true);
  }
  const beyondSeg = new Map<string, Seg>();
  let overflow: Seg | null = null;
  beyond.forEach((b, i) => {
    // 超過上限的共用溢出線：每條邊照樣有軌道，欄數有上界。beyond 依列由上而下，第一條就是最上面的
    const own = i < MAX_BEYOND_LINES;
    const seg = own ? newSeg(b.identity, "beyond") : (overflow ??= newSeg("anon:overflow", "beyond"));
    if (own || seg.mergeRows.length === 0) seg.start = 2 * b.row + 1;
    seg.mergeRows.push(b.row);
    seg.end = 2 * n;
    beyondSeg.set(`${b.child}\n${b.parentIndex}`, seg);
  });

  // detached HEAD 落在匿名線上：identity 固定為 head:detached，否則每 commit 一次 tip 換人、顏色就換
  const headSeg = graph.head.oid ? (lineOf.get(graph.head.oid) ?? null) : null;
  if (!headBranch && headSeg && headSeg.tier === "anonymous") {
    headSeg.identity = "head:detached";
    headSeg.id = "head:detached";
  }
  const headIdentity = headBranch ?? headSeg?.identity ?? null;

  // ---- 佔用範圍 ----
  commits.forEach((c, row) => {
    for (const p of parentsOf(c).slice(1)) {
      const seg = lineOf.get(p);
      if (seg && seg.stations[0] === p) seg.mergeRows.push(row);
    }
  });
  for (const seg of segs) {
    if (seg.stations.length === 0) continue; // 軌道線建立時已給
    const top = rowOf.get(seg.stations[0]) ?? 0;
    const bottom = seg.stations[seg.stations.length - 1];
    const forkParent = byOid.get(bottom)?.parents[0];
    const forkRow = forkParent === undefined ? undefined : rowOf.get(forkParent);
    seg.forkRow = forkRow ?? null;
    // 斜出去接分岔點：只佔到該列的上半；parent 在視窗外：延伸到底；根 commit：停在自己這站
    seg.end =
      forkRow !== undefined ? 2 * forkRow - 1 : forkParent !== undefined ? 2 * n : 2 * (rowOf.get(bottom) ?? 0);
    // 從 merge 斜進來：從該列的下半開始
    seg.start = seg.mergeRows.length > 0 ? 2 * seg.mergeRows.reduce((a, b) => Math.min(a, b)) + 1 : 2 * top;
  }

  // ---- 欄位：依起點，再依優先序，再依認領順序；各取最小的空欄 ----
  const trunkSeg = segs.find((s) => s.tier === "trunk") ?? null;
  const firstFree = trunkSeg ? 1 : 0;
  if (trunkSeg) trunkSeg.slot = 0;
  const slotEnd: number[] = [];
  for (const seg of segs
    .filter((s) => s !== trunkSeg)
    .sort((a, b) => a.start - b.start || TIER[a.tier] - TIER[b.tier] || a.order - b.order)) {
    let i = 0;
    while (i < slotEnd.length && slotEnd[i] >= seg.start) i++;
    slotEnd[i] = seg.end;
    seg.slot = i + firstFree;
  }

  // ---- 鄰線：相鄰欄且範圍重疊，或分岔 / merge 相接 ----
  const neighbours = new Map<Seg, Set<Seg>>(segs.map((s) => [s, new Set<Seg>()]));
  const link = (a: Seg | undefined, b: Seg | undefined) => {
    if (!a || !b || a === b) return;
    neighbours.get(a)?.add(b);
    neighbours.get(b)?.add(a);
  };
  const bySlot = new Map<number, Seg[]>();
  for (const seg of segs) pushTo(bySlot, seg.slot, seg);
  for (const list of bySlot.values()) list.sort((a, b) => a.start - b.start);
  for (const [slot, list] of bySlot) {
    const next = bySlot.get(slot + 1);
    if (!next) continue;
    // 同一欄的線互不重疊，依起點排好後終點也遞增 → 二分找第一個還沒結束的
    for (const a of list) {
      let lo = 0;
      let hi = next.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (next[mid].end < a.start) lo = mid + 1;
        else hi = mid;
      }
      for (let j = lo; j < next.length && next[j].start <= a.end; j++) link(a, next[j]);
    }
  }
  for (const seg of segs) {
    if (seg.forkRow !== null) link(seg, lineOf.get(commits[seg.forkRow].full_oid));
    for (const row of seg.mergeRows) link(seg, lineOf.get(commits[row].full_oid));
  }

  // ---- identity 層級的排序資料 ----
  const segsOf = new Map<string, Seg[]>();
  for (const seg of segs) pushTo(segsOf, seg.identity, seg);
  const minTier = (id: string) => Math.min(...(segsOf.get(id) ?? []).map((s) => TIER[s.tier]));
  const firstOrder = (id: string) => segsOf.get(id)?.[0].order ?? -1;
  const hull = (id: string): [number, number] => {
    const list = segsOf.get(id) ?? [];
    return [Math.min(...list.map((s) => s.start)), Math.max(...list.map((s) => s.end))];
  };

  // ---- 顏色：主幹 → HEAD → 其餘依優先序；同級舊的先（範圍延伸得越下面越舊），再依認領順序 ----
  const colorTier = (id: string) => (id === headIdentity ? TIER.head : minTier(id));
  const colorOf = new Map<string, LineColor>();
  if (trunk) colorOf.set(trunk, "trunk");
  const colorOrder = [...segsOf.keys()]
    .filter((id) => id !== trunk)
    .sort((a, b) => colorTier(a) - colorTier(b) || hull(b)[1] - hull(a)[1] || firstOrder(a) - firstOrder(b));
  for (const id of colorOrder) {
    const used = new Set<LineColor>();
    for (const seg of segsOf.get(id) ?? []) {
      for (const nb of neighbours.get(seg) ?? []) {
        const color = nb.identity === id ? undefined : colorOf.get(nb.identity);
        if (color) used.add(color);
      }
    }
    const preferred = fnv1a(id) % PIGMENTS.length;
    let pick: LineColor = PIGMENTS[preferred];
    for (let k = 0; k < PIGMENTS.length; k++) {
      const candidate = PIGMENTS[(preferred + k) % PIGMENTS.length];
      if (!used.has(candidate)) {
        pick = candidate;
        break;
      }
    }
    colorOf.set(id, pick);
  }

  // ---- 字母：tip 在視窗內且有線的 identity，加上 HEAD 的 identity ----
  const lettered = [...segsOf.keys()].filter((id) => tipsOf.has(id));
  if (headIdentity && !lettered.includes(headIdentity)) lettered.push(headIdentity);
  const letterTier = (id: string) => (id === trunk ? TIER.trunk : id === headIdentity ? TIER.head : minTier(id));
  const startOf = (id: string) => (segsOf.has(id) ? hull(id)[0] : -1);
  lettered.sort((a, b) => letterTier(a) - letterTier(b) || startOf(a) - startOf(b) || firstOrder(a) - firstOrder(b));
  const letterOf = new Map<string, string>();
  const usedLetters = new Set<string>();
  for (const id of lettered) {
    const candidates = letterCandidates(id);
    let pick = candidates.find((ch) => !usedLetters.has(ch));
    if (pick) {
      usedLetters.add(pick);
    } else {
      // 26 個用完：只和範圍重疊的線不同
      const [start, end] = hull(id);
      const busy = new Set<string>();
      for (const [other, letter] of letterOf) {
        if (!segsOf.has(other)) continue;
        const [s, e] = hull(other);
        if (s <= end && start <= e) busy.add(letter);
      }
      pick = candidates.find((ch) => !busy.has(ch));
    }
    if (pick) letterOf.set(id, pick);
  }

  // ---- 邊、站、ref ----
  const tracks: Track[] = [];
  for (const c of commits) {
    const own = lineOf.get(c.full_oid);
    if (!own) continue;
    parentsOf(c).forEach((p, k) => {
      const parentSeg = lineOf.get(p);
      if (!parentSeg) {
        const line = k === 0 ? own : beyondSeg.get(`${c.full_oid}\n${k}`);
        if (line) tracks.push({ child: c.full_oid, parent: p, parentIndex: k, kind: "beyond", line: line.id });
      } else if (k === 0) {
        tracks.push({
          child: c.full_oid,
          parent: p,
          parentIndex: 0,
          kind: parentSeg === own ? "run" : "fork",
          line: own.id,
        });
      } else {
        tracks.push({ child: c.full_oid, parent: p, parentIndex: k, kind: "merge", line: parentSeg.id });
      }
    });
  }

  const segById = new Map(segs.map((s) => [s.id, s]));
  const touching = new Map<string, Set<string>>();
  const hasChild = new Set<string>();
  for (const c of commits) touching.set(c.full_oid, new Set([lineOf.get(c.full_oid)?.identity ?? ""]));
  for (const t of tracks) {
    const identity = segById.get(t.line)?.identity ?? "";
    touching.get(t.child)?.add(identity);
    if (t.kind !== "beyond") {
      touching.get(t.parent)?.add(identity);
      hasChild.add(t.parent);
    }
  }
  const stations: Station[] = commits.map((c, row) => ({
    oid: c.full_oid,
    row,
    line: lineOf.get(c.full_oid)?.id ?? "",
    role: (touching.get(c.full_oid)?.size ?? 0) > 1 ? "interchange" : hasChild.has(c.full_oid) ? "station" : "terminus",
    isHead: c.full_oid === graph.head.oid,
  }));

  const refs: RefPlacement[] = [
    ...graph.branches.map((b): RefPlacement => {
      const identity = identityOf(b);
      const seg = lineOf.get(b.target);
      return {
        name: b.name,
        kind: b.is_remote ? "remote" : "local",
        target: b.target,
        identity,
        line: seg && seg.identity === identity ? seg.id : null,
      };
    }),
    ...graph.tags.map((t): RefPlacement => ({ name: t.name, kind: "tag", target: t.target, identity: null, line: null })),
  ];

  const kindOf = (seg: Seg): LineKind => {
    if (seg === trunkSeg) return "trunk";
    if (seg.tier === "inferred") return "inferred";
    if (seg.tier === "beyond") return seg.identity.startsWith("anon:") ? "anonymous" : "inferred";
    if (seg.tier === "anonymous") return "anonymous";
    return "branch";
  };

  // 強調色：HEAD 的 identity 是主幹或沒有 → 主幹；有自己的線 → 線色；沒有線 → 偏好色
  const accent: LineColor =
    !headIdentity || headIdentity === trunk ? "trunk" : (colorOf.get(headIdentity) ?? preferredColor(headIdentity));

  return {
    lines: segs.map((s) => ({
      id: s.id,
      identity: s.identity,
      kind: kindOf(s),
      stations: s.stations,
      slot: s.slot,
      color: colorOf.get(s.identity) ?? preferredColor(s.identity),
      letter: letterOf.get(s.identity) ?? null,
    })),
    stations,
    tracks,
    refs,
    head: {
      oid: graph.head.oid,
      line: headSeg?.id ?? null,
      identity: headIdentity,
      letter: headIdentity ? (letterOf.get(headIdentity) ?? null) : null,
    },
    accent,
    slotCount: segs.length > 0 ? Math.max(...segs.map((s) => s.slot)) + 1 : 0,
  };
}
