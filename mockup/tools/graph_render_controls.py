#!/usr/bin/env python3
"""graph 的 render 層對照組（Phase 4 計畫 4b step 7）：幾何的黃金資料蓋不到 JSX 這一層，所以把 RouteLayer.tsx
改壞四處——拿掉橋的挖洞、套管組與線組對調、金箔高光偏 1px、拿掉淡出——受影響的狀態 D1（graph 區，1400 亮）必須 FAIL；
最後還原並重跑必須 PASS。改了 RouteLayer 的結構（模式對不到）就照新寫法更新這裡的替換式。
用法：vite 跑在 1420 → python3 mockup/tools/graph_render_controls.py（約 3 分鐘；exit 0 = 四個都抓到、還原後 0 px）
"""
import re, shutil, subprocess, sys, tempfile
from pathlib import Path
REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src/components/Graph/RouteLayer.tsx"
BAK = Path(tempfile.mkstemp(suffix=".tsx")[1])
OUT = REPO / "mockup/fidelity-out/p4b-step7-controls"
shutil.copy(SRC, BAK)
orig = SRC.read_text()

def swap_groups(s):
    a = s.index("      <g>\n        {edges.map((e, i) => (\n          <path key={i} d={pathD(e.pts)} fill=\"none\" stroke=\"var(--sheet)\"")
    b = s.index("      <g>\n        {edges.map((e, i) => (\n          <path\n            key={i}")
    end_a = s.index("      </g>\n", a) + len("      </g>\n")
    end_b = s.index("      </g>\n", b) + len("      </g>\n")
    assert end_a <= b
    return s[:a] + s[b:end_b] + s[end_a:b] + s[a:end_a] + s[end_b:]

def sub1(old, new):
    def f(s):
        assert s.count(old) == 1, f"pattern count {s.count(old)}: {old}"
        return s.replace(old, new)
    return f

CONTROLS = [
    ("holes: no mask on the lower line", sub1("mask={holes.has(i) ? `url(#kg-hole-${i})` : undefined}", "mask={undefined}"), "routes"),
    ("casings and lines swapped", swap_groups, "default"),
    ("the flake's shine one px right", sub1("points={shinePoints(cx, cy)}", "points={shinePoints(cx + 1, cy)}"), "default"),
    ("no fade on the lines that run on", sub1('<g mask="url(#kg-run-on)">{tracks}</g>', "<g>{tracks}</g>"), "scroll=end"),
]

def d1(state, tag):
    res = subprocess.run(["python3", str(REPO / "mockup/tools/fidelity_compare.py"), "--states", state, "--regions", "graph",
                          "--sizes", "1400x900", "--themes", "light", "--out", str(OUT / tag)], capture_output=True, text=True, cwd=REPO)
    row = next((l for l in res.stdout.splitlines() if "| graph |" in l), res.stdout[-300:])
    return row

failed = 0
try:
    for name, mutate, state in CONTROLS:
        SRC.write_text(mutate(orig))
        row = d1(state, re.sub(r"\W+", "-", name))
        ok = "FAIL" in row
        failed += not ok
        print(f"{'caught ' if ok else 'MISSED '} {name} [{state}]: {row.strip()}")
finally:
    shutil.copy(BAK, SRC)
assert SRC.read_text() == orig
print("restored RouteLayer.tsx")
for state in ("default", "routes", "scroll=end"):
    row = d1(state, "after-" + re.sub(r"\W+", "-", state))
    ok = "PASS" in row
    failed += not ok
    print(f"{'pass   ' if ok else 'FAIL   '} restored [{state}]: {row.strip()}")
sys.exit(1 if failed else 0)
