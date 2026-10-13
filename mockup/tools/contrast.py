#!/usr/bin/env python3
"""OKLCH → sRGB → WCAG 對比度與色域檢查（零依賴）。

用法：
  python3 contrast.py selftest          # 對照 v8 mockup 註解標的對比度，驗證換算正確
  在其他腳本 `from contrast import oklch, ratio, in_gamut`

換算：OKLCH → OKLab → LMS → linear sRGB（Björn Ottosson 矩陣）；
WCAG 相對亮度用 linear sRGB（先 clip 到 [0,1]）。超出色域時瀏覽器會做 gamut mapping，
此處以 clip 近似並另外回報 in_gamut=False，讓呼叫端決定要不要調色。
"""
import math
import sys


def oklch(L, C, H):
    """回傳 linear sRGB (r, g, b)，可能超出 [0,1]。"""
    a = C * math.cos(math.radians(H))
    b = C * math.sin(math.radians(H))
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
    return (
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    )


def in_gamut(rgb, eps=1e-4):
    return all(-eps <= c <= 1 + eps for c in rgb)


def luminance(rgb):
    r, g, b = (min(1.0, max(0.0, c)) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(c1, c2):
    """c1/c2 為 (L, C, H) tuple。"""
    y1, y2 = luminance(oklch(*c1)), luminance(oklch(*c2))
    hi, lo = max(y1, y2), min(y1, y2)
    return (hi + 0.05) / (lo + 0.05)


def selftest():
    # v8 mockup 註解中標註的對比度（亮色）
    sheet = (0.976, 0.005, 225)
    selected = (0.930, 0.026, 178)
    # 註：mockup 標「ink 13.4:1 on sheet」，本換算得 14.68，且沒有任何背景剛好 13.4
    # （band 13.29 / hover 13.14 / ground 13.05）；其餘 4 項皆 ±0.05 內吻合 → 判定為過期註解，
    # 原因無法查證。ink 只驗門檻（≥ 7:1，最差背景 selected 12.91）。
    ink_min = min(ratio((0.255, 0.028, 238), bg) for bg in (sheet, selected, (0.938, 0.012, 220)))
    print(f"{'ok ' if ink_min >= 7 else 'BAD'} {'ink ≥ 7:1 on every row state':32s} min {ink_min:5.2f}")
    checks = [
        ("ink-3 on selected (5.5:1)", (0.475, 0.018, 234), selected, 5.5),
        ("line-ink on sheet (6.7:1)", (0.450, 0.080, 175), sheet, 6.7),
    ]
    # 暗色
    dsheet = (0.226, 0.017, 238)
    checks += [
        ("dark ink on sheet (13.9:1)", (0.930, 0.010, 230), dsheet, 13.9),
        ("dark ink-3 on sheet (6.8:1)", (0.715, 0.016, 234), dsheet, 6.8),
    ]
    ok = ink_min >= 7
    for name, fg, bg, expect in checks:
        got = ratio(fg, bg)
        hit = abs(got - expect) <= 0.15
        ok &= hit
        print(f"{'ok ' if hit else 'BAD'} {name:32s} got {got:5.2f}")
    print("selftest", "PASSED" if ok else "FAILED")
    return ok


if __name__ == "__main__" and sys.argv[1:] == ["selftest"]:
    sys.exit(0 if selftest() else 1)
