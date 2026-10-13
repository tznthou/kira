#!/usr/bin/env python3
"""Phase 0b 殼層狀態審查材料：總覽對照圖（亮｜暗並排）+ Safari 用的索引頁。

用法：python3 shell_review.py [--out DIR]   預設 ~/Documents/kira-v8-compare/shell-0b/<日期-時間>/（已存在就拒絕：審查圖不覆蓋）
每列 = 一個狀態（或一個候選），裁切頂列（需要時連同下方內容），1400×900 @2x 縮半。
"""
import argparse
import html
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

TOOLS = Path(__file__).resolve().parent
REF = TOOLS.parent / "v8-kirazuri-lines-sys.html"
WK = TOOLS / "wk-shot"

# (分組, 標題, 網址參數, 裁切高度 css px)
ROWS = [
    ("失敗提示與帳號（子超 2026-10-05 定 A1 / B1）", "失敗提示佔站牌的位置 · push 被拒", "state=error-push", 64),
    ("失敗提示與帳號（子超 2026-10-05 定 A1 / B1）", "帳號選單 · 展開", "state=account-menu", 150),
    ("站牌狀態", "未登入", "state=signed-out", 64),
    ("站牌狀態", "連線中", "state=connecting", 64),
    ("站牌狀態", "落後 origin 3 筆（沒東西可推）", "state=behind", 64),
    ("站牌狀態", "分岔：領先 2、落後 3", "state=diverged", 64),
    ("站牌狀態", "從沒推過 → Publish", "state=no-upstream", 64),
    ("站牌狀態", "detached HEAD", "state=detached", 64),
    ("站牌狀態", "沒有 remote", "state=no-remote", 64),
    ("站牌狀態", "macOS 全螢幕", "chrome=full", 64),
    ("改變已認可畫面 ⚑（子超定 C）", "?on=main：Push 停用（沒東西可推）", "on=main", 64),
]


def shoot(params, theme, out):
    chrome = "" if "chrome=" in params else "&chrome=on"
    url = f"{REF.as_uri()}?theme={theme}{chrome}&{params}"
    res = subprocess.run([str(WK), url, "1400", "900", str(out), "-", "ready"], capture_output=True, text=True)
    if res.returncode:
        sys.exit(f"wk-shot failed for ?{params} {theme}: {res.stderr}")


def font(size):
    # 蘋方在 macOS 是下載型資產（路徑會變），找不到就用內建的冬青黑；都沒有就報錯，不默默畫方塊
    cands = sorted(Path("/System/Library/AssetsV2").glob("com_apple_MobileAsset_Font*/*/AssetData/PingFang.ttc"))
    cands += [Path("/System/Library/Fonts/Hiragino Sans GB.ttc")]
    for f in cands:
        try:
            return ImageFont.truetype(str(f), size)
        except OSError:
            pass
    sys.exit("no CJK font found for labels")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path.home() / "Documents" / "kira-v8-compare" / "shell-0b" / datetime.now().strftime("%Y%m%d-%H%M")))
    a = ap.parse_args()
    out = Path(a.out)
    if out.exists():
        sys.exit(f"{out} already exists — review shots are kept, never overwritten; pass another --out")
    (out / "shots").mkdir(parents=True)

    cells = []
    for i, (group, title, params, h) in enumerate(ROWS):
        pair = []
        for theme in ("light", "dark"):
            p = out / "shots" / f"{i:02}-{theme}.png"
            shoot(params, theme, p)
            im = Image.open(p).crop((0, 0, 2800, h * 2))
            pair.append(im.resize((1400, h), Image.LANCZOS))
        cells.append((group, title, params, pair))
        print(f"{i:02} {title}")

    pad, head, ghead = 16, 34, 46
    W = pad * 3 + 1400 * 2
    H = pad
    last = None
    for group, _, _, pair in cells:
        H += (ghead if group != last else 0) + head + pair[0].height + pad
        last = group
    sheet = Image.new("RGB", (W, H), (72, 74, 80))
    d = ImageDraw.Draw(sheet)
    fg, fs = font(26), font(20)
    y, last = pad, None
    for group, title, params, pair in cells:
        if group != last:
            d.text((pad, y + 10), group, fill=(255, 214, 120), font=fg)
            y += ghead
            last = group
        d.text((pad, y + 6), f"{title}    ?{params}", fill=(235, 235, 235), font=fs)
        y += head
        sheet.paste(pair[0], (pad, y))
        sheet.paste(pair[1], (pad * 2 + 1400, y))
        y += pair[0].height + pad
    sheet.save(out / "overview.png")

    # Safari 索引頁：每個狀態亮暗各一個連結（Safari = WebKit，與 app 同引擎）
    items = []
    last = None
    for group, title, params, _ in cells:
        if group != last:
            items.append(f"<h2>{html.escape(group)}</h2>")
            last = group
        links = " · ".join(f'<a href="{REF.as_uri()}?theme={t}&amp;{html.escape(params)}">{t}</a>' for t in ("light", "dark"))
        items.append(f"<p><b>{html.escape(title)}</b> — {links} <code>?{html.escape(params)}</code></p>")
    extra = [
        "<h2>互動（在 Safari 裡點）</h2>",
        f'<p>推送被拒 → 再 Pull 也失敗 → 關掉提示：<a href="{REF.as_uri()}?state=diverged">?state=diverged</a>，先按 Push 再按 Pull</p>',
        f'<p>Publish 一條新分支：<a href="{REF.as_uri()}?state=no-upstream">?state=no-upstream</a></p>',
        f'<p>登出失敗一次再成功、登入失敗一次再成功：<a href="{REF.as_uri()}?fail=signout,connect">?fail=signout,connect</a></p>',
        f'<p>停用原因：<a href="{REF.as_uri()}?state=detached">?state=detached</a>，滑鼠停在淡掉的 Pull / Push 上看 tooltip 會不會出現</p>',
    ]
    page = ("<!doctype html><meta charset=utf-8><title>Phase 0b 殼層狀態審查</title>"
            "<style>body{font:15px/1.6 system-ui;margin:32px;max-width:900px}h2{margin-top:28px;font-size:17px}"
            "code{color:#666;font-size:13px}a{margin:0 2px}</style>"
            "<h1>Phase 0b 殼層狀態審查</h1><p>總覽圖：<a href=\"overview.png\">overview.png</a>（左亮右暗）</p>"
            + "".join(items) + "".join(extra))
    (out / "index.html").write_text(page, encoding="utf-8")
    print("wrote", out / "overview.png", sheet.size, "and", out / "index.html")


if __name__ == "__main__":
    main()
