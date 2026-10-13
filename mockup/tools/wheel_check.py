#!/usr/bin/env python3
"""捲動檢查：在系統 WKWebView 對 diff 與 PR 檔案送原生滾輪事件（wk-wheel），量外層捲動區有沒有跟著捲。

用法：python3 wheel_check.py [--ref 基準檔 | --url 網址] [--runs 3] [-q]     全部 PASS 才 exit 0
  --url 給 app 的 fidelity 入口（http://localhost:1420/fidelity.html，vite 要先跑著）
由來（2026-10-12，5b 子超實機抓到）：.hunk-body 是橫向捲動容器，overscroll-behavior 兩軸都 none 時，游標停在
有長行的 hunk 上，diff 區上下捲不動——觸控板手指一碰到（MayBegin）WebKit 就把整個手勢交給它、none 又不准往外傳；
滑鼠滾輪則每一下都被 none 擋住。hunk 一高過 diff 區（幾百行的新檔），整片卡死到換選取為止。
檢查（每項都是在 2026-10-12 的舊基準上先看紅的）：
  scan     包在捲動區裡的捲動容器，自己那一軸捲不動、外層能捲，卻把那一軸設成 none / contain → FAIL（通用規則）
  control  短行（沒有橫向溢出）的 hunk 上捲得動——工具本身的對照，失敗 = 量不到（ERROR），不算通過
  wide     有長行的高 hunk（HEAD diff 每行加 300 字元、行數 ×7，形狀同 ccFamily 7b6d364）上，diff 區捲得動
  pr       PR 分頁展開的檔案（同一個檔案元件，在 .prs 裡）上，PR 清單捲得動
輸入：legacy（滑鼠滾輪）、trackpad（觸控板，含 MayBegin），各 --runs 次都要過。
SKIP 只有一種：--url（app）時 APP_PENDING 裡的捲動區根本不在頁面上（5c 接上 ?tab=prs 之後是空的，pr 項真量）。捲動區在、
卻量不到東西（例如某個狀態沒展開檔案）一律 ERROR；--ref（基準）上 PR 面板不在也是 ERROR。SKIP 會列在摘要與 -q 的輸出裡
（第三輪審查 2026-10-12：原本兩種「找不到」同一個結束碼，scan 找不到要撐開的 hunk 也照印 PASS，-q 還把 SKIP 藏掉）。
不檢查：一行數萬字元的壓縮碼（diff-limits）——修前修後都時好時壞、原因未明（known-followups「捲動」）。
"""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REF = TOOLS.parent / "v8-kirazuri-lines-sys.html"
WK = TOOLS / "wk-shot"
WW = TOOLS / "wk-wheel"
WW_SRC = TOOLS / "wk-wheel.swift"

# 把一個 hunk 變成「又寬又高」：每行加 extra 個字元、所有行複製 copies 次
WIDEN = """
const widen = (body, copies, extra) => {
  const inner = body.querySelector(".hunk-inner"), rows = [...inner.querySelectorAll(".dl")];
  for (let k = 0; k < copies; k++) for (const dl of rows) inner.appendChild(dl.cloneNode(true));
  for (const dl of inner.querySelectorAll(".dl")) dl.append(" " + "y".repeat(extra));
};
"""

# locate：在 scroller 裡找第一個看得到的 hunk（pick 決定要哪一種），可先 widen，回傳它可見部分的中心
LOCATE = WIDEN + """
(() => {
  const sc = document.querySelector(%(scroller)s);
  if (!sc || !sc.getClientRects().length) return "absent";
  const vr = sc.getBoundingClientRect();
  for (const b of sc.querySelectorAll(".hunk-body")) {
    if (!b.getClientRects().length) continue;
    if (%(widen)s) widen(b, 6, 300);
    const wide = b.scrollWidth > b.clientWidth + 1;
    if (%(want_wide)s !== wide) continue;
    const r = b.getBoundingClientRect(), top = Math.max(r.top, vr.top), bottom = Math.min(r.bottom, vr.bottom);
    if (bottom - top < 20) continue;
    window.__wc = { sel: %(scroller)s, before: sc.scrollTop };
    return Math.round(r.left + Math.min(200, r.width / 2)) + "," + Math.round((top + bottom) / 2);
  }
  return "none";
})()
"""

PROBE = """
(() => {
  const sc = document.querySelector(window.__wc.sel);
  return JSON.stringify({ before: Math.round(window.__wc.before), after: Math.round(sc.scrollTop),
    max: sc.scrollHeight - sc.clientHeight });
})()
"""

# scan：每個捲動容器往上找最近的捲動祖先；這一軸自己捲不動、祖先能捲，卻設 none / contain 的就列出來
SCAN = WIDEN + """
(() => {
  // 要撐開的 hunk 不在（例如 PR 面板沒畫出來）要報出來：不然掃的只是預設頁，照樣印 PASS
  const missing = [];
  for (const sel of %(widen)s) {
    const b = document.querySelector(sel);
    if (b && b.getClientRects().length) widen(b, 6, 300);
    else missing.push(sel);
  }
  const scrolls = (el) => { const cs = getComputedStyle(el); return /auto|scroll/.test(cs.overflowX + " " + cs.overflowY); };
  const name = (el) => el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.classList.length ? "." + [...el.classList].join(".") : "");
  const bad = new Set();
  for (const el of document.querySelectorAll("*")) {
    if (!scrolls(el)) continue;
    let p = el.parentElement;
    while (p && !scrolls(p)) p = p.parentElement;
    if (!p) continue;
    const cs = getComputedStyle(el);
    const axes = [["y", el.scrollHeight <= el.clientHeight, p.scrollHeight > p.clientHeight, cs.overscrollBehaviorY],
                  ["x", el.scrollWidth <= el.clientWidth, p.scrollWidth > p.clientWidth, cs.overscrollBehaviorX]];
    for (const [axis, stuck, outer, ob] of axes)
      if (stuck && outer && ob !== "auto") bad.add(name(el) + " in " + name(p) + ": overscroll-behavior-" + axis + " " + ob);
  }
  return JSON.stringify({ bad: [...bad], missing });
})()
"""

# (名稱, 網址參數, 捲動區, 要寬的 hunk, 先 widen)
CASES = [
    ("control", "", ".diff-scroll", False, False),
    ("wide", "", ".diff-scroll", True, True),
    ("pr", "tab=prs", ".prs", True, True),
]
SCANS = [
    ("default", "", []),
    ("default+wide", "", [".diff-scroll .hunk-body"]),
    ("tab=prs+wide", "tab=prs", [".prs .hunk-body"]),
]
MODES = ["legacy", "trackpad"]
# app 的 fidelity 入口還畫不出來的捲動區：只有它們在 --url 時不在頁面上可以 SKIP。5c 接上 ?tab=prs（PR 分頁、#38 展開）
# 之後沒有了；下一個還沒接的捲動區加在這裡
APP_PENDING: tuple[str, ...] = ()


def ensure_built():
    if not WW.exists() or WW.stat().st_mtime < WW_SRC.stat().st_mtime:
        subprocess.run(["swiftc", "-O", "-o", str(WW), str(WW_SRC)], check=True)


def page(base, params):
    q = "theme=light&chrome=0" + (f"&{params}" if params else "")
    return f"{base}?{q}"


def scan(base, tmp, label, params, widen, app):
    js = Path(tmp) / "scan.js"
    js.write_text(SCAN % {"widen": json.dumps(widen)})
    res = subprocess.run([str(WK), page(base, params), "1400", "900", "-", str(js), "ready"], capture_output=True, text=True)
    out = [l for l in res.stdout.splitlines() if l.strip()]
    if res.returncode or not out:
        return [f"ERROR scan {label}: wk-shot exit {res.returncode} {res.stderr.strip()}"]
    d = json.loads(out[-1])
    lines = []
    for sel in d["missing"]:
        if app and sel.startswith(APP_PENDING):
            lines.append(f"SKIP  scan {label}: {sel} 不在頁面上（app 的入口還沒接）")
        else:
            lines.append(f"ERROR scan {label}: {sel} 不在頁面上，掃到的不是要掃的畫面")
    lines += [f"FAIL  scan {label}: {b}" for b in d["bad"]]
    return lines or [f"PASS  scan {label}"]


def wheel(base, tmp, case, mode, run, app):
    name, params, scroller, want_wide, widen = case
    loc, probe = Path(tmp) / f"loc-{name}.js", Path(tmp) / "probe.js"
    loc.write_text(LOCATE % {"scroller": json.dumps(scroller), "widen": json.dumps(widen), "want_wide": json.dumps(want_wide)})
    probe.write_text(PROBE)
    res = subprocess.run([str(WW), page(base, params), "1400", "900", str(loc), str(probe), "30", "10", mode, "ready"],
                         capture_output=True, text=True)
    tag = f"{name:<8} {mode:<9} #{run}"
    if res.returncode == 4:
        # 捲動區不在頁面上：只有 app 上還沒接的 PR 面板可以略過；基準上的 PR 面板不在、其他捲動區不在，都是量不到
        if app and scroller.startswith(APP_PENDING):
            return f"SKIP  {tag}  {scroller} 不在頁面上（app 的入口還沒接）"
        return f"ERROR {tag}  {scroller} 不在頁面上"
    if res.returncode == 3:
        # 捲動區在，卻沒有可量的 hunk（例如那個狀態沒展開檔案）：不是通過，也不能略過
        return f"ERROR {tag}  {scroller} 裡找不到可量的 hunk"
    out = [l for l in res.stdout.splitlines() if l.strip()]
    if res.returncode or not out:
        return f"ERROR {tag}  wk-wheel exit {res.returncode} {res.stderr.strip()}"
    d = json.loads(out[-1])
    room, moved = d["max"] - d["before"], d["after"] - d["before"]
    if room < 100:
        return f"ERROR {tag}  {scroller} 只剩 {room}px 可捲，量不到"
    need = min(150, int(room * 0.75))
    verdict = "PASS " if moved >= need else ("ERROR" if name == "control" else "FAIL ")
    return f"{verdict} {tag}  moved {moved}px (need {need}, room {room})"


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--ref", default=str(REF), help="基準檔（預設工作副本）")
    g.add_argument("--url", help="app 的 fidelity 入口網址")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("-q", action="store_true")
    a = ap.parse_args()
    ensure_built()
    base = a.url or Path(a.ref).resolve().as_uri()
    lines = []
    # 一次一個：事件時序要準，wk-wheel 不並行
    with tempfile.TemporaryDirectory() as tmp:
        for label, params, widen in SCANS:
            lines += scan(base, tmp, label, params, widen, bool(a.url))
        for case in CASES:
            for mode in MODES:
                for run in range(1, a.runs + 1):
                    lines.append(wheel(base, tmp, case, mode, run, bool(a.url)))
    bad = [l for l in lines if l.startswith(("FAIL", "ERROR"))]
    skipped = [l for l in lines if l.startswith("SKIP")]
    # -q 也印 SKIP：沒量到的東西要看得到
    for l in lines if not a.q else bad + skipped:
        print(l)
    tail = f", {len(skipped)} SKIP" if skipped else ""
    print(f"{base.split('?')[0]}: " + (f"all wheel checks pass{tail}" if not bad else f"{len(bad)} FAIL / ERROR{tail}"))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
