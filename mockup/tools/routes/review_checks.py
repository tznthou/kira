#!/usr/bin/env python3
"""動工前計畫審視（v1）的佐證（2026-10-05），草稿引用的數字皆出自本腳本。

(1) D1 的 23 筆視窗（fixture.ts）vs 真 fixture repo 184 筆：字母 / 顏色 / slot 是否相同
(2) checkout → 其他線換色（G，HEAD 優先）
(3) 用「畫面上相鄰」重量撞色：G（slot±1 讓位）與 H
(4) 讓位改用畫面相鄰（neighbours="visual"）：撞色與穩定性 → 不採用的理由
(5) HEAD 優先 vs 依年齡：v8 fixture 上的顏色是否相同
"""
import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from proto import analyze, load, variant  # noqa: E402
from stability import candidates, one_behind, show, without_branch  # noqa: E402

D1_ROWS = 23  # src/dev/fidelity/fixture.ts 的 commit 數 = 基準畫面的列數


def summary(r):
    G = r["colors"]["G"][0]
    out = {}
    for L in r["segs"]:
        out.setdefault(L["ident"], (r["letters"].get(L["ident"]), G[L["ident"]], L["slot"]))
    return out


def recolor(a, b, skip):
    ca, cb = a["colors"]["G"][0], b["colors"]["G"][0]
    common = (set(ca) & set(cb)) - skip
    return [i for i in common if ca[i] != cb[i]], len(common)


def with_head(graph, name, target=None):
    """模擬 checkout name；沒有同名 local 分支時，模擬從 remote 分支 checkout 出一條"""
    g = copy.deepcopy(graph)
    local = next((b for b in g["branches"] if b["name"] == name and not b["is_remote"]), None)
    if local is None:
        local = {"name": name, "target": target, "is_remote": False, "upstream": f"origin/{name}", "name_on_remote": None}
        g["branches"].append(local)
    g["head"] = {"oid": local["target"], "branch": name}
    return g


def visual_pairs(r):
    pairs = set()
    for y in range(0, max(L["end"] for L in r["segs"]) + 1):
        active = sorted((L["slot"], L["id"]) for L in r["segs"] if L["start"] <= y <= L["end"])
        for (s1, a), (s2, b) in zip(active, active[1:]):
            if s1 != s2:
                pairs.add(tuple(sorted((a, b))))
    return pairs


def clashes(r, pairs, strategy):
    col = r["colors"][strategy][0]
    return sum(1 for a, b in pairs if r["lines"][a]["ident"] != r["lines"][b]["ident"]
               and col[r["lines"][a]["ident"]] == col[r["lines"][b]["ident"]] != "trunk")


def stability(g, base, **opts):
    gone, behind, checkout = [], [], []
    for L in candidates(base):
        gone.append(len(recolor(analyze(without_branch(g, L), **opts), base, {L["ident"]})[0]))
        if len(L["oids"]) > 1:
            behind.append(len(recolor(analyze(one_behind(g, L), **opts), base, set())[0]))
        if L["tier"] == "remote":
            r4 = analyze(with_head(g, L["ident"], L["oids"][0]), **opts)
            checkout.append(len(recolor(base, r4, {L["ident"], base["head_identity"]})[0]))
    return gone, behind, checkout


def main():
    fix = load("v8fixture")
    full = analyze(fix)
    win = analyze(variant(fix, commits=fix["commits"][:D1_ROWS]))

    sf, sw = summary(full), summary(win)
    same = sum(1 for i in sw if sf.get(i) == sw[i])
    print(f"(1) v8-fixture {D1_ROWS}-commit window vs {full['N']}: same (letter, colour, slot) {same}/{len(sw)}")
    for i in sw:
        if sf.get(i) != sw[i]:
            print(f"    DIFF {i}: {sf.get(i)} vs {sw[i]}")

    print("(2) checkout → other lines recoloured (G, HEAD first)")
    for name in ("main", "fix/toolbar-jump"):
        ch, n = recolor(full, analyze(with_head(fix, name)), {full["head_identity"], name})
        print(f"    v8-fixture → {name}: {len(ch)}/{n}")
    react = load("react")
    rb = analyze(react)
    cands = sorted((L for L in rb["segs"] if L["tier"] == "remote" and L["oids"]),
                   key=lambda L: rb["row"][L["oids"][0]])[:10]
    counts = []
    for L in cands:
        tgt = next(b["target"] for b in react["branches"] if b["is_remote"] and b["name"].endswith("/" + L["ident"]))
        counts.append(len(recolor(rb, analyze(with_head(react, L["ident"], tgt)), {"main", L["ident"]})[0]))
    print(f"    react main → each of the 10 newest remote branches: {counts} (of {len(rb['colors']['G'][0])} identities)")

    print("(3) clashes measured by visual adjacency (empty slots in between do not separate)")
    results = {"v8fixture": full, "react": rb}
    for name in ("kira", "react", "v8fixture"):
        r = results.get(name) or analyze(load(name))
        p = visual_pairs(r)
        print(f"    {name:9s} G {clashes(r, p, 'G')} · H {clashes(r, p, 'H')} (visual pairs {len(p)})")

    print("(4) G yielding to visual neighbours instead (not adopted)")
    for name in ("kira", "react"):
        g = load(name)
        rv = analyze(g, neighbours="visual")
        gone, behind, checkout = stability(g, rv, neighbours="visual")
        print(f"    {name:6s} clashes {rv['colors']['G'][1]} · remove a branch {show(gone)} · "
              f"one behind {show(behind)} · checkout {show(checkout)}")

    print("(5) HEAD first vs age-only on v8-fixture")
    for rows in (full["N"], D1_ROWS):
        v = variant(fix, commits=fix["commits"][:rows])
        same_colours = analyze(v)["colors"]["G"][0] == analyze(v, head_first=False)["colors"]["G"][0]
        print(f"    window {rows:3d}: identical colours = {same_colours}")


if __name__ == "__main__":
    main()
