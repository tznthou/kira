#!/usr/bin/env python3
"""新舊版對照圖：現在的 app vs v8 設計基準，同一份 demo 資料、同尺寸、同 WKWebView。

舊版 = fidelity 入口（真正的 App 元件 + fixture 資料），新版 = 基準 mockup；兩邊都不畫視窗外框
（chrome=0，app 在 webview 裡本來就沒有）。兩邊開 repo 都選 HEAD（app 從 4b 起），截圖前確認
舊版選的就是 HEAD 那一列（head-selected.js），兩邊的 diff 區才對等。
不拍真實視窗：kira 自己的歷史含私有 skill 名，fixture 資料已改寫。

用法：python3 mockup/tools/compare_old_new.py [--out DIR]
前提：vite dev server 在 http://localhost:1420（npm run dev 或 npx vite --port 1420 --strictPort）
輸出：DIR/{old,new}-{light,dark}.png（@2x）＋ compare-{light,dark}.png（左舊右新，上方標題）；
      預設 ~/Documents/kira-v8-compare/old-new/<日期-時間>/（已存在就拒絕：審查圖不覆蓋；2026-10-05 那批在
      kira-v8-compare/ 根目錄）。每期移植後重拍可看進度
"""
import argparse
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
WK = HERE / "wk-shot"
REF = HERE.parent / "v8-kirazuri-lines-sys.html"
HEAD_SELECTED = HERE / "head-selected.js"
APP = "http://localhost:1420/fidelity.html"
W, H = 1400, 900
FONTS = ["/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc",
         "/System/Library/Fonts/STHeiti Medium.ttc"]


def shoot(url, out, js="-"):
    res = subprocess.run([str(WK), url, str(W), str(H), str(out), str(js), "ready"], capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"wk-shot failed: {url}\n{res.stdout}\n{res.stderr}")
    return [l for l in res.stdout.splitlines() if l.strip() and not l.startswith("saved ")]


def font(size):
    for path in FONTS:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return None


def compose(old, new, out, dark):
    a, b = Image.open(old).convert("RGB"), Image.open(new).convert("RGB")
    gap, band = 40, 120
    bg = (28, 30, 34) if dark else (244, 243, 239)
    ink = (226, 228, 232) if dark else (40, 44, 52)
    img = Image.new("RGB", (a.width + gap + b.width, band + max(a.height, b.height)), bg)
    img.paste(a, (0, band))
    img.paste(b, (a.width + gap, band))
    f = font(56)
    if f is not None:
        d = ImageDraw.Draw(img)
        d.text((24, 30), "舊版：現在的 Kira", font=f, fill=ink)
        d.text((a.width + gap + 24, 30), "新版：v8 雲母路線圖（設計基準）", font=f, fill=ink)
    img.save(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path.home() / "Documents" / "kira-v8-compare" / "old-new" / datetime.now().strftime("%Y%m%d-%H%M")))
    out = Path(ap.parse_args().out)
    if out.exists():
        sys.exit(f"{out} already exists — review shots are kept, never overwritten; pass another --out")
    try:
        urllib.request.urlopen(APP, timeout=3)
    except OSError:
        sys.exit(f"{APP} 沒有回應：先跑 npm run dev 或 npx vite --port 1420 --strictPort")
    out.mkdir(parents=True)
    for theme in ("light", "dark"):
        old, new = out / f"old-{theme}.png", out / f"new-{theme}.png"
        checked = shoot(f"{APP}?theme={theme}", old, HEAD_SELECTED)
        if not checked or not checked[-1].startswith("head selected"):
            sys.exit(f"舊版選的不是 HEAD：{checked}")
        shoot(f"{REF.as_uri()}?theme={theme}&chrome=0", new)
        compose(old, new, out / f"compare-{theme}.png", theme == "dark")
        print(f"{theme}: old-{theme}.png new-{theme}.png compare-{theme}.png")
    print(out)


if __name__ == "__main__":
    main()
