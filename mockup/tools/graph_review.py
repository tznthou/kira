#!/usr/bin/env python3
"""Phase 0b P4 graph 狀態審查材料：總覽對照圖（亮｜暗並排）+ Safari 用的索引頁。

用法：python3 graph_review.py [--out DIR]   預設 ~/Documents/kira-v8-compare/graph-0b/<日期-時間>/（已存在就拒絕：審查圖不覆蓋）
每列 = 一個狀態（或一個候選），裁切站牌 + graph 區（css px 框），@2x 縮半。
"""
import argparse
import html
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from shell_review import font  # noqa: E402

REF = TOOLS.parent / "v8-kirazuri-lines-sys.html"
WK = TOOLS / "wk-shot"

TOP = (0, 0, 1000, 530)       # 1400×900：站牌 + graph 區
TOP_1200 = (0, 0, 860, 470)   # 1200×800：同上
# (分組, 標題, 網址參數, 視窗尺寸, 裁切框 css px)
ROWS = [
    ("歷史的盡頭", "截斷（預設資料本身就是截斷的視窗）· 捲到底：延伸的線淡出 + 頁尾", "scroll=end", (1400, 900), TOP),
    ("歷史的盡頭", "第一批 commit：根 commit 是終點橫槓（線的兩端同款）", "state=young", (1400, 900), TOP),
    ("歷史的盡頭", "HEAD 在視窗外 · 捲到底：頁尾多一行金箔提示，圖上沒有金箔", "state=head-beyond&scroll=end", (1400, 900), TOP),
    ("開 repo", "載入中：graph 還沒回來（其餘已回來；Switch repo / Open / Clone 等開完）", "state=loading", (1400, 900), TOP),
    ("開 repo", "空 repo（git init 後還沒有 commit）· 站牌顯示分支名（子超 Q1）", "state=empty", (1400, 900), TOP),
    ("寄宿 ref（路線規則決策 C / D）", "剛開的分支 feat/v8-graph：金箔在主幹站、pill 帶自己的字母、強調色 = 自己的偏好色", "state=new-branch", (1400, 900), TOP),
    ("寄宿 ref（路線規則決策 C / D）", "release/0.1 停在 #36 的 merge 上，沒有自己的線 → 空心無字圓標（子超定）", "state=lodger", (1400, 900), TOP),
    ("ref 的寫法（子超定）", "同一條線的 remote 停在同一站只寫 origin（預設畫面 e81d6b0、dd9ba36 兩列因此改了）", "", (1400, 900), TOP),
    ("ref 的寫法（子超定）", "長名稱尾端截斷到 32 字；main 的 tip 六個 ref 超過一列 40 字，最後一個收成 +1", "state=long-refs", (1400, 900), TOP),
    ("ref 的寫法（子超定）", "同上 · 1200 寬", "state=long-refs", (1200, 800), TOP_1200),
    ("detached（子超定）", "HEAD 停的那站掛 (T) HEAD pill（圓標 = 那站的線）", "state=detached", (1400, 900), TOP),
    ("走線（組合 A + 列界匯流，子超定）", "fieldbook 14 列：Z、受限 Z、反向 merge 走空隙、橋（直段挖洞）、列界匯流（gutter 2 欄改 Z、search 1 欄迷你 Z）", "state=routes", (1400, 900), TOP),
    ("走線（組合 A + 列界匯流，子超定）", "同上 · 捲到底：main 延伸到視窗外淡出", "state=routes&scroll=end", (1400, 900), TOP),
]


def shoot(params, theme, size, out):
    url = f"{REF.as_uri()}?theme={theme}&chrome=on&{params}"
    res = subprocess.run([str(WK), url, str(size[0]), str(size[1]), str(out), "-", "ready"], capture_output=True, text=True)
    if res.returncode:
        sys.exit(f"wk-shot failed for ?{params} {theme}: {res.stderr}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path.home() / "Documents" / "kira-v8-compare" / "graph-0b" / datetime.now().strftime("%Y%m%d-%H%M")))
    a = ap.parse_args()
    out = Path(a.out)
    if out.exists():
        sys.exit(f"{out} already exists — review shots are kept, never overwritten; pass another --out")
    (out / "shots").mkdir(parents=True)

    cells = []
    for i, (group, title, params, size, box) in enumerate(ROWS):
        pair = []
        for theme in ("light", "dark"):
            p = out / "shots" / f"{i:02}-{theme}.png"
            shoot(params, theme, size, p)
            im = Image.open(p).crop(tuple(v * 2 for v in box))
            pair.append(im.resize((box[2] - box[0], box[3] - box[1]), Image.LANCZOS))
        cells.append((group, title, params, size, pair))
        print(f"{i:02} {title}")

    pad, head, ghead = 16, 34, 46
    cw = max(c[4][0].width for c in cells)
    W = pad * 3 + cw * 2
    H, last = pad, None
    for group, _, _, _, pair in cells:
        H += (ghead if group != last else 0) + head + pair[0].height + pad
        last = group
    sheet = Image.new("RGB", (W, H), (72, 74, 80))
    d = ImageDraw.Draw(sheet)
    fg, fs = font(26), font(20)
    y, last = pad, None
    for group, title, params, size, pair in cells:
        if group != last:
            d.text((pad, y + 10), group, fill=(255, 214, 120), font=fg)
            y += ghead
            last = group
        d.text((pad, y + 6), f"{title}    ?{params}  ({size[0]}×{size[1]})", fill=(235, 235, 235), font=fs)
        y += head
        sheet.paste(pair[0], (pad, y))
        sheet.paste(pair[1], (pad * 2 + cw, y))
        y += pair[0].height + pad
    sheet.save(out / "overview.png")

    # Safari 索引頁：每個狀態亮暗各一個連結（Safari = WebKit，與 app 同引擎）
    items, last = [], None
    for group, title, params, _, _ in cells:
        if group != last:
            items.append(f"<h2>{html.escape(group)}</h2>")
            last = group
        links = " · ".join(f'<a href="{REF.as_uri()}?theme={t}&amp;{html.escape(params)}">{t}</a>' for t in ("light", "dark"))
        items.append(f"<p><b>{html.escape(title)}</b> — {links} <code>?{html.escape(params)}</code></p>")
    extra = [
        "<h2>互動（在 Safari 裡點）</h2>",
        f'<p>空 repo 的第一筆 commit：<a href="{REF.as_uri()}?state=empty">?state=empty</a>，按 Stage all、打訊息、Commit → 出現第一站與金箔，站牌的「No commits yet」消失</p>',
        f'<p>剛開的分支第一筆 commit：<a href="{REF.as_uri()}?state=new-branch">?state=new-branch</a>，Commit → feat/v8-graph 長出自己的線（第 3 欄走 Z 進 dd9ba36；t15g 跨 1 欄的 45° 依列界匯流改走迷你 Z，併進同一條列界）</p>',
        f'<p>推送後的 origin：<a href="{REF.as_uri()}">預設</a>，按 Push → HEAD 那列變成「(T) feat/t15g-graph-density (T) origin」</p>',
        f'<p>長 ref 的完整名稱：<a href="{REF.as_uri()}?state=long-refs">?state=long-refs</a>，滑鼠停在被截斷的名稱、origin 與 +1 上看 tooltip</p>',
    ]
    page = ("<!doctype html><meta charset=utf-8><title>Phase 0b graph 狀態審查</title>"
            "<style>body{font:15px/1.6 system-ui;margin:32px;max-width:960px}h2{margin-top:28px;font-size:17px}"
            "code{color:#666;font-size:13px}a{margin:0 2px}</style>"
            "<h1>Phase 0b graph 狀態審查（P4 前）</h1>"
            "<p>總覽圖：<a href=\"overview.png\">overview.png</a>（左亮右暗）</p>"
            + "".join(items) + "".join(extra))
    (out / "index.html").write_text(page, encoding="utf-8")
    print("wrote", out / "overview.png", sheet.size, "and", out / "index.html")


if __name__ == "__main__":
    main()
