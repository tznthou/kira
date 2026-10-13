#!/usr/bin/env python3
"""顏色穩定性分布：G（hash 優先 + 鄰線讓位）在「少一條分支」「分支少最新一筆」時，其他線換色幾條。"""
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from proto import analyze, load, variant  # noqa: E402


def changed(a, b, skip):
    ca, cb = a["colors"]["G"][0], b["colors"]["G"][0]
    common = (set(ca) & set(cb)) - skip
    return sum(1 for i in common if ca[i] != cb[i]), len(common)


def without_branch(g, L):
    """這條線的 commit 與指向它們的 ref 都拿掉"""
    gone = set(L["oids"])
    return variant(g, commits=[c for c in g["commits"] if c["full_oid"] not in gone],
                   branches=[b for b in g["branches"] if b["target"] not in gone])


def one_behind(g, L):
    """這條分支少最新一筆：指向 tip 的 ref（與 HEAD）退回 parent"""
    tip, parent = L["oids"][0], L["oids"][1]
    head = {**g["head"], "oid": parent} if g["head"]["oid"] == tip else g["head"]
    return variant(g, commits=[c for c in g["commits"] if c["full_oid"] != tip],
                   branches=[{**b, "target": parent} if b["target"] == tip else b for b in g["branches"]], head=head)


def candidates(r):
    """最新的 10 條 local / remote 線（不是從 merge 斜進來的）"""
    return sorted((L for L in r["segs"] if L["tier"] in ("local", "remote") and L["oids"] and not L["merge_in"]),
                  key=lambda L: r["row"][L["oids"][0]])[:10]


def show(xs):
    return f"n={len(xs)} min={min(xs)} median={statistics.median(xs)} max={max(xs)}" if xs else "n=0"


if __name__ == "__main__":
    for name in sys.argv[1:] or ("react", "kira"):
        g = load(name)
        base = analyze(g)
        gone_runs, tip_runs = [], []
        for L in candidates(base):
            gone_runs.append(changed(analyze(without_branch(g, L)), base, {L["ident"]})[0])
            if len(L["oids"]) > 1:
                tip_runs.append(changed(analyze(one_behind(g, L)), base, set())[0])
        print(f"{name} ({len(base['colors']['G'][0])} identities) — remove one branch: {show(gone_runs)} · "
              f"branch one commit behind: {show(tip_runs)}")
