#!/usr/bin/env python3
"""Phase 3 第一步 spike：Tailwind v4（preflight + layer）與 v8 基準 CSS 的互相影響，用像素量。

用法：vite 跑在 1420（npx vite --port 1420 --strictPort）→ python3 css_spike.py [--part 1|2|all]
part 1  基準搬進 app 的 CSS 流程會不會變：基準原檔（file://）vs 經 Vite 的變體頁
        c = 只有 v8.css（不含 Tailwind；對照組，驗證 Vite 本身不改畫面）
        u = @import "tailwindcss" + v8.css 不分層
        l = @import "tailwindcss" + v8.css 放進 @layer components
        n = Tailwind 只取 theme + utilities（不要 preflight）+ v8.css 不分層
part 2  v8 CSS 全域載入時會不會改到還沒移植的舊元件：fidelity 入口（現在的 app）vs 加了 v8.css 的同一頁
        fu = v8.css 不分層；fl = v8.css 放進 @layer components
產物：mockup/fidelity-out/spike/（頁面與 CSS 每次重產；截圖在 shots/）
判定沿用 fidelity_compare 的計數器（先 selftest）；差異列出每區像素數與差異框（css px）。
"""
import argparse
import json
import re
import sys
from pathlib import Path
from urllib.request import Request, urlopen

from PIL import Image

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from fidelity_compare import REF_FILE, REGION_JS, diff_pixels, regions_from, selftest, shoot  # noqa: E402

MOCKUP = TOOLS.parent
SPIKE = MOCKUP / "fidelity-out" / "spike"
ONLY: set = set()
BASE = "http://localhost:1420"
URL_DIR = f"{BASE}/mockup/fidelity-out/spike"

VARIANTS = {
    # x = 故意的 1px 改動：比較器必須報出差異，否則整批 0 不可信
    "x": '@import "tailwindcss";\n@import "./v8.css";\n.ref.head { padding-left: 3px; }\n',
    "c": '@import "./v8.css";\n',
    "u": '@import "tailwindcss";\n@import "./v8.css";\n',
    "l": '@import "tailwindcss";\n@import "./v8.css" layer(components);\n',
    "n": ('@layer theme, base, components, utilities;\n'
          '@import "tailwindcss/theme.css" layer(theme);\n'
          '@import "tailwindcss/utilities.css" layer(utilities);\n'
          '@import "./v8.css";\n'),
}
# 基準的幾個狀態：預設、在 main 上、帳號選單（menu/b）、失敗提示（notice）、側欄分岔計數
STATES = ["", "on=main", "state=account-menu", "state=error-push", "state=diverged"]
# 要先操作才看得到的狀態：截圖前在兩邊執行同一段 JS（PR 分頁 / Esc 清掉選取後的空 diff，含 <kbd>）
ACTIONS = {
    "prs": 'document.getElementById("tab-prs").click();',
    "esc": ('const r = document.querySelector(\'#rows .row[aria-selected="true"]\');'
            'r.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));'),
    # 刪除鈕平常 opacity 0（hover / focus 才出現）：強制顯示，看 preflight 的 padding 0 有沒有改到圖示
    "bdel": 'document.querySelectorAll(".b-del").forEach((b) => (b.style.opacity = "1"));',
}


def build():
    SPIKE.mkdir(parents=True, exist_ok=True)
    src = REF_FILE.read_text(encoding="utf-8")
    m = re.search(r"<style>\n(.*?)</style>\n", src, re.S)
    if not m or src.count("<style>") != 1:
        sys.exit("expected exactly one <style> block in the reference")
    (SPIKE / "v8.css").write_text(m.group(1), encoding="utf-8")
    for name, css in VARIANTS.items():
        (SPIKE / f"tw-{name}.css").write_text(css, encoding="utf-8")
        page = src[: m.start()] + f'<link rel="stylesheet" href="./tw-{name}.css" />\n' + src[m.end():]
        (SPIKE / f"{name}.html").write_text(page, encoding="utf-8")
    # part 2：fidelity 入口 + v8.css（不分層 / components 層）
    fid = (MOCKUP.parent / "fidelity.html").read_text(encoding="utf-8")
    # fl 的 <link> 比 Vite 注入的 index.css 早出現：不先宣告層序，components 會變成第一個（最低）層、
    # 排到 preflight 下面——測到的就不是 app 真正的寫法（index.css 先 @import tailwindcss 再引 v8）
    order = "@layer properties, theme, base, components, utilities;\n"
    for name, css in {"fu": '@import "./v8.css";\n', "fl": order + '@import "./v8.css" layer(components);\n'}.items():
        (SPIKE / f"tw-{name}.css").write_text(css, encoding="utf-8")
        page = fid.replace("</head>", f'    <link rel="stylesheet" href="./tw-{name}.css" />\n  </head>')
        (SPIKE / f"{name}.html").write_text(page, encoding="utf-8")


def served_css_has(name, needle):
    # 以 text/css 要（同瀏覽器 <link>），否則 Vite 回的是包了 CSS 字串的 JS module
    req = Request(f"{URL_DIR}/tw-{name}.css", headers={"Accept": "text/css,*/*;q=0.1"})
    with urlopen(req) as r:
        return needle in r.read().decode("utf-8", "replace")


def bbox_css(mask):
    bb = Image.open(mask).convert("L").getbbox()
    return tuple(round(v / 2) for v in bb) if bb else None


def compare(ref_url, url, w, h, out, label, action=None):
    out.mkdir(parents=True, exist_ok=True)
    js_ref, js_var = REGION_JS, None
    if action:
        # 動作 + 量區界寫成一支 JS（wk-shot 只收一個 js-file），兩邊執行同一段動作
        js_ref, js_var = out / "act-ref.js", out / "act-var.js"
        js_ref.write_text(f"(() => {{ {action} }})();\n" + REGION_JS.read_text(), encoding="utf-8")
        js_var.write_text(f"(() => {{ {action} }})(); 'ok'\n", encoding="utf-8")
    rects = json.loads(shoot(ref_url, w, h, out / "ref.png", js_ref))
    shoot(url, w, h, out / "var.png", js_var)
    total = diff_pixels(out / "ref.png", out / "var.png", out / "diff.png")
    rows = []
    for name, (x, y, rw, rh) in regions_from(rects).items():
        sh_ref, sh_var, sh_diff = out / f"{name}-ref.png", out / f"{name}-var.png", out / f"{name}-diff.png"
        Image.open(out / "ref.png").crop((x, y, x + rw, y + rh)).save(sh_ref)
        Image.open(out / "var.png").crop((x, y, x + rw, y + rh)).save(sh_var)
        n = diff_pixels(sh_ref, sh_var, sh_diff)
        bb = bbox_css(sh_diff)
        if bb:
            bb = (bb[0] + x // 2, bb[1] + y // 2, bb[2] + x // 2, bb[3] + y // 2)
        rows.append((name, n, bb))
    print(f"{label:46} whole {total:>8} px  " + "  ".join(f"{n}:{c}" for n, c, _ in rows))
    for name, n, bb in rows:
        if n:
            print(f"{'':46}   {name:7} {n:>7} px  bbox(css) {bb}")
    return total


def part1(sizes, themes):
    print("== part 1: reference (file://) vs the same page through Vite/Tailwind")
    # preflight 才有 ::file-selector-button；基準 CSS 本身也有 box-sizing / margin:0，不能拿來判斷
    expect = {"x": True, "c": False, "u": True, "l": True, "n": False}
    for v, want in expect.items():
        if served_css_has(v, "::file-selector-button") != want:
            sys.exit(f"tw-{v}.css: preflight {'missing' if want else 'present'} — the variant is not what it claims")
    summary = {}
    cases = [(st, None) for st in STATES] + [("", act) for act in ACTIONS]
    if ONLY:
        cases = [(st, act) for st, act in cases if (act or st or "default") in ONLY]
    for v in VARIANTS:
        for size in sizes:
            w, h = size
            for t in themes:
                for st, act in cases:
                    q = f"theme={t}&chrome=0" + (f"&{st}" if st else "")
                    label = f"{v} {w}x{h} ?{q}" + (f" +{act}" if act else "")
                    tag = act or st or "default"
                    out = SPIKE / "shots" / f"p1-{v}-{w}x{h}-{t}-{tag}".replace("=", "_")
                    n = compare(f"{REF_FILE.as_uri()}?{q}", f"{URL_DIR}/{v}.html?{q}", w, h, out, label,
                                ACTIONS.get(act))
                    summary.setdefault(v, []).append(n)
    print("\nvariant totals (sum of whole-page diff px):", {v: sum(ns) for v, ns in summary.items()})
    if not all(summary["x"]):
        sys.exit("SELF-CHECK FAILED: the deliberate 1px change was not detected in every case")
    print("self-check: the deliberate 1px change (variant x) was detected in every case")


def part2(sizes, themes):
    print("\n== part 2: the app (fidelity entry) vs the app with v8.css loaded globally")
    for v in ("fu", "fl"):
        for size in sizes:
            w, h = size
            for t in themes:
                label = f"{v} {w}x{h} ?theme={t}"
                out = SPIKE / "shots" / f"p2-{v}-{w}x{h}-{t}"
                # 區界仍取自基準 DOM（同尺寸），只用來把差異分區，不代表 app 的版面
                rects = json.loads(shoot(f"{REF_FILE.as_uri()}?theme={t}&chrome=0", w, h, SPIKE / "rects.png", REGION_JS))
                out.mkdir(parents=True, exist_ok=True)
                shoot(f"{BASE}/fidelity.html?theme={t}", w, h, out / "ref.png")
                shoot(f"{URL_DIR}/{v}.html?theme={t}", w, h, out / "var.png")
                total = diff_pixels(out / "ref.png", out / "var.png", out / "diff.png")
                print(f"{label:46} whole {total:>8} px  bbox(css) {bbox_css(out / 'diff.png')}")
                del rects


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--part", default="all", choices=["1", "2", "all"])
    ap.add_argument("--sizes", default="1400x900")
    ap.add_argument("--themes", default="light,dark")
    ap.add_argument("--only", default="", help="part 1 只跑這些情境（逗號分隔：default、on=main、prs、esc、bdel…）")
    a = ap.parse_args()
    global ONLY
    ONLY = set(filter(None, a.only.split(",")))
    sizes = [tuple(int(x) for x in s.split("x")) for s in a.sizes.split(",")]
    themes = a.themes.split(",")
    try:
        urlopen(BASE, timeout=3)
    except OSError:
        sys.exit("vite is not running on 1420 — start it with: npx vite --port 1420 --strictPort")
    build()
    SPIKE.joinpath("shots").mkdir(exist_ok=True)
    selftest(SPIKE)
    if a.part in ("1", "all"):
        part1(sizes, themes)
    if a.part in ("2", "all"):
        part2(sizes, themes)


if __name__ == "__main__":
    main()
