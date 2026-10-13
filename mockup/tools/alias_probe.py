#!/usr/bin/env python3
"""舊 token 別名的探針（Phase 3a 完成條件；之後動到別名或 v8 變數的 PR 照跑）。

用法：vite 跑在 1420（npx vite --port 1420 --strictPort）→ python3 mockup/tools/alias_probe.py
fidelity 入口亮暗各開一次，量：
  1. 別名：每個舊 --color-* 的計算顏色 = 別名表指定的 v8 變數的計算顏色（data-line 主幹 / 緑青各一次）。
     預期值照 .claude/pi-plans/v8-phase3-aliases.md 另抄一份（EXPECTED），不讀 index.css——index.css 抄錯
     才抓得到；變數無效時 color 會繼承哨兵值 rgb(1, 2, 3)，所以指到不存在的變數也抓得到
  2. 對比：別名表「對比量測範圍」29 組，用 canvas 取實際繪出的 sRGB（半透明照 ground → sheet → 該面疊）算 WCAG
  3. overscroll：root 與所有捲動元素的 overscroll-behavior 計算值（root 必須 none）
  4. 開機紀錄：window.__fidelityLog 必須是空的
另做一個靜態檢查：main 上 index.css 的每個 token，src 裡有人引用的都必須還有定義。
2026-10-05 驗證會叫：把兩個別名改錯（指到別的變數 / 不存在的變數），8 行 MISMATCH 全數報出。
各區移植後別名陸續刪除時，EXPECTED 跟著刪。
"""
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.request import urlopen

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent.parent
WK = TOOLS / "wk-shot"
OUT = TOOLS.parent / "fidelity-out" / "alias-probe"
OUT.mkdir(parents=True, exist_ok=True)

L = lambda n: f"var(--{n})"  # noqa: E731
EXPECTED = {
    "app-bg": L("ground"), "app-fg": L("ink"),
    "text-primary": L("ink"), "text-secondary": L("ink-2"),
    "text-tertiary": L("ink-3"), "text-muted": L("ink-3"), "text-faint": L("ink-3"),
    "surface-deep": L("code-bg"), "surface-1": L("sheet"), "surface-2": L("hover"), "surface-3": L("btn-hover-bg"),
    "border": L("hairline"), "border-strong": L("control"),
    "accent": L("line"), "accent-hover": L("line-ink"), "accent-fg": L("rd-fg"), "link": L("line-ink"), "accent-info": L("info"),
    "danger-fg": L("danger"), "warning-fg": L("warning"), "success-fg": L("success"),
    "danger-bg": L("danger-bg"), "warning-bg": L("warning-bg"), "success-bg": L("success-bg"),
    "info-fg": L("info"), "info-bg": "color-mix(in oklab, var(--info) 15%, var(--sheet))",
    # syntax-* 9 個：Phase 5 5b 換成 v8 上色器時隨 highlight.css 刪
    # graph 的 9 個與 lane-1..5：Phase 4 換成 v8 路線圖時隨舊 graph 刪
}
# 對比量測範圍（別名表）：[#, 前景, 背景, 文字?]；背景依實際疊法：ground → sheet → 該面
PAIRS = (
    [(i + 1, fg, "sheet", True) for i, fg in enumerate(["ink", "ink-2", "ink-3"])]
    + [(i + 4, fg, "hover", True) for i, fg in enumerate(["ink", "ink-2", "ink-3"])]
    + [(i + 7, fg, "ground", True) for i, fg in enumerate(["ink", "ink-2", "ink-3"])]
    + [(10, "ink", "code-bg", True), (11, "ink-3", "code-bg", True), (12, "ink", "btn-hover-bg", True)]
    + [(13, "danger", "danger-bg", True), (14, "warning", "warning-bg", True), (15, "success", "success-bg", True)]
    + [(16, "danger", "sheet", True), (17, "warning", "sheet", True), (18, "success", "sheet", True)]
    + [(19, "line", "sheet", True), (20, "line-ink", "sheet", True), (21, "rd-fg", "line", True), (22, "info", "band", True)]
    + [(23 + i, fg, "code-bg", True) for i, fg in enumerate(["syn-kw", "syn-str", "syn-num", "syn-type", "syn-fn", "syn-com"])]
    + [(29, "hover", "sheet", False)]
)

PROBE = r"""
(() => {
  const EXPECTED = %s, PAIRS = %s;
  const root = document.documentElement, out = { theme: root.dataset.theme, line0: root.dataset.line, alias: [], contrast: [] };
  const box = document.createElement("div");
  box.style.cssText = "position:absolute;left:-9999px;top:0;color:rgb(1, 2, 3)";  // 變數無效時 color 繼承這個哨兵值
  document.body.appendChild(box);
  const colorOf = (expr) => { const s = document.createElement("span"); s.style.color = expr; box.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; };
  const cv = document.createElement("canvas"); cv.width = cv.height = 1;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  // 把一串顏色由下往上疊在白底上，回傳實際繪出的 sRGB（半透明照瀏覽器的合成）
  const paint = (exprs) => {
    ctx.globalAlpha = 1; ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 1, 1);
    for (const e of exprs) {
      const c = colorOf(e);
      ctx.fillStyle = "#010203"; ctx.fillStyle = c;
      if (ctx.fillStyle === "#010203") throw new Error("canvas rejected colour " + c);
      ctx.fillRect(0, 0, 1, 1);
    }
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  };
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const stack = (s) => s === "ground" ? ["var(--ground)"] : s === "sheet" ? ["var(--ground)", "var(--sheet)"] : ["var(--ground)", "var(--sheet)", `var(--${s})`];
  for (const line of ["trunk", "rokusho"]) {
    root.dataset.line = line;
    for (const [name, expr] of Object.entries(EXPECTED)) {
      const a = colorOf(`var(--color-${name})`), b = colorOf(expr), defined = getComputedStyle(root).getPropertyValue(`--color-${name}`).trim() !== "";
      out.alias.push({ line, name, a, b, ok: defined && a === b && a !== "rgb(1, 2, 3)" });
    }
    for (const [n, fg, bg, text] of PAIRS) {
      const bgRgb = paint(stack(bg)), fgRgb = paint([...stack(bg), `var(--${fg})`]);
      out.contrast.push({ line, n, fg, bg, text, ratio: Math.round(ratio(fgRgb, bgRgb) * 100) / 100, fgRgb, bgRgb });
    }
  }
  root.dataset.line = out.line0;
  box.remove();
  const sc = [...document.querySelectorAll("body *")].filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY + " " + getComputedStyle(e).overflowX));
  out.overscroll = {
    html: getComputedStyle(root).overscrollBehaviorY, body: getComputedStyle(document.body).overscrollBehaviorY,
    scrollers: sc.map((e) => ({ el: e.tagName.toLowerCase() + "." + String(e.className).trim().split(/\s+/).slice(0, 4).join("."), ob: getComputedStyle(e).overscrollBehaviorY, overflows: e.scrollHeight > e.clientHeight })),
  };
  out.log = window.__fidelityLog || null;
  return JSON.stringify(out);
})();
"""


def used_tokens_check():
    old = subprocess.run(["git", "-C", str(REPO), "show", "main:src/index.css"], capture_output=True, text=True, check=True).stdout
    old_names = sorted(set(re.findall(r"--color-([a-z0-9-]+)\s*:", old)))
    new = (REPO / "src" / "index.css").read_text(encoding="utf-8")
    new_names = set(re.findall(r"--color-([a-z0-9-]+)\s*:", new))
    src = ""
    for p in (REPO / "src").rglob("*"):
        if p.suffix in (".ts", ".tsx", ".css") and p.name != "index.css":
            src += p.read_text(encoding="utf-8") + "\n"
    rows = []
    for n in old_names:
        used = bool(re.search(rf"(?<![\w-])(?:[a-z]+-)?{re.escape(n)}(?![\w-])", src)) or f"--color-{n}" in src
        rows.append((n, used, n in new_names))
    missing = [n for n, used, defined in rows if used and not defined]
    print(f"static: {len(old_names)} old tokens, {sum(u for _, u, _ in rows)} referenced in src, "
          f"{len(new_names)} defined now; referenced but undefined: {missing or 'none'}")
    print(f"        defined now but not in the table: {sorted(new_names - set(EXPECTED)) or 'none'}; "
          f"in the table but not defined: {sorted(set(EXPECTED) - new_names) or 'none'}")
    return missing


def main():
    try:
        urlopen("http://localhost:1420", timeout=3)
    except OSError:
        sys.exit("vite is not running on 1420")
    missing = used_tokens_check()
    js = OUT / "probe.js"
    js.write_text(PROBE % (json.dumps(EXPECTED), json.dumps(PAIRS)), encoding="utf-8")
    bad = len(missing)
    report = {}
    for theme in ("light", "dark"):
        res = subprocess.run([str(WK), f"http://localhost:1420/fidelity.html?theme={theme}", "1400", "900", "-", str(js), "ready"],
                             capture_output=True, text=True)
        lines = [l for l in res.stdout.splitlines() if l.strip() and not l.startswith("saved ")]
        if res.returncode or not lines:
            print(f"[{theme}] wk-shot failed: exit {res.returncode} {res.stderr.strip()} {res.stdout.strip()}")
            bad += 1
            continue
        r = json.loads(lines[-1])
        report[theme] = r
        alias_bad = [a for a in r["alias"] if not a["ok"]]
        print(f"\n[{theme}] data-theme={r['theme']} data-line(after boot)={r['line0']} · fidelity log: {r['log'] if r['log'] else 'empty'}")
        print(f"  alias probe: {len(r['alias']) - len(alias_bad)}/{len(r['alias'])} match ({len(EXPECTED)} tokens x 2 lines)")
        for a in alias_bad:
            print(f"    MISMATCH line={a['line']} --color-{a['name']}: {a['a']} vs expected {a['b']}")
        bad += len(alias_bad) + (1 if r["log"] else 0) + (r["theme"] != theme)
        o = r["overscroll"]
        print(f"  overscroll: html={o['html']} body={o['body']}; scrollers: " +
              ", ".join(f"{s['el']}={s['ob']}{'' if s['overflows'] else ' (not overflowing)'}" for s in o["scrollers"]))
        bad += o["html"] != "none"
        # 移植成 v8 的捲動區自己擋回彈（contain 只擋冒泡、清單自己仍回彈）：graph 的捲動層要在，而且是 none
        graph = [s for s in o["scrollers"] if s["el"].startswith("div.graph-scroll")]
        if len(graph) != 1 or graph[0]["ob"] != "none":
            print(f"  FAIL .graph-scroll overscroll-behavior: {[s['ob'] for s in graph] or 'not found'}")
            bad += 1
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")

    print("\ncontrast (WCAG, rendered sRGB; text pairs need 4.5:1):")
    print(f"  {'#':>3} {'fg':10} {'bg':13} {'light/trunk':>11} {'light/rok':>9} {'dark/trunk':>10} {'dark/rok':>8}")
    for n, fg, bg, text in PAIRS:
        vals = []
        for theme in ("light", "dark"):
            for line in ("trunk", "rokusho"):
                c = next(c for c in report.get(theme, {}).get("contrast", []) if c["n"] == n and c["line"] == line)
                vals.append(c["ratio"])
        flag = "" if not text else ("" if min(vals) >= 4.5 else "  < 4.5")
        print(f"  {n:>3} {fg:10} {bg:13} {vals[0]:>11} {vals[1]:>9} {vals[2]:>10} {vals[3]:>8}{flag}{'' if text else '  (non-text, number only)'}")
    print(f"\n{'ALL CHECKS PASS' if not bad else f'{bad} FAIL'} (contrast exceptions listed above need sign-off) · {OUT}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
