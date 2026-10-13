#!/usr/bin/env python3
"""Phase 2 路線語彙規則原型：與 src/lib/routeMap.ts 各自實作同一份規則，拿真 repo 交叉驗證。

輸入：真後端 dump（fidelity_dump）裡的 graph，也就是 computeRoutes 吃的同一份 GraphData，不另外讀 repo；先跑 dump.sh。
規則：草稿 kira/.claude/pi-plans/v8-phase2-route-rules.md §3–§6（定稿；本檔與草稿不一致時以草稿為準）。
      正規式的空白類別、字串排序照 JS 的語意寫死（JS 空白類別、UTF-16 比較），兩邊才可能逐 commit 相同。
用法：python3 proto.py [repo…]          摘要（草稿 §3–§6 的數字）＋穩定性實驗
      python3 proto.py --json <repo|->   逐 commit / 逐線的指派，印到 stdout（compare_ts.mjs 用；`-` = 從 stdin 讀 GraphData）
      letters.py / stability.py / review_checks.py（草稿佐證）
merge 訊息格式只收四個 repo 裡實際出現或 git 預設的格式（Bitbucket「Merged in」已依審查拿掉）
"""
import json
import re
import sys
from pathlib import Path

DIR = Path(__file__).resolve().parents[2] / "fidelity-out" / "route-dumps"
NAMES = ("kira", "work", "react", "v8fixture")
PIGMENTS = ["rokusho", "gunjo", "shinsha", "murasaki", "odo"]
MAX_PARENTS = 64
MAX_BEYOND = 256  # 視窗外 merge parent 的軌道線上限，超過的共用一條溢出線（同 routeMap.ts 的 MAX_BEYOND_LINES）
TIER = {"trunk": 0, "head": 1, "local": 2, "remote": 3, "inferred": 4, "beyond": 5, "anonymous": 6}
SEG = "::"  # 同一 identity 第二段起的 id：f"{identity}{SEG}{n}"；單一 `:` 會讓分支 `tag` 的第二段撞上 tag `2` 的匿名線

# JS 正規式的空白類別（不帶 u 旗標也含 Unicode 空白）。Python 的 \s 範圍不同（多 \x1c-\x1f、\x85，少 ﻿），照 JS 寫死
WS = r"\t\n\v\f\r    -     　﻿"
PR = re.compile(rf"Merge pull request #[0-9]+ from [^/{WS}]+/([^{WS}]+)")
OCTO = re.compile(r"Merge branches ((?:'[^']+'(?:, | and )?)+)")
GEN = re.compile(rf"Merge (?:(remote-tracking )?branch )?'?([^'{WS}]+)'?(?: of [^{WS}]+)?(?: into '?([^'{WS}]+)'?)?[{WS}]*\Z")
HEX = re.compile(r"[0-9a-f]{7,40}")
# 訊息是 repo 內容、不可信：含 ref 名禁用字元的一律當作沒有名字（也保住 `:` 只用在線的 id）
ILLEGAL = re.compile(rf"[{WS}:~^?*\[\\\x00-\x1f\x7f]|\.\.")
WORD_BREAK = re.compile(rf"[-_.{WS}]+|(?<=[^0-9])(?=[0-9])|(?<=[0-9])(?=[^0-9])")
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def load(name):
    return json.loads((DIR / f"dump-{name}.json").read_text())["graph"]


def variant(graph, **changes):
    """改掉 commits / branches / head 的 graph 淺拷貝（實驗用）"""
    return {**graph, **changes}


def name_key(s):
    """JS 的字串比較是逐 UTF-16 code unit"""
    return s.encode("utf-16-be", "surrogatepass")


def u16len(s):
    return len(name_key(s)) // 2


def fnv1a(s):
    h = 0x811C9DC5
    for b in s.encode():
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return h


def branch_name(name):
    return name if name and not ILLEGAL.search(name) else None


def parse_merge(subject, strip_remote):
    """→ (第 2..n 個 parent 的分支名 list，元素可為 None, merge commit 自身所在分支名 or None)"""
    m = OCTO.match(subject)
    if m:
        return [branch_name(x) for x in re.findall(r"'([^']+)'", m.group(1))], None
    m = PR.match(subject)
    if m:
        return [branch_name(m.group(1))], None
    m = GEN.match(subject)
    if m:
        # Sapling 的 `Merge <hex> into y` 沒有分支名；hex 判斷看去掉 remote 前綴之前的原字串
        second = None if HEX.fullmatch(m.group(2)) else (strip_remote(m.group(2)) if m.group(1) else m.group(2))
        return [branch_name(second)], branch_name(m.group(3))
    return [], None


def letter_candidates(ident):
    """分支名最後一段的詞首 → 其他字母 → A–Z；先確認是 ASCII 字母再轉大寫"""
    last = ident[ident.rfind("/") + 1:]
    out = []

    def add(ch):
        if ch and ("a" <= ch <= "z" or "A" <= ch <= "Z") and ch.upper() not in out:
            out.append(ch.upper())

    for w in WORD_BREAK.split(last):
        add(w[:1])
    for ch in last:
        add(ch)
    for ch in ALPHABET:
        add(ch)
    return out


def analyze(graph, neighbours="slot", head_first=True):
    """graph = GraphData。neighbours / head_first 只給 review_checks.py 的對照實驗（皆未採用）：
    neighbours="visual" = 每個半列上依 slot 相鄰；head_first=False = HEAD 與 local 同級、依年齡"""
    commits, branches = graph["commits"], graph["branches"]
    N = len(commits)
    row = {c["full_oid"]: i for i, c in enumerate(commits)}
    by_oid = {c["full_oid"]: c for c in commits}
    par = {c["full_oid"]: c["parents"][:MAX_PARENTS] for c in commits}
    subj = {c["full_oid"]: c["message"].split("\n", 1)[0] for c in commits}

    # ---- identity：remote 歸追蹤它、名稱字母序最前面的 local；否則用它在遠端上的名字；都沒有用完整名稱 ----
    owner = {}
    for b in sorted((b for b in branches if not b["is_remote"]), key=lambda b: name_key(b["name"])):
        if b["upstream"] and b["upstream"] not in owner:
            owner[b["upstream"]] = b["name"]

    def identity_of(b):
        if not b["is_remote"]:
            return b["name"]
        return next(x for x in (owner.get(b["name"]), b["name_on_remote"], b["name"]) if x is not None)

    # merge 訊息裡的 remote-tracking 名：用 branches 推得的前綴（name 去掉 name_on_remote）去掉，長的先比
    prefixes = set()
    for b in branches:
        on_remote = b["name_on_remote"]
        if b["is_remote"] and on_remote and b["name"].endswith("/" + on_remote):
            prefixes.add(b["name"][: len(b["name"]) - len(on_remote)])
    prefixes = sorted(prefixes, key=lambda p: (-u16len(p), name_key(p)))

    def strip_remote(name):
        p = next((p for p in prefixes if name.startswith(p) and len(name) > len(p)), None)
        return name[len(p):] if p is not None else name

    ref_identities, tips, tip_owners = set(), {}, {}  # tips: identity -> [(row, oid, local)]，branches 列舉順序
    for b in branches:
        ident = identity_of(b)
        ref_identities.add(ident)
        if b["target"] in row:
            tips.setdefault(ident, []).append((row[b["target"]], b["target"], not b["is_remote"]))
            tip_owners.setdefault(b["target"], set()).add(ident)

    def tips_by_row(ident):
        return sorted(tips.get(ident, []), key=lambda t: t[0])

    head_branch, head_oid = graph["head"]["branch"], graph["head"]["oid"]
    # 主幹：依序取第一個有 ref 的 identity（tip 不必在視窗內；不在時主幹沒有線，第 0 欄不保留）。
    # unborn 的 HEAD 分支（還沒有 commit、也還沒有 ref）當作有：第一筆 commit 前後主幹不變（Phase 4）
    unborn_head = head_branch if head_oid is None else None
    trunk = next((x for x in (graph["default_branch"], "main", "master", head_branch)
                  if x is not None and (x in ref_identities or x == unborn_head)), None)

    # ---- 認領 ----
    segs, claimed, seg_count = [], {}, {}

    def new_seg(ident, tier):
        seg_count[ident] = seg_count.get(ident, 0) + 1
        k = seg_count[ident]
        L = {"id": ident if k == 1 else f"{ident}{SEG}{k}", "ident": ident, "tier": tier, "oids": [], "merge_in": [],
             "fork_row": None, "start": 0, "end": 0, "slot": 0, "order": len(segs)}
        segs.append(L)
        return L

    def claim(ident, tier, start, stop_at_tips):
        if start not in row or start in claimed:
            return
        L = new_seg(ident, tier)
        oid = start
        while oid is not None and oid in row and oid not in claimed:
            if stop_at_tips and oid != start and any(o != ident for o in tip_owners.get(oid, ())):
                break
            claimed[oid] = L
            L["oids"].append(oid)
            ps = by_oid[oid]["parents"]
            oid = ps[0] if ps else None

    # 1. 主幹不看別人的 tip；第一段佔第 0 欄，local / remote 分岔出的第二段照一般線排
    if trunk is not None:
        for _, oid, local in tips_by_row(trunk):
            claim(trunk, ("local" if local else "remote") if trunk in seg_count else "trunk", oid, False)
    # 2. HEAD 的分支
    if head_branch and head_branch != trunk:
        for _, oid, _ in tips_by_row(head_branch):
            claim(head_branch, "head", oid, True)
    # 3. 其他 local、4. 只有 remote：依 tip 所在最上面的列，再同依名稱字母序
    rest = sorted(((tips_by_row(i)[0][0], i, any(t[2] for t in tips[i])) for i in tips if i not in (trunk, head_branch)),
                  key=lambda x: (x[0], name_key(x[1])))
    for want_local, tier in ((True, "local"), (False, "remote")):
        for _, ident, local in rest:
            if local == want_local:
                for _, oid, _ in tips_by_row(ident):
                    claim(ident, tier, oid, True)
    # 5. merge 訊息推論（merge commit 由上而下，同一 merge 依 parent 順序）；parent 在視窗外的最後建成軌道線
    beyond = []  # (merge oid, parent index, merge row, identity)
    for i, c in enumerate(commits):
        M = c["full_oid"]
        if len(par[M]) < 2:
            continue
        names = parse_merge(subj[M], strip_remote)[0]
        for k in range(1, len(par[M])):
            name, P = (names[k - 1] if k - 1 < len(names) else None), par[M][k]
            if P not in row:
                beyond.append((M, k, i, name if name is not None else f"anon:{P[:7]}"))
            elif name:
                claim(name, "inferred", P, True)
    # 6. 匿名：merge commit 用 `into y` 命名；有 tag 用字母序最小的 tag；否則 anon:<短 oid>
    tags_at = {}
    for t in graph["tags"]:
        tags_at.setdefault(t["target"], []).append(t["name"])
    for c in commits:
        o = c["full_oid"]
        if o in claimed:
            continue
        into = parse_merge(subj[o], strip_remote)[1] if len(par[o]) > 1 else None
        tag = min(tags_at[o], key=name_key) if o in tags_at else None
        ident = into if into is not None else (f"tag:{tag}" if tag is not None else f"anon:{o[:7]}")
        claim(ident, "inferred" if into else "anonymous", o, True)
    assert len(claimed) == N, "every commit must belong to exactly one line"
    beyond_seg = {}
    overflow = None
    for j, (M, k, i, ident) in enumerate(beyond):
        if j < MAX_BEYOND:
            L = new_seg(ident, "beyond")
            L["start"] = 2 * i + 1
        else:  # 共用溢出線；beyond 依列由上而下，第一條就是最上面的
            if overflow is None:
                overflow = new_seg("anon:overflow", "beyond")
                overflow["start"] = 2 * i + 1
            L = overflow
        L["merge_in"].append(i)
        L["end"] = 2 * N
        beyond_seg[(M, k)] = L

    # detached HEAD 落在匿名線上：identity 固定為 head:detached，否則每 commit 一次 tip 換人、顏色就換
    hs = claimed.get(head_oid) if head_oid else None
    if not head_branch and hs is not None and hs["tier"] == "anonymous":
        hs["ident"] = hs["id"] = "head:detached"
    head_identity = head_branch if head_branch is not None else (hs["ident"] if hs is not None else None)

    # ---- 佔用範圍（半列：列 r 在 2r）----
    for i, c in enumerate(commits):
        for P in par[c["full_oid"]][1:]:
            L = claimed.get(P)
            if L is not None and L["oids"][0] == P:
                L["merge_in"].append(i)
    for L in segs:
        if not L["oids"]:
            continue  # 軌道線建立時已給
        bottom = L["oids"][-1]
        fp = by_oid[bottom]["parents"][0] if by_oid[bottom]["parents"] else None
        L["fork_row"] = row.get(fp) if fp is not None else None
        # 斜出去接分岔點：只佔到該列的上半；parent 在視窗外：延伸到底；根 commit：停在自己這站
        L["end"] = 2 * L["fork_row"] - 1 if L["fork_row"] is not None else (2 * N if fp is not None else 2 * row[bottom])
        # 從 merge 斜進來：從該列的下半開始
        L["start"] = 2 * min(L["merge_in"]) + 1 if L["merge_in"] else 2 * row[L["oids"][0]]

    # ---- 欄位：依起點，再依優先序，再依認領順序；各取最小的空欄 ----
    trunk_seg = next((L for L in segs if L["tier"] == "trunk"), None)
    first_free = 1 if trunk_seg else 0
    slot_end = []
    for L in sorted((L for L in segs if L is not trunk_seg), key=lambda L: (L["start"], TIER[L["tier"]], L["order"])):
        s = 0
        while s < len(slot_end) and slot_end[s] >= L["start"]:
            s += 1
        if s == len(slot_end):
            slot_end.append(L["end"])
        else:
            slot_end[s] = L["end"]
        L["slot"] = s + first_free

    # ---- 鄰線：相鄰欄且範圍重疊，或分岔 / merge 相接 ----
    nb = {L["order"]: set() for L in segs}

    def link(a, b):
        if a is not None and b is not None and a is not b:
            nb[a["order"]].add(b["order"])
            nb[b["order"]].add(a["order"])

    if neighbours == "slot":
        for a in range(len(segs)):
            for b in range(a + 1, len(segs)):
                A, B = segs[a], segs[b]
                if abs(A["slot"] - B["slot"]) == 1 and A["start"] <= B["end"] and B["start"] <= A["end"]:
                    link(A, B)
    else:
        for y in range(0, max((L["end"] for L in segs), default=0) + 1):
            active = sorted((L["slot"], L["order"]) for L in segs if L["start"] <= y <= L["end"])
            for (s1, a), (s2, b) in zip(active, active[1:]):
                if s1 != s2:
                    link(segs[a], segs[b])
    for L in segs:
        if L["fork_row"] is not None:
            link(L, claimed[commits[L["fork_row"]]["full_oid"]])
        for m in L["merge_in"]:
            link(L, claimed[commits[m]["full_oid"]])

    # ---- identity 層級的排序資料 ----
    segs_of = {}
    for L in segs:
        segs_of.setdefault(L["ident"], []).append(L)
    hull = {i: (min(L["start"] for L in ls), max(L["end"] for L in ls)) for i, ls in segs_of.items()}

    def min_tier(i):
        return min(TIER[L["tier"]] for L in segs_of[i])

    def first_order(i):
        return segs_of[i][0]["order"] if i in segs_of else -1

    # ---- 顏色：主幹 → HEAD → 其餘依優先序；同級舊的先（範圍延伸得越下面越舊），再依認領順序 ----
    def color_tier(i):
        if not head_first:
            return min(TIER["local"] if L["tier"] == "head" else TIER[L["tier"]] for L in segs_of[i])
        return TIER["head"] if i == head_identity else min_tier(i)

    def colors(strategy):
        col = {} if trunk is None else {trunk: "trunk"}
        for i in sorted((i for i in segs_of if i != trunk), key=lambda i: (color_tier(i), -hull[i][1], first_order(i))):
            pref = fnv1a(i) % len(PIGMENTS)
            if strategy == "H":
                col[i] = PIGMENTS[pref]
                continue
            used = {col[segs[n]["ident"]] for L in segs_of[i] for n in nb[L["order"]]
                    if segs[n]["ident"] != i and segs[n]["ident"] in col}
            col[i] = next((PIGMENTS[(pref + k) % 5] for k in range(5) if PIGMENTS[(pref + k) % 5] not in used),
                          PIGMENTS[pref])
        clashes = sum(1 for L in segs for n in nb[L["order"]] if L["order"] < n and L["ident"] != segs[n]["ident"]
                      and col[L["ident"]] == col[segs[n]["ident"]] != "trunk")
        return col, clashes

    # ---- 字母：tip 在視窗內且有線的 identity，加上 HEAD 的 identity；先全視窗唯一，26 個用完後只和重疊的線不同 ----
    lettered = [i for i in segs_of if i in tips]
    if head_identity is not None and head_identity not in lettered:
        lettered.append(head_identity)

    def letter_tier(i):
        return TIER["trunk"] if i == trunk else TIER["head"] if i == head_identity else min_tier(i)

    lettered.sort(key=lambda i: (letter_tier(i), hull[i][0] if i in hull else -1, first_order(i)))
    letters, used = {}, set()
    for i in lettered:
        cands = letter_candidates(i)
        pick = next((ch for ch in cands if ch not in used), None)
        if pick:
            used.add(pick)
        else:
            s, e = hull[i]
            busy = {ch for o, ch in letters.items() if o in hull and hull[o][0] <= e and s <= hull[o][1]}
            pick = next((ch for ch in cands if ch not in busy), None)
        if pick:
            letters[i] = pick

    def kind_of(L):
        if L is trunk_seg:
            return "trunk"
        if L["tier"] == "beyond":
            return "anonymous" if L["ident"].startswith("anon:") else "inferred"
        return {"inferred": "inferred", "anonymous": "anonymous"}.get(L["tier"], "branch")

    for L in segs:
        L["kind"] = kind_of(L)
    col_g = colors("G")
    accent = "trunk" if head_identity is None or head_identity == trunk else \
        col_g[0].get(head_identity, PIGMENTS[fnv1a(head_identity) % len(PIGMENTS)])
    return {
        "N": N, "trunk": trunk, "head_branch": head_branch, "head_oid": head_oid, "head_identity": head_identity,
        "head_line": hs["id"] if hs is not None else None, "segs": segs, "lines": {L["id"]: L for L in segs},
        "claimed": claimed, "row": row, "commits": commits, "beyond_seg": beyond_seg,
        "tiers": {t: sum(1 for L in segs if L["tier"] == t) for t in TIER},
        "slot_count": max((L["slot"] for L in segs), default=-1) + 1,
        "ref_identities": list(tips), "riders": [i for i in tips if i not in segs_of],
        "lettered": lettered, "letters": letters, "no_letter": [i for i in lettered if i not in letters],
        "hull": hull, "colors": {"H": colors("H"), "G": col_g}, "accent": accent,
    }


def assignment(r):
    """逐 commit / 逐線的指派，欄位與 RouteMap 同名（compare_ts.mjs 比對用）"""
    col = r["colors"]["G"][0]
    return {
        "commits": [{"oid": c["full_oid"], "line": L["id"], "identity": L["ident"], "slot": L["slot"],
                     "letter": r["letters"].get(L["ident"]), "color": col[L["ident"]]}
                    for c in r["commits"] for L in (r["claimed"][c["full_oid"]],)],
        "lines": [{"id": L["id"], "identity": L["ident"], "kind": L["kind"], "slot": L["slot"], "color": col[L["ident"]],
                   "letter": r["letters"].get(L["ident"]), "stations": len(L["oids"])} for L in r["segs"]],
        "head": {"oid": r["head_oid"], "line": r["head_line"], "identity": r["head_identity"],
                 "letter": r["letters"].get(r["head_identity"]) if r["head_identity"] is not None else None},
        "accent": r["accent"],
        "slotCount": r["slot_count"],
    }


MOCKUP_LANES = {  # 基準手排（subject → lane），v8-kirazuri-lines-sys.html 的 commits
    "feat(t15g): scale lane gutter to container width before the subject column": 1,
    "fix(toolbar): give Refresh a fixed min-width so the toolbar stops shifting": 2,
    "refactor(graph): extract the lane-width budget into layout constants": 1,
    "test(graph): add a 17-lane density fixture from react history": 1,
    "docs: backfill README history for 05-21 and 07-30": 0,
    "Merge pull request #36 from tznthou/feat/t15f-motion": 0,
    "docs: correct outdated stack and animation claims after t15f": 1,
    "chore: apply review findings — 2 items": 1,
    "feat(t15f): add restrained motion for tab entry and list hover": 1,
    "Merge pull request #34 from tznthou/feat/t15e-graph-layout": 0,
    "chore: apply review findings — 10 items": 1,
    "feat(graph): surface commit history truncation to the UI": 1,
    "refactor(staging): use shared ErrorBanner for conflict notice": 1,
    "fix(diff): reserve space for macOS overlay scrollbar": 1,
    "fix(pr): refetch pull requests on toolbar refresh": 1,
    "feat(graph): right-align ref pills to the container edge": 1,
    "fix(graph): recycle lane indices after branch merge": 1,
    "docs: update README status table + CHANGELOG for T15 visual polish": 0,
    "Merge pull request #32 from tznthou/feat/t15d-theme-parity": 0,
    "feat(t15d): theme parity — graph-specific tokens for ink/paper balance": 1,
    "Merge pull request #31 from tznthou/feat/t15b-graph-craft": 0,
    "feat(t15b): graph craft — bullseye nodes, pill ref labels, layout fixes": 1,
    "Merge pull request #30 from tznthou/feat/t15c-state-design": 0,
}


def report(name):
    g = load(name)
    r = analyze(g)
    t = r["tiers"]
    print(f"\n=== {name}: {r['N']} commits · trunk={r['trunk']} · HEAD={r['head_branch'] or 'detached'}")
    print(f"  lines trunk/branch/inferred/beyond/anonymous: {t['trunk']} / {t['head'] + t['local'] + t['remote']} / "
          f"{t['inferred']} / {t['beyond']} / {t['anonymous']}  · slots: {r['slot_count']}")
    print(f"  ref identities in window: {len(r['ref_identities'])} (without own route: {len(r['riders'])}) · "
          f"lettered: {len(r['lettered'])} · without letter: {len(r['no_letter'])}")
    for s in ("H", "G"):
        print(f"  colours {s}: neighbour clashes = {r['colors'][s][1]}")
    print(f"  HEAD identity: {r['head_identity']} · line {r['head_line']} · letter {r['letters'].get(r['head_identity'])}"
          f" · accent {r['accent']}")

    if name == "v8fixture":
        bad = []
        for c in r["commits"]:
            want = MOCKUP_LANES.get(c["message"])
            if want is not None and r["claimed"][c["full_oid"]]["slot"] != want:
                bad.append((c["message"][:50], want, r["claimed"][c["full_oid"]]["slot"]))
        print(f"  mockup lane match: {len(MOCKUP_LANES) - len(bad)}/{len(MOCKUP_LANES)}" + (f"  MISMATCH {bad}" if bad else ""))
        shown = {r["claimed"][c["full_oid"]]["id"] for c in r["commits"] if c["message"] in MOCKUP_LANES}
        for lid in sorted(shown, key=lambda l: r["lines"][l]["start"]):
            L = r["lines"][lid]
            print(f"    {lid:32s} tier={L['tier']:9s} slot={L['slot']} letter={r['letters'].get(L['ident'])} "
                  f"H={r['colors']['H'][0][L['ident']]:8s} G={r['colors']['G'][0][L['ident']]}")

    # 穩定性：同一 repo 的兩個狀態，比較共有 identity 的顏色變動（H 依構造為 0）
    def changes(a, b):
        ca, cb = a["colors"]["G"][0], b["colors"]["G"][0]
        common = set(ca) & set(cb)
        return sum(1 for i in common if ca[i] != cb[i]), len(common)

    exps = []
    if r["N"] > 100:
        exps.append(("window bottom -50 rows", changes(analyze(variant(g, commits=g["commits"][: r["N"] - 50])), r)))
    first = g["commits"][0]
    if r["head_branch"] and r["head_oid"] == first["full_oid"] and len(first["parents"]) == 1:
        parent = first["parents"][0]
        moved = [{**b, "target": parent} if b["name"] == r["head_branch"] and not b["is_remote"] else b
                 for b in g["branches"]]
        v = variant(g, commits=g["commits"][1:], branches=moved, head={**g["head"], "oid": parent})
        exps.append(("before newest HEAD commit", changes(analyze(v), r)))
    branchy = [L for L in r["segs"] if L["tier"] in ("local", "remote") and not L["merge_in"] and L["oids"]]
    if branchy:
        newest = min(branchy, key=lambda L: r["row"][L["oids"][0]])
        gone = set(newest["oids"])
        v = variant(g, commits=[c for c in g["commits"] if c["full_oid"] not in gone],
                    branches=[b for b in g["branches"] if b["target"] not in gone])
        exps.append((f"before branch {newest['ident']} existed", changes(analyze(v), r)))
    for label, (n, common) in exps:
        print(f"  stability G — {label}: {n}/{common} identities changed colour")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--json"]:
        if len(args) != 2:
            sys.exit("usage: proto.py --json <repo | - (GraphData on stdin)>")
        graph = json.load(sys.stdin) if args[1] == "-" else load(args[1])
        json.dump(assignment(analyze(graph)), sys.stdout, ensure_ascii=False)
    else:
        for name in args or NAMES:
            report(name)
