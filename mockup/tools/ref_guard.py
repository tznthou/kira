#!/usr/bin/env python3
"""基準護欄：同一組網址參數下，基準的某個 commit 與工作副本逐像素比對。

用法：python3 ref_guard.py [--rev HEAD] [--params "theme=light&chrome=0,theme=dark&chrome=0"]
                           [--sizes 1400x900,1200x800] [--out DIR] [--allow branches,diff@empty]
用途：0b 每批在基準加新狀態時，已認可的狀態必須 0 像素不變（新狀態只能由新參數觸發）。
判定沿用 fidelity_compare 的計數器（先 selftest；任一 RGB 通道不同即算一像素）。
--allow：本批裁定要改的區塊（allow-rects.js 的名稱，新舊兩版各量一次取聯集）；差異只准落在區內，
區外的像素數 = 判定值。`區塊@狀態` 只對 ?state= 清單含那個狀態的參數組生效（比對清單元素，不比子字串：
0b P4 對照組曾因 state=detachedX 含子字串 state=detached 而空過）；`區塊@鍵=值`（例 pane@tab=prs）只對
帶那個參數的組生效（同樣比整個參數，不比子字串）。
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from PIL import Image

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from fidelity_compare import MOCKUP, REF_FILE, SCALE, diff_pixels, selftest, sh, shoot  # noqa: E402

ALLOW_JS = TOOLS / "allow-rects.js"
DEFAULT_PARAMS = ",".join(f"theme={t}&chrome=0{extra}" for extra in ("", "&on=main") for t in ("light", "dark"))
# 已認可的全部狀態（0b 殼層批 2026-10-05 + graph 狀態與走線 2026-10-08 + 側欄 / 右欄 / diff（P5）起）：每批改基準後跑
# --approved，必須全 0 px。新狀態定案後加進來；routes 不在內（它就是要拿來當「只有新版認得」的對照組）
SHELL_STATES = ["error-push", "error-pull", "error-refresh", "error-open", "error-auth", "error-signout", "behind", "diverged",
                "no-upstream", "no-remote", "detached", "signed-out", "connecting", "account-menu"]
GRAPH_STATES = ["loading", "empty", "young", "new-branch", "head-beyond", "lodger", "long-refs"]
PANEL_STATES = ["opening", "pruned", "conflict", "many-changes", "changes-error", "diff-empty", "diff-error", "diff-limits",
                "diff-many", "error-checkout", "error-commit",
                # Phase 5 第 0 步（5a，子超 2026-10-11 Safari 認可）：分支清單讀不到（Q-B）
                "branches-error",
                # Phase 5 第 0 步追加（5b，子超 2026-10-11 Safari 認可）：雙向控制字元標出來（Q-T）
                "diff-bidi"]
# PR 分頁的狀態開在分頁上才看得到（?tab=prs）；opening / signed-out / connecting / no-remote 是它們在 PR 分頁的樣子
PR_TAB_STATES = ["prs-loading", "prs-empty", "prs-rate", "prs-error", "pr-diff-loading", "pr-diff-error", "pr-diff-empty",
                 "opening", "signed-out", "connecting", "no-remote",
                 # Phase 5 第 0 步（5c，2026-10-12 Safari 認可）：graph 回來前不畫 via（loading 在 PR 分頁才看得到）、
                 # PR 展開的收合條、PR 太大（GitHub 406 / 1 MB）
                 "loading", "pr-diff-limits", "pr-diff-too-large"]
APPROVED_PARAMS = ",".join(
    f"theme={t}&{q}" for t in ("light", "dark")
    for q in ["chrome=0", "chrome=0&on=main", "chrome=full", "chrome=0&scroll=end"]
    + [f"chrome=0&state={s}" for s in SHELL_STATES + GRAPH_STATES + PANEL_STATES] + ["chrome=0&state=head-beyond&scroll=end"]
    + ["chrome=0&tab=prs"] + [f"chrome=0&state={s}&tab=prs" for s in PR_TAB_STATES])


def states_of(q):
    for part in q.split("&"):
        if part.startswith("state="):
            return part[len("state="):].split(",")
    return []


def allowed_regions(q, allow):
    """這組參數准許有差異的區塊名"""
    out = []
    for entry in allow:
        region, _, state = entry.partition("@")
        if not state or (state in q.split("&") if "=" in state else state in states_of(q)):
            out.append(region)
    return out


def outside(mask_png, boxes):
    """差異遮罩（白 = 不同）在允許框以外的像素數，與全部差異的外框（@2x px）"""
    im = Image.open(mask_png).convert("L")
    bbox = im.getbbox()
    for (l, t, r, b) in boxes:
        im.paste(0, (max(0, int(l * SCALE)), max(0, int(t * SCALE)), int(r * SCALE + 0.999), int(b * SCALE + 0.999)))
    return sum(im.histogram()[1:]), bbox


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rev", default="HEAD")
    ap.add_argument("--old-file", default="", help="拿這個檔當舊版，不從 --rev 取（例：改基準前存的快照，證明這一步沒動到畫面）")
    ap.add_argument("--params", default=DEFAULT_PARAMS)
    ap.add_argument("--approved", action="store_true", help="用已認可的全部狀態取代 --params（幾組看 --dry-run）")
    ap.add_argument("--allow", default="", help="可以有差異的區塊：branches,diff@empty（見 allow-rects.js）")
    ap.add_argument("--dry-run", action="store_true", help="只印出要比的參數組")
    ap.add_argument("--sizes", default="1400x900,1200x800")
    ap.add_argument("--out", default=str(MOCKUP / "fidelity-out" / f"guard-{datetime.now():%Y%m%d-%H%M%S}"))
    a = ap.parse_args()
    if a.approved:
        a.params = APPROVED_PARAMS
    allow = [x for x in a.allow.split(",") if x]
    if a.dry_run:
        for q in a.params.split(","):
            regions = allowed_regions(q, allow)
            print(q + (f"   (allow {','.join(regions)})" if regions else ""))
        print(f"{len(a.params.split(','))} param sets × {len(a.sizes.split(','))} sizes")
        return
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    selftest(out)

    # 舊版放在基準旁邊（同目錄），相對路徑與 file:// 行為才會一致
    if a.old_file:
        old_src = Path(a.old_file).read_text(encoding="utf-8")
        old_file = MOCKUP / ".guard-old-file.html"
        rev = Path(a.old_file).name
    else:
        # ./ = 相對 -C 的目錄：基準在外層 repo 的 mockup/ 底下，不加的話 <rev>:<檔名> 會找 repo 根
        old_src = sh(["git", "-C", str(MOCKUP), "show", f"{a.rev}:./{REF_FILE.name}"]).stdout
        old_file = MOCKUP / f".guard-{a.rev.replace('/', '_')}.html"
        rev = sh(["git", "-C", str(MOCKUP), "rev-parse", "--short", a.rev]).stdout.strip()
    old_file.write_text(old_src, encoding="utf-8")
    failed = 0
    try:
        for size in a.sizes.split(","):
            w, h = (int(v) for v in size.split("x"))
            for i, q in enumerate(a.params.split(",")):
                d = out / f"{size}-{i}"
                d.mkdir(exist_ok=True)
                regions = allowed_regions(q, allow)
                js = ALLOW_JS if regions else None
                old_rects = shoot(f"{old_file.as_uri()}?{q}", w, h, d / "old.png", js)
                new_rects = shoot(f"{REF_FILE.as_uri()}?{q}", w, h, d / "new.png", js)
                n = diff_pixels(d / "old.png", d / "new.png", d / "diff.png")
                note = ""
                if regions:
                    boxes = []
                    for payload in (old_rects, new_rects):
                        rects = json.loads(payload)
                        boxes += [rects[r] for r in regions if rects.get(r)]
                    total = n
                    n, bbox = outside(d / "diff.png", boxes)
                    note = f"  ({total} px inside {','.join(regions)}" + (f", bbox @2x {bbox}" if bbox else "") + ")"
                failed += n != 0
                print(f"{size}  ?{q:<32} {n:>8} px  {'PASS' if n == 0 else 'FAIL'}{note}")
    finally:
        old_file.unlink(missing_ok=True)
    print(f"\nmockup {rev} vs working copy: {'all unchanged' if not failed else f'{failed} changed'}"
          + (f" outside {a.allow}" if allow else "") + f" · {out}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
