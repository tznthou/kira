#!/usr/bin/env python3
"""src/dev/fidelity/states.ts 的變異測試：每條規則改壞後 fidelityStates 測試必須變紅；結束一律還原原檔。"""
import subprocess, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SRC = REPO / "src/dev/fidelity/states.ts"
MUTANTS = [
    ("checkout 不改 HEAD", "  d.graph.head = { oid: target.target, branch: name };\n", ""),
    ("detach 不改 HEAD", "  d.graph.head = { oid: at.full_oid, branch: null };\n", ""),
    ("dropRemotes 不拿 graph 分支", "  d.graph.branches = d.graph.branches.filter((b) => !(b.is_remote && gone.has(b.name)));\n", ""),
    ("clearUpstream 不清 graph upstream", "  for (const b of d.graph.branches) if (!b.is_remote && hit(b.name)) b.upstream = null;\n", ""),
    ("behind 計數錯", "      return setSync(d, current, 0, 3);", "      return setSync(d, current, 0, 2);"),
    ("VIEW_STATES 漏 error-open", '  "error-open",\n', ""),
    ("connecting 不清帳號", '    case "connecting":\n', ""),
]

original = SRC.read_text()
results = []
try:
    for name, old, new in MUTANTS:
        if original.count(old) != 1:
            results.append((name, f"ANCHOR x{original.count(old)}"))
            continue
        SRC.write_text(original.replace(old, new))
        r = subprocess.run(["npx", "vitest", "run", "src/tests/fidelityStates.test.ts"],
                           cwd=REPO, capture_output=True, text=True)
        results.append((name, "killed" if r.returncode != 0 else "SURVIVED"))
finally:
    SRC.write_text(original)

for name, res in results:
    print(f"{res:10} {name}")
killed = sum(1 for _, r in results if r == "killed")
print(f"{killed}/{len(MUTANTS)} killed")
sys.exit(0 if killed == len(MUTANTS) else 1)
