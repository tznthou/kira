#!/usr/bin/env python3
"""走線寫進基準的審查材料（0b P4，組合 A）：
- drawing.png：交叉與匯流的畫法 —— 實驗室原本的畫法（每條連接線自帶套管、遠到近逐條疊）vs 基準實作（直線挖洞）
- near.png：線與線只隔 3px 的兩種 —— 同一站（Z 的水平段從 1 欄 45° 的轉角下方 3px 經過）與橋邊（Z 的轉角就在它跨過、已挖洞的直線旁）
- miniz.png：同一站那種在列界匯流（規則 5，子超 2026-10-08 定）前後
- triple.png：三條匯進同一站（1 欄 45° + 2 欄 45° + Z）時的兩種處理（子超選 b：同側全部沿列界）
- base.png：基準本身（?state=routes 全圖與兩個匯流站、?state=new-branch 按 Commit 之後）
drawing / near / triple 是裁定時的紀錄（near 的實驗室格子 = 沒有規則 5 的組合 A）
- index.html：Safari 連結（實驗室與基準）

用法：python3 mockup/tools/routes/routes_review.py [--theme light|dark] [--out DIR]
      預設 ~/Documents/kira-v8-compare/routes-0b/<日期-時間>-<theme>/（亮暗一次一個，各自一個資料夾；已存在就拒絕：審查圖不覆蓋）
先跑 lab_data.mjs。圈起來的位置 = route_cases.mjs 回報的貼近點（SVG 座標）。
"""
import argparse
import html
import json
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))
from shell_review import font  # noqa: E402

LAB = TOOLS.parent / "fidelity-out" / "route-lab" / "lab.html"
REF = TOOLS.parent / "v8-kirazuri-lines-sys.html"
WK = TOOLS / "wk-shot"
W, H = 1400, 900
A = "constrained=z&graze=zlong3&fanin=shared&reverse=gap&mark=0"
SVG_JS = 'JSON.stringify((r => ({ left: r.left, top: r.top }))(document.getElementById("lanes").getBoundingClientRect()))'
# 基準 ?state=new-branch 按 Commit：計時器當場跑完（不等 520ms），回傳 SVG 位置
COMMIT_JS = """(() => {
  window.setTimeout = (f) => { f(); return 0; };
  const msg = document.getElementById("msg");
  msg.value = "feat(graph): draw the routes";
  msg.dispatchEvent(new Event("input"));
  document.getElementById("commit-form").requestSubmit();
  const r = document.getElementById("lanes").getBoundingClientRect();
  return JSON.stringify({ left: r.left, top: r.top, rows: document.querySelectorAll(".row").length });
})()"""

# (標題, 網址, JS, 中心點 SVG 座標, 半寬, 半高)
# 中心點取自 route_cases.mjs（站的列、交叉點），不用猜
DRAWING = [
    ("react：9 條 fork 匯進 1b45e24（第 539 列上方的列界是共用段）", "lab", "repo=react&case=fanin&i=0", (185, 18318), 175, 34, 2),
    ("routes 示範：legend + gutter 匯進 a6f38d1，跨過 search", "lab", "repo=state:routes&case=fanin&i=0", (45, 262), 45, 40, 3),
    ("kira：3 個交叉點（第 134–137 列）", "lab", "repo=kira&case=cross&i=0", (49, 4610), 40, 70, 2.5),
]
NEAR = [
    ("同一站：kira 1b59a91（1 欄 45° + 3 欄 Z）", "lab", "repo=kira&case=fanin&i=0", (39, 5199)),
    ("同一站：kira 314e219（1 欄 45° + 受限 Z）", "lab", "repo=kira&case=fanin&i=1", (39, 507)),
    ("同一站：react df3c78b（1 欄 45° + 受限 Z merge + 4 欄 Z）", "lab", "repo=react&case=fanin&i=20", (219, 16011)),
    ("橋邊：routes 示範第 8 列上方（Z 的兩個轉角夾著 search 的洞）", "ref", "state=routes", (39, 272)),
    ("橋邊：react b685b40（7 條 Z 跨過同一條直線）", "lab", "repo=react&case=fanin&i=2", (36, 1734)),
]
# 迷你 Z 前後：(標題, 實驗室參數, 圈的位置)
MINIZ = [
    ("kira 1b59a91（1 欄 45° + 2 欄 45° + 3 欄 Z）", "repo=kira&case=fanin&i=0", (39, 5200)),
    ("kira 314e219（1 欄 45° + 受限 Z）", "repo=kira&case=fanin&i=1", (39, 508)),
    ("react bc10c90（1 欄 45° + 2 欄 45° + 3 欄 Z）", "repo=react&case=fanin&i=6", (179, 4112)),
    ("react df3c78b（1 欄 45° + 受限 Z merge + 4 欄 Z）", "repo=react&case=fanin&i=20", (219, 16012)),
    ("routes 示範：fix/compass（受限 Z）+ search 的 1 欄 fork 進 d83b2f6", "repo=state:routes&case=fanin&i=1", (39, 374)),
]
# 基準本身：(標題, 參數, JS 種類, 中心點, 半寬, 半高, 放大)
BASE = [
    ("?state=routes：fieldbook 14 列（站牌 + graph 區）", "state=routes", "svg", None, 0, 0, 1),
    ("routes · a6f38d1：legend（3 欄 Z）+ gutter（2 欄，併進列界改走 Z），列界跨過 search（橋）", "state=routes", "svg", (45, 262), 45, 40, 3),
    ("routes · d83b2f6：compass（受限 Z）+ search（1 欄，迷你 Z）", "state=routes", "svg", (40, 372), 45, 40, 3),
    ("?state=new-branch 按 Commit：新線第 3 欄 Z 進 dd9ba36，t15g（1 欄）迷你 Z", "state=new-branch", "commit", (45, 165), 45, 40, 3),
]
# 三條匯流：2 欄 45° 的斜線剛好經過 1 欄那條的轉角，迷你 Z 往下延伸 3px 就跨過它
TRIPLE = [
    ("kira 1b59a91", "repo=kira&case=fanin&i=0", (39, 5200)),
    ("react bc10c90", "repo=react&case=fanin&i=6", (179, 4112)),
    ("v8fixture b68b7d0", "repo=v8fixture&case=fanin&i=0", (39, 4792)),
]


def shoot(kind, params, theme, out, cross="holes", near="base"):
    if kind == "lab":
        url, js = f"{LAB.as_uri()}?{params}&{A}&cross={cross}&near={near}&theme={theme}", SVG_JS
    else:
        url, js = f"{REF.as_uri()}?theme={theme}&chrome=0&{params}", COMMIT_JS if kind == "commit" else SVG_JS
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(js)
    res = subprocess.run([str(WK), url, str(W), str(H), str(out), f.name, "ready"], capture_output=True, text=True)
    Path(f.name).unlink()
    if res.returncode:
        sys.exit(f"wk-shot failed for {url}: {res.stderr}")
    return json.loads(next(l for l in res.stdout.splitlines() if l.startswith("{")))


def crop(png, svg, center, hw, hh, zoom, mark=False):
    # 點在視窗內才裁；框碰到視窗邊緣就往內推（圈照樣圈在那個點上）
    px, py = svg["left"] + center[0], svg["top"] + center[1]
    if not (0 <= px <= W and 0 <= py <= H):
        sys.exit(f"point {center} is outside the shot {png.name} (viewport {px:.0f},{py:.0f})")
    cx, cy = min(max(px, hw), W - hw), min(max(py, hh), H - hh)
    im = Image.open(png).convert("RGB")
    box = tuple(round(2 * v) for v in (cx - hw, cy - hh, cx + hw, cy + hh))
    c = im.crop(box).resize((round(2 * hw * zoom), round(2 * hh * zoom)), Image.LANCZOS)
    if mark:
        d = ImageDraw.Draw(c)
        # 輸出 1 css px = zoom 個像素（裁 2× 截圖的 4hw 寬，縮成 2hw·zoom）
        r = 7 * zoom
        mx, my = (px - cx + hw) * zoom, (py - cy + hh) * zoom
        d.ellipse((mx - r, my - r, mx + r, my + r), outline=(232, 160, 0), width=3)
    return c


def sheet(rows, cols, title_h=40, pad=16):
    cw = max(im.width for row in rows for im in row[1])
    w = pad + len(cols) * (cw + pad)
    h = pad + 40 + sum(title_h + max(im.height for im in row[1]) + pad for row in rows)
    out = Image.new("RGB", (w, h), (72, 74, 80))
    d = ImageDraw.Draw(out)
    f, fs = font(24), font(20)
    for k, c in enumerate(cols):
        d.text((pad + k * (cw + pad), pad), c, fill=(255, 214, 120), font=f)
    y = pad + 40
    for title, ims in rows:
        d.text((pad, y + 8), title, fill=(235, 235, 235), font=fs)
        y += title_h
        for k, im in enumerate(ims):
            out.paste(im, (pad + k * (cw + pad), y))
        y += max(im.height for im in ims) + pad
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--theme", default="light")
    ap.add_argument("--out")
    a = ap.parse_args()
    if not LAB.exists():
        sys.exit("先跑 node --experimental-strip-types --no-warnings mockup/tools/routes/lab_data.mjs")
    out = Path(a.out) if a.out else Path.home() / "Documents" / "kira-v8-compare" / "routes-0b" / f"{datetime.now():%Y%m%d-%H%M}-{a.theme}"
    if out.exists():
        sys.exit(f"{out} already exists — review shots are kept, never overwritten; pass another --out")
    (out / "shots").mkdir(parents=True)

    rows = []
    for i, (title, kind, params, center, hw, hh, zoom) in enumerate(DRAWING):
        pair = []
        for cross in ("links", "holes"):
            p = out / "shots" / f"drawing-{i}-{cross}-{a.theme}.png"
            svg = shoot(kind, params, a.theme, p, cross)
            pair.append(crop(p, svg, center, hw, hh, zoom))
        rows.append((title, pair))
        print("drawing", i, title)
    sheet(rows, ["實驗室原畫法：每條連接線自帶套管，遠到近逐條疊", "基準實作：直線挖洞，線一組畫完"]).save(out / f"drawing-{a.theme}.png")

    rows = []
    for i, (title, kind, params, center) in enumerate(NEAR):
        p = out / "shots" / f"near-{i}-{a.theme}.png"
        svg = shoot(kind, params, a.theme, p)
        rows.append((title, [crop(p, svg, center, 45, 32, 4, mark=True), crop(p, svg, center, 150, 110, 1)]))
        print("near", i, title)
    sheet(rows, ["放大（圈 = 只隔 3px 的地方）", "原尺寸"]).save(out / f"near-{a.theme}.png")

    rows = []
    for i, (title, params, center) in enumerate(MINIZ):
        pair = []
        for near in ("base", "comb"):
            p = out / "shots" / f"miniz-{i}-{near}-{a.theme}.png"
            svg = shoot("lab", params, a.theme, p, near=near)
            pair.append(crop(p, svg, center, 45, 32, 4, mark=True))
        rows.append((title, pair))
        print("miniz", i, title)
    sheet(rows, ["之前：照舊 45°（轉角壓在列界上方 3px）", "列界匯流：2 欄走 Z、1 欄迷你 Z"]).save(out / f"miniz-{a.theme}.png")

    rows = []
    for i, (title, params, center) in enumerate(TRIPLE):
        cells = []
        for near in ("base", "miniz", "comb"):
            p = out / "shots" / f"triple-{i}-{near}-{a.theme}.png"
            svg = shoot("lab", params, a.theme, p, near=near)
            cells.append(crop(p, svg, center, 40, 30, 4, mark=True))
        rows.append((title, cells))
        print("triple", i, title)
    sheet(rows, ["(a) 三條時 1 欄不改（= 現在）", "迷你 Z 照套：1 欄跨過 2 欄斜線", "(b) 2 欄也改走 Z，全部沿列界"]).save(out / f"triple-{a.theme}.png")

    rows = []
    for i, (title, params, js, center, hw, hh, zoom) in enumerate(BASE):
        p = out / "shots" / f"base-{i}-{a.theme}.png"
        svg = shoot("commit" if js == "commit" else "ref", params, a.theme, p)
        if center is None:
            im = Image.open(p).convert("RGB")
            cell = im.crop((0, 0, 2000, 1060)).resize((1000, 530), Image.LANCZOS)
        else:
            cell = crop(p, svg, center, hw, hh, zoom)
        rows.append((title, [cell]))
        print("base", i, title)
    sheet(rows, ["基準 v8-kirazuri-lines-sys.html（工作副本）"]).save(out / f"base-{a.theme}.png")

    links = [
        ("基準 ?state=routes", f"{REF.as_uri()}?theme={a.theme}&state=routes"),
        ("基準 ?state=new-branch（按 Commit 看新線與列界匯流）", f"{REF.as_uri()}?theme={a.theme}&state=new-branch"),
    ] + [(f"實驗室 · {t}（挖洞）", f"{LAB.as_uri()}?{p}&{A}&cross=holes&theme={a.theme}") for t, k, p, _ in NEAR if k == "lab"] + [
        (f"實驗室 · {t}（原畫法）", f"{LAB.as_uri()}?{p}&{A}&cross=links&theme={a.theme}") for t, _, p, *_ in DRAWING]
    page = ("<!doctype html><meta charset=utf-8><title>走線寫進基準 · 審查</title>"
            "<style>body{font:15px/1.7 system-ui;margin:32px;max-width:980px}code{color:#666;font-size:13px}</style>"
            "<h1>走線寫進基準（組合 A）· 審查</h1>"
            f"<p><a href='drawing-{a.theme}.png'>drawing-{a.theme}.png</a>：交叉與匯流的畫法 · "
            f"<a href='near-{a.theme}.png'>near-{a.theme}.png</a>：只隔 3px 的地方 · "
            f"<a href='miniz-{a.theme}.png'>miniz-{a.theme}.png</a>：列界匯流前後 · "
            f"<a href='triple-{a.theme}.png'>triple-{a.theme}.png</a>：三條匯流 · "
            f"<a href='base-{a.theme}.png'>base-{a.theme}.png</a>：基準本身</p>"
            + "".join(f"<p><a href=\"{html.escape(u)}\">{html.escape(t)}</a></p>" for t, u in links))
    (out / "index.html").write_text(page, encoding="utf-8")
    print("wrote", out)


if __name__ == "__main__":
    main()
