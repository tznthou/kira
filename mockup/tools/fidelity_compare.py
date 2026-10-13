#!/usr/bin/env python3
"""v8 複刻 D1：基準 mockup vs app（fidelity 入口）逐區像素比對。

用法：python3 fidelity_compare.py [--sizes 1400x900,1200x800] [--themes light,dark]
                                   [--states default,on=main,behind,...] [--regions topbar,...] [--out DIR]
前提：vite dev server 跑在 http://localhost:1420（npx vite --port 1420 --strictPort）
輸出：DIR/<state>/<size>-<theme>/{ref,app,diff}.png 與各區 crop/diff；stdout 印結果表；DIR/report.md
判定：每區 0 個差異像素才算通過（D1）。門檻 0 的依據：同一頁兩次獨立渲染 0 像素差異（2026-10-04）。
區塊邊界從基準的 DOM 量（基準是權威），取相鄰 sheet 間隙的中線；報告記錄基準的 commit。
--states：每格是一個狀態，基準與 app 帶同一組網址參數。default = 不帶；含 = 的照原樣（on=main、
          chrome=full）；其他當 ?state=<名>。基準預設加 chrome=0（不畫假紅綠燈），格子自己帶 chrome= 時
          不加——URLSearchParams.get 取第一個值，先塞的 chrome=0 會蓋掉 chrome=full。
每張 app 截圖後讀 window.__fidelityLog（開機錯誤、未 mock 的 IPC、console.error）：非空即 FAIL。
"""
import argparse
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
MOCKUP = TOOLS.parent
REF_FILE = MOCKUP / "v8-kirazuri-lines-sys.html"
WK = TOOLS / "wk-shot"
APP_URL = "http://localhost:1420/fidelity.html"
REGION_JS = TOOLS / "regions.js"
LOG_JS = TOOLS / "fidelity-log.js"
SCALE = 2
REGIONS = ("topbar", "sidebar", "graph", "pane", "diff")


def sh(cmd, check=True):
    res = subprocess.run(cmd, capture_output=True, text=True)
    if check and res.returncode != 0:
        sys.exit(f"FAILED: {' '.join(map(str, cmd))}\n{res.stdout}\n{res.stderr}")
    return res


def shoot(url, w, h, out, js=None):
    res = sh([str(WK), url, str(w), str(h), str(out), str(js) if js else "-", "ready"])
    lines = res.stdout.splitlines()
    payload = "\n".join(l for l in lines if not l.startswith("saved "))
    return payload


def regions_from(rects):
    vw, vh = rects["vw"], rects["vh"]
    top, side, graph, pane, diff = (rects[k] for k in ("topbar", "sidebar", "graph", "pane", "diff"))
    y_top = (top[1] + top[3] + side[1]) / 2
    x_side = (side[0] + side[2] + graph[0]) / 2
    x_pane = (graph[0] + graph[2] + pane[0]) / 2
    y_diff = (graph[1] + graph[3] + diff[1]) / 2
    css = {
        "topbar": (0, 0, vw, y_top),
        "sidebar": (0, y_top, x_side, vh - y_top),
        "graph": (x_side, y_top, x_pane - x_side, y_diff - y_top),
        "pane": (x_pane, y_top, vw - x_pane, y_diff - y_top),
        "diff": (x_side, y_diff, vw - x_side, vh - y_diff),
    }
    return {k: tuple(round(v * SCALE) for v in r) for k, r in css.items()}


def diff_pixels(a, b, out):
    """任一 RGB 通道不同即算一個差異像素；out 寫出差異遮罩（白 = 不同）。
    不用 `compare -metric AE`：ImageMagick 7.1.2 的 AE 會低估（對純紅圖只報 65%），
    拿來當 0 像素門檻會讓差異靜默溜過。
    兩邊先轉 sRGB：IM 會把全灰的 PNG 存成單通道灰階，灰階與彩色做 difference 只剩灰階通道，
    藍色通道 1/255 的差異會被吃掉（selftest 就是在抓這個）。"""
    res = sh(["magick", "(", str(a), "-colorspace", "sRGB", "-alpha", "off", ")",
              "(", str(b), "-colorspace", "sRGB", "-alpha", "off", ")",
              "-compose", "difference", "-composite",
              "-channel", "RGB", "-separate", "+channel", "-evaluate-sequence", "max", "-threshold", "0",
              "-write", str(out), "-precision", "16", "-format", "%[fx:round(mean*w*h)]", "info:"])
    return int(float(res.stdout.strip()))


def selftest(tmp):
    """計數器本身要先過：同圖 0、只差 1/255 的兩張純色圖必須 100% 不同。"""
    a, b = tmp / "st-a.png", tmp / "st-b.png"
    sh(["magick", "-size", "10x10", "xc:#ffffff", str(a)])
    sh(["magick", "-size", "10x10", "xc:#fffffe", str(b)])
    same, off_by_one = diff_pixels(a, a, tmp / "st-m1.png"), diff_pixels(a, b, tmp / "st-m2.png")
    if same != 0 or off_by_one != 100:
        sys.exit(f"diff counter selftest FAILED (same={same}, off-by-one={off_by_one}/100)")


def crop(src, box, out):
    x, y, w, h = box
    sh(["magick", str(src), "-crop", f"{w}x{h}+{x}+{y}", "+repage", f"PNG32:{out}"])


def state_params(cell):
    """一格狀態 → 網址參數（基準與 app 共用）"""
    if cell == "default":
        return ""
    return cell if "=" in cell else f"state={cell}"


def slug(cell):
    return cell.replace("=", "-").replace("&", "+")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sizes", default="1400x900,1200x800")
    ap.add_argument("--themes", default="light,dark")
    ap.add_argument("--states", default="default", help="comma-separated: default, on=<branch>, chrome=full, <state>")
    ap.add_argument("--regions", default=",".join(REGIONS), help=f"comma-separated subset of {','.join(REGIONS)}")
    ap.add_argument("--out", default=str(MOCKUP / "fidelity-out" / datetime.now().strftime("%Y%m%d-%H%M%S")))
    a = ap.parse_args()
    regions = a.regions.split(",")
    unknown = [r for r in regions if r not in REGIONS]
    if unknown:
        sys.exit(f"unknown region(s): {', '.join(unknown)} (choose from {', '.join(REGIONS)})")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    selftest(out)

    # 最後一次改到基準檔的 commit（不是 repo 的 HEAD：只動 src 或工具的 commit 不算換基準）
    ref_rev = sh(["git", "-C", str(MOCKUP), "log", "-1", "--format=%h", "--", REF_FILE.name]).stdout.strip()
    dirty = bool(sh(["git", "-C", str(MOCKUP), "status", "--porcelain", "--", REF_FILE.name]).stdout.strip())
    ref_label = f"{ref_rev}{' (+uncommitted edits)' if dirty else ''}"

    rows, logs = [], []
    cells = a.states.split(",")
    for cell in cells:
        params = state_params(cell)
        ref_q = ("" if "chrome=" in params else "&chrome=0") + (f"&{params}" if params else "")
        app_q = f"&{params}" if params else ""
        for size in a.sizes.split(","):
            w, h = (int(v) for v in size.split("x"))
            for theme in a.themes.split(","):
                d = out / slug(cell) / f"{size}-{theme}"
                d.mkdir(parents=True, exist_ok=True)
                rects = json.loads(shoot(f"{REF_FILE.as_uri()}?theme={theme}{ref_q}", w, h, d / "ref.png", REGION_JS))
                log = json.loads(shoot(f"{APP_URL}?theme={theme}{app_q}", w, h, d / "app.png", LOG_JS))
                if log != []:
                    logs.append((cell, size, theme, log))
                total = diff_pixels(d / "ref.png", d / "app.png", d / "diff.png")
                for name, box in regions_from(rects).items():
                    if name not in regions:
                        continue
                    crop(d / "ref.png", box, d / f"{name}-ref.png")
                    crop(d / "app.png", box, d / f"{name}-app.png")
                    n = diff_pixels(d / f"{name}-ref.png", d / f"{name}-app.png", d / f"{name}-diff.png")
                    area = box[2] * box[3]
                    rows.append((cell, size, theme, name, n, area))
                rows.append((cell, size, theme, "(whole)", total, w * h * SCALE * SCALE))

    lines = [f"# v8 fidelity D1 — {datetime.now():%Y-%m-%d %H:%M}", "",
             f"reference: `v8-kirazuri-lines-sys.html` @ mockup `{ref_label}` · app: `{APP_URL}` · pass = 0 px", "",
             "| state | size | theme | region | diff px | % | result |", "|---|---|---|---|---:|---:|---|"]
    failed = 0
    for cell, size, theme, name, n, area in rows:
        ok = n == 0
        failed += (not ok) and name != "(whole)"
        lines.append(f"| {cell} | {size} | {theme} | {name} | {n} | {100 * n / area:.2f} | {'PASS' if ok else 'FAIL'} |")
    shots = len(cells) * len(a.sizes.split(",")) * len(a.themes.split(","))
    lines += ["", f"regions failing: {failed}/{len(regions) * shots}"]
    lines += [f"app logs not empty: {len(logs)}/{shots}"] + [f"- {c} {s} {t}: {l}" for c, s, t, l in logs]
    report = "\n".join(lines)
    (out / "report.md").write_text(report + "\n", encoding="utf-8")
    print(report)
    print(f"\nartifacts: {out}")
    sys.exit(1 if failed or logs else 0)


if __name__ == "__main__":
    main()
