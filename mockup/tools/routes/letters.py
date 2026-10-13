#!/usr/bin/env python3
"""字母唯一範圍比較（草稿 §5 的表）：A 全視窗唯一 / B 只在區間重疊的線之間唯一 / C 混合（採用 = proto.py 的字母）。
三種都用 proto.py 排好的順序（有 ref 且有線的 identity ＋ HEAD 的 identity，依優先序、起點、認領順序）。"""
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from proto import analyze, letter_candidates, load  # noqa: E402


def assign(order, hull, mode):
    got, used = {}, set()
    for ident in order:
        cands = letter_candidates(ident)
        pick = None if mode == "overlap" else next((ch for ch in cands if ch not in used), None)
        if pick:
            used.add(pick)
        elif mode != "global" and ident in hull:
            s, e = hull[ident]
            busy = {ch for o, ch in got.items() if ch and o in hull and hull[o][0] <= e and s <= hull[o][1]}
            pick = next((ch for ch in cands if ch not in busy), None)
        got[ident] = pick
    return got


def stats(got):
    reuse = defaultdict(list)
    for ident, ch in got.items():
        if ch:
            reuse[ch].append(ident)
    return (sum(1 for ch in got.values() if ch is None),
            sum(1 for ids in reuse.values() if len(ids) > 1),
            max((len(ids) for ids in reuse.values()), default=0))


for name in sys.argv[1:] or ("kira", "react", "v8fixture"):
    r = analyze(load(name))
    order, hull = r["lettered"], r["hull"]
    a, b, c = (assign(order, hull, m) for m in ("global", "overlap", "hybrid"))
    assert c == {i: r["letters"].get(i) for i in order}, f"{name}: hybrid here differs from proto.py's letters"
    print(f"{name}: lettered={len(order)}  [no-letter / letters reused / max ids per letter]  "
          f"A global {stats(a)} · B overlap {stats(b)} · C hybrid {stats(c)}")
