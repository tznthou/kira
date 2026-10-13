#!/usr/bin/env python3
"""Phase 0b P5 側欄 / 右欄 / diff 狀態審查材料：總覽對照圖（亮｜暗並排）+ Safari 用的索引頁。

用法：python3 panel_review.py [--out DIR]   預設 ~/Documents/kira-v8-compare/panel-0b/<日期-時間>/
每列 = 一個狀態，裁切該區（css px 框），@2x 縮半；要先操作的（點分支、按 Refresh）用 js 先做再拍。
審查圖是子超的創作故事素材（2026-10-08）：每次重產寫進新的日期資料夾，已存在就拒絕，不覆蓋舊的。
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

# 裁切框（css px）：1400 × 900
SIDE = (0, 0, 250, 900)        # 站牌左段 + 側欄
PANE = (996, 56, 1400, 560)     # 右欄
DIFF = (250, 516, 1400, 900)    # diff 區
TOP_SIDE = (0, 0, 1000, 560)    # 站牌 + 側欄 + graph
FULL = (0, 0, 1400, 900)
# 1200 × 800
PANE_1200 = (850, 56, 1200, 500)
DIFF_1200 = (212, 455, 1200, 800)

CLICK = 'document.querySelector(`#branch-list .branch-btn[data-branch="{}"]`).click();'
SCROLL_END = 'const g = document.getElementById("graph-scroll"); g.scrollTop = g.scrollHeight;'
SCROLL_DIFF = 'const d = document.getElementById("diff"); d.scrollTop = [...d.querySelectorAll(".dfile")][2].offsetTop - 12;'
# 先等 diff 畫完（renderDiff 180ms 後才填）再捲；wk-shot 的 js 在 ready 之後才跑，這時已經畫好
CLICK_ROW = 'document.getElementById("r-{}").click();'

# (分組, 標題, 網址參數, 視窗尺寸, 裁切框, 先跑的 js)
ROWS = [
    ("剛開 repo", "opening：什麼都還沒回來 —— graph / 分支 / Changes 骨架，Push / Pull 停用（upstream 未知）", "state=opening", (1400, 900), FULL, None),
    ("剛開 repo", "同上 · PR 分頁骨架", "state=opening&tab=prs", (1400, 900), PANE, None),
    ("側欄", "視窗外的分支 feat/t9d-watcher（決策 C）：虛線空心圈，跟寄宿的 release/0.1（實線空心圈）分得出來；其他分支的 ↑↓ 只有灰字，金箔留給你所在的線", "state=lodger", (1400, 900), SIDE, None),
    ("側欄", "空 repo：No branches yet，沒有遠端分支就不畫 Remote 標題", "state=empty", (1400, 900), SIDE, None),
    ("側欄", "upstream 被 prune：計數位放 pruned（title 寫原因），沒有可比的就沒有 ↑↓", "state=pruned", (1400, 900), SIDE, None),
    ("側欄", "點寄宿分支 release/0.1（決策 D）：自己的字母 A（最後一段 0.1 沒有字母 → 字母表第一個沒用到的）+ 偏好色辰砂，強調色跟著", "state=lodger", (1400, 900), TOP_SIDE, CLICK.format("release/0.1")),
    ("側欄", "點視窗外分支 feat/t9d-watcher：HEAD 在視窗外，頁尾說你在更下面；HEAD 的字母優先 → 它拿 T、t15g 改 G", "", (1400, 900), TOP_SIDE, CLICK.format("feat/t9d-watcher") + SCROLL_END),
    ("側欄", "checkout 失敗（DIRTY_TREE）：站牌提示，× 後焦點回那一列（app 的對話框失敗也關）", "state=error-checkout", (1400, 900), TOP_SIDE, None),
    ("側欄", "Refresh 中：列不變淡（背景 refresh 不閃），title 寫原因；+ New branch 照停用樣式", "", (1400, 900), TOP_SIDE, 'document.getElementById("refresh").click();'),
    ("Changes", "衝突：Conflicted 區段在最上面（沒有 stage 鈕）+ 條；git short status（UU / DU），Commit 停用", "state=conflict", (1400, 900), PANE, None),
    ("Changes", "unstaged 超過 5,000：計數 5,000+、條、Stage all 停用（title 說明）", "state=many-changes", (1400, 900), PANE, None),
    ("Changes", "status 讀取失敗：區內 + Retry，不留舊清單，Commit 停用", "state=changes-error", (1400, 900), PANE, None),
    ("Changes", "commit 失敗（GIT_IDENTITY_MISSING）：站牌提示，訊息留著", "state=error-commit", (1400, 900), (0, 0, 1400, 560), None),
    ("Pull Requests", "載入中", "state=prs-loading&tab=prs", (1400, 900), PANE, None),
    ("Pull Requests", "未登入：區內 + Connect GitHub（登入成功後重抓列表）", "state=signed-out&tab=prs", (1400, 900), PANE, None),
    ("Pull Requests", "同上 · 1200 寬", "state=signed-out&tab=prs", (1200, 800), PANE_1200, None),
    ("Pull Requests", "非 GitHub（沒 remote 或 origin 不在 github.com）", "state=no-remote&tab=prs", (1400, 900), PANE, None),
    ("Pull Requests", "沒有 open PR", "state=prs-empty&tab=prs", (1400, 900), PANE, None),
    ("Pull Requests", "rate limit：寫幾點可以再試（時刻不會過期）+ Retry", "state=prs-rate&tab=prs", (1400, 900), PANE, None),
    ("Pull Requests", "讀取失敗 + Retry", "state=prs-error&tab=prs", (1400, 900), PANE, None),
    ("Pull Requests", "展開的 PR 畫全部檔案（基準原本只畫第一個）", "tab=prs", (1400, 900), PANE, None),
    ("Pull Requests", "PR diff 載入中 / 讀取失敗 / 沒有檔案（下面三列）", "state=pr-diff-loading&tab=prs", (1400, 900), PANE, None),
    ("Pull Requests", "PR diff 讀取失敗：一行 + Retry", "state=pr-diff-error&tab=prs", (1400, 900), PANE, None),
    ("Pull Requests", "PR diff 沒有檔案", "state=pr-diff-empty&tab=prs", (1400, 900), PANE, None),
    ("diff", "收合（#36 的 merge）：頂端條數收合的檔；兩個 minified bundle 先用掉字元總量", "state=diff-limits", (1400, 900), DIFF, None),
    ("diff", "同上 · 捲下去：超過 10 MB / 總量收合（路徑要引號 + :(literal)）/ 單檔收合 / 沒有文字變更", "state=diff-limits", (1400, 900), DIFF, SCROLL_DIFF),
    ("diff", "同上 · 1200 寬", "state=diff-limits", (1200, 800), DIFF_1200, SCROLL_DIFF),
    ("diff", "只有一個 parent 的 commit：指令不帶 -m --first-parent", "state=diff-limits", (1400, 900), DIFF, CLICK_ROW.format("c9e41f2")),
    ("diff", "超過 500 個檔：頂端條", "state=diff-many", (1400, 900), DIFF, None),
    ("diff", "空 commit", "state=diff-empty", (1400, 900), DIFF, None),
    ("diff", "讀取失敗 + Retry", "state=diff-error", (1400, 900), DIFF, None),
    ("diff", "空 repo：沒有站可選，不寫鍵盤提示", "state=empty", (1400, 900), DIFF, None),
]


def shoot(params, theme, size, out, js, jsdir):
    url = f"{REF.as_uri()}?theme={theme}&chrome=on" + (f"&{params}" if params else "")
    jsfile = "-"
    if js:
        jsfile = jsdir / f"{out.stem}.js"
        jsfile.write_text(f"(() => {{ {js} return 'ok'; }})()", encoding="utf-8")
    res = subprocess.run([str(WK), url, str(size[0]), str(size[1]), str(out), str(jsfile), "ready"], capture_output=True, text=True)
    if res.returncode:
        sys.exit(f"wk-shot failed for ?{params} {theme}: {res.stderr}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path.home() / "Documents" / "kira-v8-compare" / "panel-0b" / datetime.now().strftime("%Y%m%d-%H%M")))
    a = ap.parse_args()
    out = Path(a.out)
    if out.exists():
        sys.exit(f"{out} already exists — review shots are kept, never overwritten; pass another --out")
    (out / "shots").mkdir(parents=True)
    (out / "js").mkdir()

    cells = []
    for i, (group, title, params, size, box, js) in enumerate(ROWS):
        pair = []
        for theme in ("light", "dark"):
            p = out / "shots" / f"{i:02}-{theme}.png"
            shoot(params, theme, size, p, js, out / "js")
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
        links = " · ".join(f'<a href="{REF.as_uri()}?theme={t}' + (f"&amp;{html.escape(params)}" if params else "") + f'">{t}</a>' for t in ("light", "dark"))
        items.append(f"<p><b>{html.escape(title)}</b> — {links} <code>?{html.escape(params)}</code></p>")
    u = REF.as_uri()
    extra = [
        "<h2>互動（在 Safari 裡點）</h2>",
        f'<p>寄宿分支被點：<a href="{u}?state=lodger">?state=lodger</a>，點側欄 release/0.1 → 站牌 (A) release/0.1、強調色辰砂、HEAD pill 在 63421cf 帶 A、它的 origin 空心 A；再點 main → 回到空心無字</p>',
        f'<p>視窗外分支被點：<a href="{u}">預設</a>，點 feat/t9d-watcher → 金箔消失、捲到底頁尾「You are further down the line.」、feat/t15g-graph-density 的字母變 G；點 main → 變回 T</p>',
        f'<p>按了才失敗 → 站牌：<a href="{u}?fail=checkout,stage,commit">?fail=checkout,stage,commit</a>，點 fix/toolbar-jump、點某檔的 +、打訊息 Commit；各自出提示，× 後焦點回剛按的</p>',
        f'<p>讀不到 → 區內：<a href="{u}?fail=status">?fail=status</a>，按 Refresh → Changes 區「Couldn\'t read your changes.」（站牌沒有提示）→ Retry</p>',
        f'<p>衝突解完：<a href="{u}?state=conflict">?state=conflict</a>，按 Refresh（當作已在終端機 git add）→ Conflicted 消失、三個檔進 Staged、打訊息後 Commit 可按</p>',
        f'<p>PR 分頁登入：<a href="{u}?state=signed-out&amp;tab=prs">?state=signed-out&amp;tab=prs</a>，按區內 Connect GitHub → 骨架 → 列表（app 現在要按 Refresh 才重抓）</p>',
        f'<p>收合指令：<a href="{u}?state=diff-limits">?state=diff-limits</a>，點指令一下就整段選取（user-select: all）</p>',
    ]
    page = ("<!doctype html><meta charset=utf-8><title>Phase 0b 側欄 / 右欄 / diff 狀態審查</title>"
            "<style>body{font:15px/1.6 system-ui;margin:32px;max-width:980px}h2{margin-top:28px;font-size:17px}"
            "code{color:#666;font-size:13px}a{margin:0 2px}</style>"
            "<h1>Phase 0b 側欄 / 右欄 / diff 狀態審查（P5 前）</h1>"
            "<p>總覽圖：<a href=\"overview.png\">overview.png</a>（左亮右暗）</p>"
            + "".join(items) + "".join(extra))
    (out / "index.html").write_text(page, encoding="utf-8")
    print("wrote", out / "overview.png", sheet.size, "and", out / "index.html")


if __name__ == "__main__":
    main()
