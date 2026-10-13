#!/usr/bin/env python3
"""強調色跟著所在路線變（子超 2026-10-04 決策）：6 條路線 × 亮/暗的衍生 token。

規則：緑青（rokusho）= v8 mockup 原值，當樣板；其他顏料套同一套關係——
  line-ink  : 亮 L .450 / 暗 L .790，chroma 依顏料比例，色相 +3（亮）/ +0（暗）
  selected  : 亮 L .930 C .026 / 暗 L .292 C .036，色相 +6
  sel-edge  : 亮 L .86 C .03 / 暗 L .36 C .04，色相 +6（--sel-shadow 底邊）
  selection : 亮 L .87 C .05 / 暗 L .40 C .06，色相 +3
  focus-glow: 線色 / .20（亮）/ .25（暗）
主幹（trunk）例外：線色是墨/胡粉，與內文同色系 → line-ink 改用 ink-2（hover 到 ink 才看得出變化），
selected 用中性冷灰並把明度拉開，避免與 hover 混在一起。

輸出：逐項對比度檢查表；全部通過才印 CSS（--css）。"""
import sys
from contrast import oklch, ratio, in_gamut

THEMES = {
    "light": {
        "sheet": (0.976, 0.005, 225), "sheet-hi": (0.988, 0.003, 225), "hover": (0.938, 0.012, 220),
        "ink": (0.255, 0.028, 238), "ink-2": (0.405, 0.022, 236), "ink-3": (0.475, 0.018, 234),
        "lines": {
            "trunk": (0.300, 0.030, 240), "rokusho": (0.505, 0.090, 172), "gunjo": (0.470, 0.135, 264),
            "shinsha": (0.525, 0.150, 33), "murasaki": (0.480, 0.105, 315), "odo": (0.530, 0.090, 72),
        },
        "glow": 0.20,
    },
    "dark": {
        "sheet": (0.226, 0.017, 238), "sheet-hi": (0.252, 0.017, 236), "hover": (0.274, 0.019, 232),
        "ink": (0.930, 0.010, 230), "ink-2": (0.810, 0.014, 232), "ink-3": (0.715, 0.016, 234),
        "lines": {
            "trunk": (0.880, 0.012, 88), "rokusho": (0.745, 0.100, 172), "gunjo": (0.715, 0.115, 266),
            "shinsha": (0.725, 0.130, 36), "murasaki": (0.730, 0.100, 318), "odo": (0.790, 0.100, 80),
        },
        "glow": 0.25,
    },
}

# 緑青樣板（v8 原值）——推導規則必須能原樣重現這組
TEMPLATE = {
    "light": {"line-ink": (0.450, 0.080, 175), "selected": (0.930, 0.026, 178), "sel-edge": (0.86, 0.03, 178), "selection": (0.87, 0.05, 175)},
    "dark": {"line-ink": (0.790, 0.095, 172), "selected": (0.292, 0.036, 178), "sel-edge": (0.36, 0.04, 178), "selection": (0.40, 0.06, 175)},
}


def fit(c):
    """超出 sRGB 色域時保留 L、H，逐步降彩度到剛好進色域（暗色高彩顏料的 line-ink 會超出）。"""
    L, C, H = c
    while C > 0 and not in_gamut(oklch(L, C, H)):
        C = round(C - 0.001, 3)
    return (L, C, H)


def derive(theme, name):
    d = _derive(theme, name)
    return {k: fit(v) for k, v in d.items()}


def _derive(theme, name):
    t = THEMES[theme]
    L, C, H = t["lines"][name]
    if name == "trunk":
        cool = 240 if theme == "light" else 236
        if theme == "light":
            return {"line-ink": t["ink-2"], "selected": (0.915, 0.012, cool), "sel-edge": (0.84, 0.014, cool), "selection": (0.87, 0.02, cool)}
        return {"line-ink": t["ink-2"], "selected": (0.305, 0.016, cool), "sel-edge": (0.37, 0.016, cool), "selection": (0.40, 0.02, cool)}
    rok = t["lines"]["rokusho"]
    tpl = TEMPLATE[theme]
    k = C / rok[1]  # 顏料彩度相對緑青的比例
    ink_l, ink_c, _ = tpl["line-ink"]
    return {
        "line-ink": (ink_l, round(ink_c * k, 3), (H + (3 if theme == "light" else 0)) % 360),
        "selected": (tpl["selected"][0], tpl["selected"][1], (H + 6) % 360),
        "sel-edge": (tpl["sel-edge"][0], tpl["sel-edge"][1], (H + 6) % 360),
        "selection": (tpl["selection"][0], tpl["selection"][1], (H + 3) % 360),
    }


def fmt(c, alpha=None):
    L, C, H = c
    s = f"oklch({L:.3f} {C:.3f} {H:g}"
    return s + (f" / {alpha:g})" if alpha is not None else ")")


def main(emit_css):
    failures = 0
    # 樣板重現檢查
    for theme in THEMES:
        d = derive(theme, "rokusho")
        for key, want in TEMPLATE[theme].items():
            if tuple(round(x, 3) for x in d[key]) != tuple(round(x, 3) for x in want):
                print(f"BAD template {theme}.{key}: derived {d[key]} != v8 {want}")
                failures += 1
    rows = []
    for theme, t in THEMES.items():
        for name, line in t["lines"].items():
            d = derive(theme, name)
            sel = d["selected"]
            checks = [
                ("line/sheet≥3", ratio(line, t["sheet"]), 3),
                ("line/hover≥3", ratio(line, t["hover"]), 3),
                ("ink/sel≥7", ratio(t["ink"], sel), 7),
                ("ink2/sel≥4.5", ratio(t["ink-2"], sel), 4.5),
                ("ink3/sel≥4.5", ratio(t["ink-3"], sel), 4.5),
                ("lnink/sheet≥4.5", ratio(d["line-ink"], t["sheet"]), 4.5),
                ("lnink/sel≥4.5", ratio(d["line-ink"], sel), 4.5),
                ("ink/selection≥7", ratio(t["ink"], d["selection"]), 7),
            ]
            # 每條路線畫過「這個強調色的選取列」都要 ≥ 3:1
            worst_line = min((ratio(other, sel), oname) for oname, other in t["lines"].items())
            checks.append((f"all-lines/sel≥3 ({worst_line[1]})", worst_line[0], 3))
            gamut = all(in_gamut(oklch(*c)) for c in (d["line-ink"], sel, d["sel-edge"], d["selection"]))
            sel_vs_hover = abs(sel[0] - t["hover"][0])
            bad = [f"{n}={v:.2f}" for n, v, th in checks if v < th]
            if not gamut:
                bad.append("OUT-OF-GAMUT")
            failures += len(bad)
            rows.append((theme, name, checks, gamut, sel_vs_hover, bad))
    for theme, name, checks, gamut, dl, bad in rows:
        summary = " ".join(f"{n.split('≥')[0]}:{v:.1f}" for n, v, _ in checks)
        print(f"{'ok ' if not bad else 'BAD'} {theme:5s} {name:8s} ΔL(sel,hover)={dl:.3f} gamut={'y' if gamut else 'N'} | {summary}" + (f"  ← {bad}" if bad else ""))
    print("RESULT:", "ALL PASS" if failures == 0 else f"{failures} failure(s)")
    if emit_css and failures == 0:
        print()
        for theme, t in THEMES.items():
            for name in t["lines"]:
                d = derive(theme, name)
                sel = ":root" + (f'[data-theme="dark"]' if theme == "dark" else "") + f'[data-line="{name}"]'
                hi = "oklch(1 0 0 / 0.7)" if theme == "light" else "oklch(1 0 0 / 0.05)"
                print(f"  {sel} {{ --line: var(--l-{name}); --line-ink: {fmt(d['line-ink'])}; "
                      f"--focus-glow: {fmt(t['lines'][name], t['glow'])}; --selection: {fmt(d['selection'])}; "
                      f"--selected: {fmt(d['selected'])}; --sel-shadow: inset 0 1px 0 {hi}, inset 0 -1px 0 {fmt(d['sel-edge'])}; }}")
    return failures == 0


if __name__ == "__main__":
    sys.exit(0 if main("--css" in sys.argv) else 1)
