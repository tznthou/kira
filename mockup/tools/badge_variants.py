#!/usr/bin/env python3
"""狀態標記 (M/A/D) 顯色候選：量對比 + 產變體頁 + wk-shot 截圖 + 拼比較圖。

用法：python3 badge_variants.py [metrics|shoot]   （shoot 輸出到 fidelity-out/badge-variants/）

2026-10-05 審查紀錄：現況亮色標記底色對 sheet 只有 1.07–1.09:1，只剩字母看得見
（子超：「不顯色」）。候選 A 加深色票 / B 實心 / C 描邊，子超選 C → 基準 `.badge`
加 `box-shadow: inset 0 0 0 1px currentColor`，套用後與 C 變體逐像素 0 差異（亮暗皆然）。
每個變體都明寫 box-shadow（none 或框線），所以基準改過之後重跑仍得到同一張比較圖。
"""
import json
import math
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from contrast import in_gamut, oklch, ratio  # noqa: E402

BASE = HERE.parent / "v8-kirazuri-lines-sys.html"
WK = str(HERE / "wk-shot")
OUT = HERE.parent / "fidelity-out" / "badge-variants"

SHEET = {"light": (0.976, 0.005, 225), "dark": (0.226, 0.017, 238)}
PEARL, DARK_FG = (0.988, 0.003, 225), (0.188, 0.016, 240)

# 現況（基準 token 原值）：status -> (bg, fg)
CUR = {
    "light": {"M": ((0.950, 0.040, 85), (0.480, 0.095, 72)),
              "A": ((0.948, 0.032, 165), (0.450, 0.095, 162)),
              "D": ((0.950, 0.024, 28), (0.500, 0.150, 28))},
    "dark": {"M": ((0.310, 0.050, 80), (0.810, 0.100, 80)),
             "A": ((0.290, 0.050, 165), (0.770, 0.110, 160)),
             "D": ((0.300, 0.060, 28), (0.740, 0.130, 28))},
}

# 變體：theme -> status -> {bg, fg, border?}
VARIANTS = {
    "now": {t: {s: {"bg": bg, "fg": fg} for s, (bg, fg) in CUR[t].items()} for t in CUR},
    # A 加深色票：底色壓低 L、拉高 C，字色微壓暗保 4.5:1
    "A": {
        "light": {"M": {"bg": (0.895, 0.085, 82), "fg": (0.440, 0.090, 70)},
                  "A": {"bg": (0.895, 0.070, 163), "fg": (0.420, 0.088, 162)},
                  "D": {"bg": (0.895, 0.050, 28), "fg": (0.470, 0.150, 28)}},
        "dark": {"M": {"bg": (0.380, 0.075, 80), "fg": (0.860, 0.100, 82)},
                 "A": {"bg": (0.360, 0.070, 165), "fg": (0.830, 0.110, 160)},
                 "D": {"bg": (0.370, 0.085, 28), "fg": (0.820, 0.095, 28)}},
    },
    # B 實心顏料：底色 = 原字色、字 = 珍珠白（暗色反過來），同路線圓標的配法
    "B": {
        "light": {s: {"bg": fg, "fg": PEARL} for s, (bg, fg) in CUR["light"].items()},
        "dark": {s: {"bg": fg, "fg": DARK_FG} for s, (bg, fg) in CUR["dark"].items()},
    },
    # C 描邊：原底色 + 1px 原字色內框
    "C": {t: {s: {"bg": bg, "fg": fg, "border": fg} for s, (bg, fg) in CUR[t].items()} for t in CUR},
}


def oklab(c):
    L, C, H = c
    return L, C * math.cos(math.radians(H)), C * math.sin(math.radians(H))


def de(c1, c2):
    a, b = oklab(c1), oklab(c2)
    return math.dist(a, b)


def css_color(c):
    return f"oklch({c[0]:.3f} {c[1]:.3f} {c[2]:g})"


def metrics():
    bad = 0
    print(f"{'var':4} {'theme':5} {'s':1}  {'字/底':>6} {'底/sheet':>8} {'ΔE底':>6} {'框/sheet':>8}  gamut")
    for v, themes in VARIANTS.items():
        for t, sts in themes.items():
            for s, d in sts.items():
                tb = ratio(d["fg"], d["bg"])
                bs = ratio(d["bg"], SHEET[t])
                dE = de(d["bg"], SHEET[t])
                br = f"{ratio(d['border'], SHEET[t]):8.2f}" if "border" in d else f"{'-':>8}"
                g = all(in_gamut(oklch(*d[k])) for k in d)
                ok = tb >= 4.5 and g
                bad += not ok
                print(f"{v:4} {t:5} {s}  {tb:6.2f} {bs:8.2f} {dE:6.3f} {br}  {'ok' if g else 'OUT'}"
                      f"{'' if ok else '  <-- FAIL'}")
    print("all pass" if not bad else f"{bad} FAIL")
    return bad == 0


def variant_css(v):
    rules = []
    for t, prefix in (("light", ""), ("dark", ':root[data-theme="dark"] ')):
        for s, d in VARIANTS[v][t].items():
            decl = f"background: {css_color(d['bg'])}; color: {css_color(d['fg'])};"
            border = f"inset 0 0 0 1px {css_color(d['border'])}" if "border" in d else "none"
            decl += f" box-shadow: {border};"
            rules.append(f"  {prefix}.badge.{s} {{ {decl} }}")
    return "\n".join(rules)


RECT_JS = """(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; };
  const visible = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  // 示範：staging 前三列的標記改成 M / A / D，三種顏色同框
  const rows = [...document.querySelectorAll("#staged .badge, #unstaged .badge")];
  ["M", "A", "D"].forEach((s, i) => { if (rows[i]) { rows[i].className = "badge " + s; rows[i].textContent = s; } });
  const form = document.querySelector("#commit") && document.querySelector("#commit").closest("form");
  const dhead = [...document.querySelectorAll(".dfile-head")].find(visible);
  return JSON.stringify({ pane: r(document.querySelector(".side-pane")), form: r(form), dhead: r(dhead || null),
    demo: rows.slice(0, 3).map((b) => b.className) });
})()"""


def shoot():
    from PIL import Image, ImageDraw, ImageFont

    src = BASE.read_text()
    assert src.count("</style>") == 1
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "rects.js").write_text(RECT_JS)
    cells = {}
    for v in VARIANTS:
        page = OUT / f"v-{v}.html"
        inject = f"  /* badge variant {v} */\n{variant_css(v)}\n"
        page.write_text(src.replace("</style>", inject + "</style>"))
        for t in ("light", "dark"):
            out = OUT / f"{v}-{t}.png"
            url = f"{page.as_uri()}?theme={t}&chrome=0"
            res = subprocess.run([WK, url, "1400", "900", str(out), str(OUT / "rects.js"), "ready"],
                                 capture_output=True, text=True)
            if res.returncode:
                sys.exit(f"wk-shot failed {v} {t}: {res.stderr}")
            rects = json.loads("\n".join(l for l in res.stdout.splitlines() if not l.startswith("saved ")))
            im = Image.open(out)
            assert im.size == (2800, 1800), im.size
            px, py, pw, ph = (round(x * 2) for x in rects["pane"])
            fy = round(rects["form"][1] * 2) if rects["form"] else py + ph
            staging = im.crop((px, py, px + pw, fy))
            parts = [staging]
            if rects["dhead"]:
                hx, hy, hw, hh = (round(x * 2) for x in rects["dhead"])
                parts.append(im.crop((hx, hy, hx + min(hw, pw), hy + hh)))
            cells[(v, t)] = parts
            print(v, t, "demo:", rects["demo"], "dhead:", rects["dhead"])

    # 拼圖：列 = 主題，欄 = 變體；每格 = staging + 第一個 diff 檔頭
    font = None
    for f in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNS.ttf"):
        try:
            font = ImageFont.truetype(f, 34)
            break
        except OSError:
            pass
    font = font or ImageFont.load_default()
    pad, label_h = 24, 56
    cw = max(max(p.width for p in parts) for parts in cells.values())
    ch = max(sum(p.height for p in parts) + pad * (len(parts) - 1) for parts in cells.values())
    names = list(VARIANTS)
    W = pad + len(names) * (cw + pad)
    H = 2 * (label_h + ch + pad) + pad
    sheet = Image.new("RGB", (W, H), (128, 128, 128))
    d = ImageDraw.Draw(sheet)
    for ri, t in enumerate(("light", "dark")):
        y0 = pad + ri * (label_h + ch + pad)
        for ci, v in enumerate(names):
            x0 = pad + ci * (cw + pad)
            d.text((x0, y0), f"{v}  ·  {t}", fill=(255, 255, 255), font=font)
            y = y0 + label_h
            for p in cells[(v, t)]:
                sheet.paste(p, (x0, y))
                y += p.height + pad
    out = OUT / "compare.png"
    sheet.save(out)
    print("wrote", out, sheet.size)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "metrics"
    if cmd == "metrics":
        sys.exit(0 if metrics() else 1)
    if cmd == "shoot":
        shoot()
