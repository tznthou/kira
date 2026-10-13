#!/usr/bin/env python3
"""走線實驗室的審查材料：每一類一張對照表（列 = 實例、欄 = 候選規則），加 Safari 索引頁。

用法：python3 mockup/tools/routes/lab_review.py [--theme light|dark] [--out DIR]
先跑 lab_data.mjs（產生 mockup/fidelity-out/route-lab/ 的 lab.html + 資料）。預設輸出 ~/Documents/kira-v8-compare/route-lab/<日期-時間>-<theme>/
（亮暗一次一個，各自一個資料夾；已存在就拒絕：審查圖不覆蓋）。
每格 = 實驗室跳到該實例後的截圖，以實例框（lab 回報的 __lab.box()）加邊距裁切，@2x 不縮。
"""
import argparse
import html
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))
from shell_review import font  # noqa: E402

LAB = TOOLS.parent / "fidelity-out" / "route-lab" / "lab.html"
WK = TOOLS / "wk-shot"
W, H = 1400, 900

# 類別：(標題, 參數名, 候選, 實例 [(repo, i)])
CATS = [
    ("受限：相鄰幾列之間要跨好幾欄（dx > dy）", "constrained", ["base", "z", "flat", "steep"],
     [("react", 0), ("kira", 0), ("kira", 2)]),
    ("同側進站：好幾條 fork 從同一側進同一站", "fanin", ["base", "shared", "comb", "capsule", "fan"],
     [("react", 0), ("react", 6), ("kira", 0)]),
    ("交叉：斜線穿過別條線的直線", "cross", ["none", "runs", "links"],
     [("react", 2), ("react", 6), ("kira", 0)]),
    ("反向 merge：main 合進分支，parent 那欄有直通的線", "reverse", ["overlap", "gap", "steep"],
     [("kira", 0), ("kira", 1)]),
    ("擦站：長斜線經過別條線的站心附近", "graze", ["base", "zlong", "zlong3"],
     [("react", 0), ("react", 3)]),
]
# 組合：五類一起定時的整體樣子（欄 = 組合、列 = 區域）
COMBOS = [
    ("現行", ""),
    ("A：45° 為主，跨 3 欄起走 Z；同側共用斜線", "constrained=z&graze=zlong3&fanin=shared&cross=links&reverse=gap"),
    ("B：同 A，同側進站用膠囊", "constrained=z&graze=zlong3&fanin=capsule&cross=links&reverse=gap"),
    ("C：同 A，同側進站用扇形", "constrained=z&graze=zlong3&fanin=fan&cross=links&reverse=gap"),
    ("D：跨 2 欄起一律走 Z；同側共用斜線", "constrained=z&graze=zlong&fanin=shared&cross=links&reverse=gap"),
]
REGIONS = [("react", "fanin", 0), ("react", "graze", 3), ("react", "cross", 2), ("kira", "reverse", 0)]
LABELS = {
    "constrained": {"base": "現行：往回折", "z": "Z 形：列界上走水平", "flat": "45° 後水平進站", "steep": "直線斜接（非 45°）"},
    "fanin": {"base": "現行：資料順序", "shared": "共用斜線，近欄在上", "comb": "近欄 45°，其餘水平進站", "capsule": "膠囊轉乘站", "fan": "扇形（非 45°）"},
    "cross": {"none": "現行：無橋", "runs": "直線在上（斜線斷開）", "links": "斜線在上（直線斷開）"},
    "reverse": {"overlap": "現行：疊在 parent 那欄", "gap": "走欄間空隙", "steep": "直線斜接（非 45°）"},
    "graze": {"base": "現行：長斜線", "zlong": "跨 2 欄以上一律 Z 形", "zlong3": "跨 3 欄以上一律 Z 形"},
}
INFO_JS = "JSON.stringify({box: window.__lab.box(), note: window.__lab.focus && window.__lab.focus.note, m: window.__lab.measure})"


def shoot(params, out, js):
    url = f"{LAB.as_uri()}?{params}"
    res = subprocess.run([str(WK), url, str(W), str(H), str(out), str(js), "ready"], capture_output=True, text=True)
    if res.returncode:
        sys.exit(f"wk-shot failed for ?{params}: {res.stderr}")
    line = next(l for l in res.stdout.splitlines() if l.startswith("{"))
    return json.loads(line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--theme", default="light", choices=["light", "dark"])
    ap.add_argument("--out")
    a = ap.parse_args()
    if not LAB.exists():
        sys.exit(f"{LAB} 不在：先跑 node --experimental-strip-types --no-warnings mockup/tools/routes/lab_data.mjs")
    out = Path(a.out) if a.out else Path.home() / "Documents" / "kira-v8-compare" / "route-lab" / f"{datetime.now():%Y%m%d-%H%M}-{a.theme}"
    if out.exists():
        sys.exit(f"{out} already exists — review shots are kept, never overwritten; pass another --out")
    (out / "shots").mkdir(parents=True)
    js = out / "shots" / "info.js"
    js.write_text(INFO_JS, encoding="utf-8")
    fg, fs = font(30), font(22)
    index = []
    for title, key, cands, insts in CATS:
        rows = []
        for repo, i in insts:
            # 同一個實例在各候選下用同一個裁切框（取現行規則下的實例框）
            info = shoot(f"repo={repo}&case={key}&i={i}&theme={a.theme}", out / "shots" / f"{key}-{repo}-{i}-ref.png", js)
            # 實驗室回報的框 = 這個實例的列窗（見 lab.html 的 windowOf），各候選同一個框
            b = info["box"]
            x0, x1, y0, y1 = b["x0"], b["x1"], b["y0"], b["y1"]
            cells = []
            for c in cands:
                p = out / "shots" / f"{key}-{repo}-{i}-{c}-{a.theme}.png"
                m = shoot(f"repo={repo}&case={key}&i={i}&{key}={c}&theme={a.theme}", p, js)["m"]
                cells.append((c, Image.open(p).crop((int(x0 * 2), int(y0 * 2), int(x1 * 2), int(y1 * 2))), m))
            rows.append((repo, i, info["note"], cells))
            print(f"{key} {repo}#{i}: {info['note']}")
        pad, head, rowhead, foot = 24, 64, 46, 30
        cw = max(c[1].width for r in rows for c in r[3])
        Wsheet = pad + len(cands) * (cw + pad)
        Hsheet = pad + head + sum(rowhead + max(c[1].height for c in r[3]) + foot + pad for r in rows)
        sheet = Image.new("RGB", (Wsheet, Hsheet), (72, 74, 80))
        d = ImageDraw.Draw(sheet)
        d.text((pad, pad), title, fill=(255, 214, 120), font=fg)
        for k, c in enumerate(cands):
            d.text((pad + k * (cw + pad), pad + 40), LABELS[key][c], fill=(235, 235, 235), font=fs)
        y = pad + head
        for repo, i, note, cells in rows:
            d.text((pad, y + 10), f"{repo} #{i}：{note}", fill=(200, 220, 255), font=fs)
            y += rowhead
            for k, (c, im, m) in enumerate(cells):
                xk = pad + k * (cw + pad)
                sheet.paste(im, (xk, y))
                d.text((xk, y + im.height + 4), f"整個 repo：往回折 {m['back']} · 不同線重疊 {m['overlaps']} · 交叉 {m['crossings']} · 擦站 {m['grazes']}",
                       fill=(205, 205, 205), font=font(18))
            y += max(c[1].height for c in cells) + foot + pad
        sheet.save(out / f"{key}-{a.theme}.png")
        links = []
        for repo, i, note, _ in rows:
            ls = " · ".join(f'<a href="{LAB.as_uri()}?repo={repo}&amp;case={key}&amp;i={i}&amp;{key}={c}&amp;theme={a.theme}">{html.escape(LABELS[key][c])}</a>' for c in cands)
            links.append(f"<p><b>{repo} #{i}</b> {html.escape(note or '')}：{ls}</p>")
        index.append(f"<h2>{html.escape(title)}</h2><p><a href=\"{key}-{a.theme}.png\">對照表</a></p>" + "".join(links))
        print(f"wrote {out / f'{key}-{a.theme}.png'} {sheet.size}")
    # 組合表：每個區域用「現行」的實例框裁切，各組合同一個框；每格下方是整個 repo 的計數
    grid = []
    for repo, key, i in REGIONS:
        ref = shoot(f"repo={repo}&case={key}&i={i}&theme={a.theme}", out / "shots" / f"combo-{repo}-{key}-{i}-ref.png", js)
        b = ref["box"]
        cells = []
        for k, (name, params) in enumerate(COMBOS):
            p = out / "shots" / f"combo-{repo}-{key}-{i}-{k}-{a.theme}.png"
            m = shoot(f"repo={repo}&case={key}&i={i}&theme={a.theme}" + (f"&{params}" if params else ""), p, js)["m"]
            cells.append((Image.open(p).crop((int(b["x0"] * 2), int(b["y0"] * 2), int(b["x1"] * 2), int(b["y1"] * 2))), m))
        grid.append((f"{repo} · {key} #{i}：{ref['note']}", cells))
        print(f"combo {repo} {key}#{i}")
    pad, head, rowhead, foot = 24, 64, 46, 30
    cw = max(c[0].width for _, cells in grid for c in cells)
    sheet = Image.new("RGB", (pad + len(COMBOS) * (cw + pad), pad + head + sum(rowhead + max(c[0].height for c in cells) + foot + pad for _, cells in grid)), (72, 74, 80))
    d = ImageDraw.Draw(sheet)
    d.text((pad, pad), "組合：五類一起套用", fill=(255, 214, 120), font=fg)
    for k, (name, _) in enumerate(COMBOS):
        d.text((pad + k * (cw + pad), pad + 40), name, fill=(235, 235, 235), font=fs)
    y = pad + head
    for title, cells in grid:
        d.text((pad, y + 10), title, fill=(200, 220, 255), font=fs)
        y += rowhead
        for k, (im, m) in enumerate(cells):
            xk = pad + k * (cw + pad)
            sheet.paste(im, (xk, y))
            d.text((xk, y + im.height + 4), f"整個 repo：往回折 {m['back']} · 不同線重疊 {m['overlaps']} · 交叉 {m['crossings']} · 擦站 {m['grazes']}", fill=(205, 205, 205), font=font(18))
        y += max(c[0].height for c in cells) + foot + pad
    sheet.save(out / f"combos-{a.theme}.png")
    combo_links = "".join(f'<p><b>{html.escape(name)}</b>：' + " · ".join(
        f'<a href="{LAB.as_uri()}?repo={repo}&amp;case={key}&amp;i={i}&amp;theme={a.theme}' + (f"&amp;{html.escape(params)}" if params else "") + f'">{repo} {key} #{i}</a>'
        for repo, key, i in REGIONS) + "</p>" for name, params in COMBOS)
    index.insert(0, f"<h2>組合：五類一起套用</h2><p><a href=\"combos-{a.theme}.png\">對照表</a></p>{combo_links}")
    print(f"wrote {out / f'combos-{a.theme}.png'} {sheet.size}")
    page = ("<!doctype html><meta charset=utf-8><title>走線實驗室審查</title>"
            "<style>body{font:15px/1.6 system-ui;margin:32px;max-width:1000px}h2{margin-top:28px;font-size:17px}a{margin:0 2px}</style>"
            "<h1>走線實驗室（v8 Phase 0b P4）</h1>"
            f"<p>實驗室本體：<a href=\"{LAB.as_uri()}\">lab.html</a>（上方選 repo / 實例 / 各類候選；數字列是整個 repo 在作用中規則下的計數）</p>"
            + "".join(index))
    (out / f"index-{a.theme}.html").write_text(page, encoding="utf-8")
    print("wrote", out / f"index-{a.theme}.html")


if __name__ == "__main__":
    main()
