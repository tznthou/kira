#!/usr/bin/env python3
"""基準殼層互動流程（Phase 0b）：每個流程一次 wk-shot 載入，跑 shell_flows.js 的斷言。

用法：python3 shell_flows.py [--ref 基準檔] [-q] [--only 流程名,…] [--jobs 4]     全部 PASS 才 exit 0
流程與網址參數一一對應；時間行為用假時鐘（換掉 setTimeout / Date.now），不靠真的等。
測試本身的把關力由 shell_mutate.py 驗（逐條改壞規則，流程必須變紅）。
流程彼此獨立（各自一次載入、不截圖），平行跑；結果照 FLOWS 的順序印。
"""
import argparse
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REF = TOOLS.parent / "v8-kirazuri-lines-sys.html"
WK = TOOLS / "wk-shot"
JS = TOOLS / "shell_flows.js"

FLOWS = [
    ("push", ""),
    ("diverged", "state=diverged"),
    ("publish", "state=no-upstream"),
    ("behind", "state=behind"),
    ("account", ""),
    ("account-fail", "fail=signout,connect"),
    ("detached", "state=detached"),
    ("no-remote", "state=no-remote"),
    ("both-blocked", "state=no-remote,detached"),
    ("signed-out", "state=signed-out"),
    ("menu-open", "state=account-menu"),
    ("static", "state=error-push"),
    ("static", "chrome=full"),
    # Phase 0b P5：側欄 / 右欄 / diff
    ("beyond-checkout", ""),
    ("lodger-checkout", "state=lodger"),
    ("checkout-fail", "fail=refresh,checkout"),
    ("clear-checkout", "state=error-push"),
    ("clear-stage", "state=error-push"),
    ("clear-commit", "state=error-push"),
    ("stage-fail", "fail=stage"),
    ("commit-fail", "fail=commit"),
    ("busy-legend", ""),
    ("status-fail", "fail=status"),
    ("conflict", "state=conflict"),
    ("prs-signin", "state=signed-out&tab=prs"),
    ("prs-signin-fail", "state=signed-out&tab=prs&fail=connect"),
    ("signout-prs", "tab=prs"),
    ("prs-retry", "state=prs-error&tab=prs"),
    ("prs-rate", "state=prs-rate&tab=prs"),
    ("prs-states", "state=no-remote&tab=prs"),
    ("prs-states", "state=no-remote,signed-out&tab=prs"),
    ("prs-states", "state=empty&tab=prs"),
    ("prs-states", "state=young&tab=prs"),
    ("prs-states", "state=routes&tab=prs"),
    ("prs-states", "state=prs-empty&tab=prs"),
    ("prs-states", "state=error-auth&tab=prs"),
    ("prs-states", "state=connecting&tab=prs"),
    ("pr-diff", "tab=prs"),
    ("pr-diff-retry", "state=pr-diff-error&tab=prs"),
    # Phase 5 第 0 步（5c，子超 2026-10-12）：graph 回來前不畫 via（Q-L）、PR 展開的收合條、PR 太大
    ("pr-via-loading", "state=loading&tab=prs"),
    ("pr-diff-limits", "state=pr-diff-limits&tab=prs"),
    ("pr-diff-too-large", "state=pr-diff-too-large&tab=prs"),
    ("diff-retry", "state=diff-error"),
    ("diff-limits", "state=diff-limits"),
    ("panel-static", "state=opening"),
    ("panel-static", "state=pruned"),
    ("panel-static", "state=many-changes"),
    ("panel-static", "state=empty"),
    ("panel-static", "state=young"),
    ("panel-static", "state=diff-many"),
    ("panel-static", "state=diff-empty"),
    # Phase 5 第 0 步（5a）：Q-L 骨架圓點、Q-B 分支清單讀不到、?on= 在 state 之後
    ("panel-static", "state=loading"),
    ("branches-retry", "state=branches-error"),
    ("branches-fail", "fail=branches"),
    ("on-after-state", "state=lodger&on=release/0.1"),
    # Phase 5 第 0 步（5b）：hunk 標頭的函式名（B2 / Q-B2）、依副檔名上色（Q-H (A′)）
    ("diff-code", ""),
    ("diff-code-young", "state=young"),
    # Q-T：雙向控制字元標出來、不生效
    ("diff-bidi", "state=diff-bidi"),
    # 5b step 7：?diffat=<路徑> 把 diff 捲到那個檔（比對截圖才拍得到第一屏以下）
    ("diff-at", "state=diff-limits&diffat=src-tauri/capabilities/default.json"),
]


def run_one(ref, flow, params):
    # URLSearchParams.get 取第一個值：流程自己指定 chrome 時不能再先塞 chrome=0
    base = "theme=light" + ("" if "chrome=" in params else "&chrome=0")
    url = f"{Path(ref).resolve().as_uri()}?{base}&flow={flow}" + (f"&{params}" if params else "")
    res = subprocess.run([str(WK), url, "1400", "900", "-", str(JS), "ready"], capture_output=True, text=True)
    lines = [l for l in res.stdout.splitlines() if l.strip()]
    if res.returncode or not lines:
        lines = [f"FAIL  wk-shot exit {res.returncode}: {res.stderr.strip() or 'no output'}"]
    return lines


def run(ref, quiet=False, only=None, jobs=4):
    flows = [(f, p) for f, p in FLOWS if not only or f in only]
    if only and not flows:
        sys.exit(f"no flow named {only}")
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        results = list(pool.map(lambda fp: run_one(ref, *fp), flows))
    failed = 0
    for (flow, params), lines in zip(flows, results):
        bad = [l for l in lines if not l.startswith("PASS")]
        failed += len(bad)
        if not quiet:
            print(f"== {flow} {params}".rstrip() + f"  ({len(lines) - len(bad)}/{len(lines)})")
            for l in bad:
                print("   " + l)
    return failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", default=str(REF))
    ap.add_argument("-q", action="store_true")
    ap.add_argument("--only", default="", help="只跑這些流程（逗號分隔）")
    ap.add_argument("--jobs", type=int, default=4)
    a = ap.parse_args()
    failed = run(a.ref, a.q, [x for x in a.only.split(",") if x] or None, a.jobs)
    print("all flows pass" if not failed else f"{failed} FAIL")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
