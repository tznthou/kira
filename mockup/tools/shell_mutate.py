#!/usr/bin/env python3
"""shell_flows 的把關力：把基準的殼層規則逐條改壞，流程測試必須變紅（killed）。

用法：python3 shell_mutate.py [--only 編號,…]      全部 killed 才 exit 0；存活的變異 = 那條規則沒有流程在守
變異檔寫在基準旁（同目錄），跑完即刪。0b P5 起每條變異可以只跑守它的流程（第四欄），其餘跑全部流程。
"""
import argparse
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from shell_flows import REF, run  # noqa: E402

MUTANTS = [
    ("pull 開始時不清提示",
     '  pullBtn.addEventListener("click", () => {\n    clearNotice();\n', '  pullBtn.addEventListener("click", () => {\n'),
    ("沒東西可推也不停用 Push",
     "pushBtn.disabled = !!blocked || (shell.upstream && ahead === 0);", "pushBtn.disabled = !!blocked;"),
    ("?fail= 不只失敗一次",
     "const takeFail = (op) => failOnce.delete(op);", "const takeFail = (op) => failOnce.has(op);"),
    ("停用理由順序：no remote 排到 detached 前",
     ': shell.detached ? "Detached HEAD — check out a branch first"\n      : !shell.remote ? "No remote configured"',
     ': !shell.remote ? "No remote configured"\n      : shell.detached ? "Detached HEAD — check out a branch first"'),
    ("沒 upstream 時不叫 Publish",
     'pushBtn.querySelector(".label").textContent = publish ? "Publish" : "Push";',
     'pushBtn.querySelector(".label").textContent = "Push";'),
    ("落後計數改成金箔",
     '<span class="count in" id="behind"', '<span class="count" id="behind"'),
    ("提示出現時站牌不讓位",
     "  .has-notice .station, .has-notice .youare { display: none; }\n", ""),
    ("選單不吃 Esc",
     'if (e.key === "Escape") { e.preventDefault(); setMenu(false); acctBtn.focus(); }\n    else if',
     "if"),
    ("commit 後站牌不重繪",
     "updateAhead(); renderYouAre(); syncLine();\n      select(id);", "updateAhead(); syncLine();\n      select(id);"),
    ("detached 的強調色不跟 HEAD 那站",
     "shell.detached ? commits[indexOf().get(headId)].br : shell.unborn", 'shell.detached ? "main" : shell.unborn'),
    # 0b P4（2026-10-08 子超定）
    ("同一條線的 remote 不縮寫成 origin",
     "const label = r.owner ? r.n.slice(0, r.n.length - r.owner.n.length - 1) : cutName(r.n);", "const label = cutName(r.n);"),
    ("detached 的那站不掛 HEAD pill",
     'const head = shell.detached && c.id === headId ? [{ k: "head", n: "HEAD", br: c.br }] : [];', "const head = [];"),
    ("全螢幕不讓位",
     '  :root[data-chrome="full"] { --chrome-inset: 4px; }\n', ""),
    ("Publish 後側欄不加遠端分支",
     "        branches.push({ n: upstream, br: cur.br, remote: true });\n", ""),
    # 0b P5（側欄 / 右欄 / diff）：第四欄 = 守這條的流程
    ("視窗外的分支不畫虛線圈",
     "    if (beyond) return", "    if (false) return", ["beyond-checkout"]),
    ("其他分支的 ↑↓ 不畫",
     '      if (!shell.remote || (!a && !d)) return "";', '      return "";', ["beyond-checkout"]),
    ("其他分支的 ↑↓ 用金箔（金箔只給你所在的線）",
     '<span class="b-stats plain" title="${title}">', '<span class="b-stats" title="${title}">', ["beyond-checkout"]),
    ("視窗外的分支點了沒反應",
     "(!tip && !target.beyond) || busy) return;", "!tip || busy) return;", ["beyond-checkout"]),
    ("寄宿 / 視窗外的分支被 checkout 不換上自己的線（決策 D）",
     "if (!own || !(target.lodge || target.beyond)) return;", "return;", ["lodger-checkout", "beyond-checkout"]),
    ("HEAD 的字母不優先（feat/t15g-graph-density 不讓出 T）",
     ', reletter: { t15g: "G" } }', " }", ["beyond-checkout"]),
    ("checkout 失敗後焦點不回那一列",
     'showNotice("Checkout failed.", "Commit or stash first.", branchBtn(name));', 'showNotice("Checkout failed.", "Commit or stash first.");',
     ["checkout-fail"]),
    ("checkout 開始時不清提示",
     "    if (!target || target.current || (!tip && !target.beyond) || busy) return;\n    clearNotice();\n",
     "    if (!target || target.current || (!tip && !target.beyond) || busy) return;\n", ["clear-checkout"]),
    ("stage 開始時不清提示",
     "  const stageFailed = (op, from) => {\n    clearNotice();\n", "  const stageFailed = (op, from) => {\n", ["clear-stage"]),
    ("commit 開始時不清提示",
     "    if (commitBtn.disabled) return;\n    clearNotice();\n", "    if (commitBtn.disabled) return;\n", ["clear-commit"]),
    ("stage 失敗後焦點不回那顆按鈕",
     "    if (stageFailed(b.dataset.op, stageBtn(b.dataset.path, b.dataset.op))) return;",
     "    if (stageFailed(b.dataset.op, null)) return;", ["stage-fail"]),
    ("commit 失敗清掉訊息",
     'if (takeFail("commit")) { setBusy(null); return', 'if (takeFail("commit")) { setBusy(null); msg.value = ""; return', ["commit-fail"]),
    ("忙碌時側欄不說原因",
     "const blocked = busy ? `Disabled while ${VERB[busy]}` : null;", "const blocked = null;", ["busy-legend"]),
    ("忙碌時側欄列變淡",
     '  .branch-btn[aria-disabled="true"] { cursor: default; }', '  .branch-btn[aria-disabled="true"] { cursor: default; opacity: 0.6; }', ["busy-legend"]),
    ("status 讀取失敗留著舊清單",
     '    $("stage-lists").hidden = error;', '    $("stage-lists").hidden = false;', ["status-fail"]),
    ("status 讀取失敗也進站牌",
     '      if (takeFail("status")) panel.changes = "error";',
     '      if (takeFail("status")) { panel.changes = "error"; showNotice("Refresh failed.", "", refreshBtn); }', ["status-fail"]),
    ("衝突時 Commit 不停用",
     " || conflicted.length > 0 || panel.changes", " || panel.changes", ["conflict"]),
    ("衝突列有 stage 按鈕",
     '<span class="stage-gap" aria-hidden="true"></span>',
     '<button class="stage-btn" data-path="${esc(f.p)}" data-op="stage" aria-label="Stage"></button>', ["conflict"]),
    ("登入後 PR 不重抓",
     "      fetchPRs();\n    }, 900);", "    }, 900);", ["prs-signin"]),
    ("沒 remote 時先看登入",
     '(!shell.remote ? "not-github" : shell.auth !== "in" ? "signed-out" : panel.prs)',
     '(shell.auth !== "in" ? "signed-out" : !shell.remote ? "not-github" : panel.prs)', ["prs-states"]),
    ("PR 只畫第一個檔",
     "files.length ? files.map((f) => fileHTML(f)).join(\"\")", "files.length ? files.slice(0, 1).map((f) => fileHTML(f)).join(\"\")",
     ["pr-diff", "pr-diff-retry"]),
    ("PR 列表 Retry 不重讀",
     '{ $("panel-prs").focus(); return fetchPRs(); }', '{ $("panel-prs").focus(); return; }', ["prs-retry"]),
    ("diff Retry 不重讀",
     '{ panel.diff = "ok"; renderDiff(); diffEl.focus(); }', "{ renderDiff(); diffEl.focus(); }", ["diff-retry"]),
    ("merge 的指令少了 -m --first-parent",
     'c.p.length > 1 ? "-m --first-parent " : ""', '""', ["diff-limits"]),
    ("只有一個 parent 也加 -m --first-parent",
     'c.p.length > 1 ? "-m --first-parent " : ""', 'c.p.length > 0 ? "-m --first-parent " : ""', ["diff-limits"]),
    ("路徑不加引號",
     "const arg = /^[A-Za-z0-9._\\/-]+$/.test(spec) ? spec : `'${spec.replace(/'/g, \"'\\\\''\")}'`;", "const arg = spec;", ["diff-limits"]),
    ("git 會當成萬用字元的路徑不加 :(literal)",
     'const spec = /[*?[\\\\]/.test(path) || path.startsWith(":") ? `:(literal)${path}` : path;', "const spec = path;", ["diff-limits"]),
    ("hash 只寫 7 碼",
     "${fullOid(c.id).slice(0, 12)} -- ${arg}", "${c.id} -- ${arg}", ["diff-limits"]),
    ("2,000 字元以上的行照樣上色",
     "const re = src.length > 2000 ? null : LANGS.get(lang);", "const re = LANGS.get(lang);", ["diff-limits"]),
    # Phase 5 第 0 步（5b）：hunk 標頭的函式名、依副檔名上色（語言表本身由 hl_probe.mjs 的語料守）
    ("HEAD 的 hunk 標頭沒有函式名",
     'ctx: "export const HASH_COL_WIDTH = 60;"', 'ctx: ""', ["diff-code"]),
    ("hunk 標頭不畫函式名",
     '@@${h.ctx ? " " + h.ctx : ""}`;', "@@`;", ["diff-code"]),
    ("Markdown 也上色",
     'rs: "rs", json: "json", css: "css",', 'rs: "rs", json: "json", css: "css", md: "js",', ["diff-code-young"]),
    ("不看副檔名，一律當 JS 上色",
     "const re = src.length > 2000 ? null : LANGS.get(lang);", 'const re = src.length > 2000 ? null : LANGS.get("js");',
     ["diff-code-young"]),
    ("JS 關鍵字少了 await",
     '"as async await break case', '"as async break case', ["diff-code-young"]),
    # Q-T：雙向控制字元標出來（escCode）
    ("雙向字元照樣生效", r"/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g", r"/(?!)/g", ["diff-bidi"]),
    # showCommand 的正規式也有隔離字元：只改 escCode 的（帶 /g 的那個）
    ("隔離字元不標", r"\u2066-\u2069\u200e\u200f\u061c]/g", r"\u200e\u200f\u061c]/g", ["diff-bidi"]),
    ("hunk 標頭的雙向字元不標", "${escCode(head)}", "${esc(head)}", ["diff-bidi"]),
    ("檔頭路徑的雙向字元不標", "${escCode(p.slice(i + 1))}`;", "${esc(p.slice(i + 1))}`;", ["diff-bidi"]),
    # 5c 第 0 步起 diff 區與 PR 展開共用 limitStrips：兩邊的流程都要叫
    ("收合的檔不數",
     '+ (kept.length ? strip(`${kept.length} of', '+ (false ? strip(`${kept.length} of', ["diff-limits", "pr-diff-limits"]),
    # 5b 第 0 步追加（子超 2026-10-11 定）：git 的「\ No newline at end of file」是淡色註記行
    ("檔尾註記當一般的行畫",
     '        if (og === "\\\\") return `<div class="dl eof">', '        if (false) return `<div class="dl eof">', ["diff-limits"]),
    ("檔尾註記帶行號",
     '<div class="dl eof"><span class="ln"></span>', '<div class="dl eof"><span class="ln">${o}</span>', ["diff-limits"]),
    ("檔尾註記不是淡色", "  .dl.eof { color: var(--ink-3); }\n", "", ["diff-limits"]),
    # 5b step 7：?diffat=<路徑> 把 diff 捲到那個檔（比對截圖用）
    ("?diffat= 不捲",
     "      if (at) diffEl.scrollTop += at.getBoundingClientRect().top - diffEl.getBoundingClientRect().top - 12;\n", "",
     ["diff-at"]),
    ("空 repo 的 diff 區還叫你選 commit",
     "diffEl.innerHTML = shell.unborn\n", "diffEl.innerHTML = false\n", ["panel-static"]),
    ("沒有遠端分支也畫 Remote 標題",
     '(remote.length ? `<li class="group-label">Remote</li>` + remote.map(row).join("") : "")',
     '(`<li class="group-label">Remote</li>` + remote.map(row).join(""))', ["panel-static"]),
    ("清單截斷時 Stage all 不停用",
     "|| !!busy || loading || unstagedCut;", "|| !!busy || loading;", ["panel-static"]),
    ("開 repo 時不說 upstream 未知",
     ': shell.unknown ? "Upstream status unknown — Refresh to retry" : null;', ": null;", ["panel-static"]),
    # Phase 5 第 0 步（5a，2026-10-11）：Q-L 骨架圓點、Q-B 分支清單讀不到、?on= 在 state 之後
    ("graph 還沒回來時側欄照畫圓標",
     "${walk.loading ? SK_ROUNDEL : roundel(", "${false ? SK_ROUNDEL : roundel(", ["panel-static"]),
    ("分支清單讀不到時照列舊清單",
     'list.innerHTML = panel.branches === "error"\n', "list.innerHTML = false\n", ["branches-retry", "branches-fail"]),
    ("分支清單讀不到不是 alert",
     '<span role="alert"><b>Couldn\'t read branches.</b></span>', "<span><b>Couldn't read branches.</b></span>",
     ["branches-retry"]),
    ("分支清單 Retry 不重讀",
     '{ panel.branches = "ok"; renderBranches(); $("branch-list").focus(); return; }',
     '{ renderBranches(); $("branch-list").focus(); return; }', ["branches-retry"]),
    ("Refresh 讀不到分支清單不說",
     '      if (takeFail("branches")) panel.branches = "error";\n', '      if (takeFail("branches")) {}\n', ["branches-fail"]),
    ("下一次 Refresh 讀到了也不清分支清單的錯誤",
     '      else if (panel.branches === "error") panel.branches = "ok";\n', "", ["branches-fail"]),
    ("Refresh 後不重畫分支清單",
     "      renderStaging();\n      renderBranches();\n    }, 900);", "      renderStaging();\n    }, 900);", ["branches-fail"]),
    ("分支清單讀不到時提早 return（+ New branch 不跟著忙碌停用）",
     '    list.innerHTML = panel.branches === "error"\n',
     '    if (panel.branches === "error") return void (list.innerHTML = `<li class="empty-line"><span role="alert"><b>Couldn\'t read'
     ' branches.</b></span> <button class="text-btn" type="button" id="branches-retry">Retry</button></li>`);\n'
     '    list.innerHTML = panel.branches === "error"\n', ["branches-fail"]),
    ("?on= 在 state 之前套",
     '  const states = (q.get("state") || "").split(",").filter(Boolean);\n  states.forEach(applyState);\n',
     '  const states = (q.get("state") || "").split(",").filter(Boolean);\n'
     '  if (q.get("on")) { checkout(q.get("on")); select(headId); }\n  states.forEach(applyState);\n'
     '  if (q.get("on")) q.delete("on");\n', ["on-after-state"]),
    # Retry 成功後焦點留在重讀的那一區（子超 2026-10-11；按鈕被重畫掉，焦點原本會掉到 body）
    ("分支清單 Retry 後焦點掉了",
     ' $("branch-list").focus(); return; }', " return; }", ["branches-retry"]),
    ("Changes Retry 後焦點掉了",
     ' $("panel-changes").focus(); return; }', " return; }", ["status-fail"]),
    ("PR 列表 Retry 後焦點留在藏起來的按鈕",
     '{ $("panel-prs").focus(); return fetchPRs(); }', "{ return fetchPRs(); }", ["prs-retry"]),
    ("PR 檔案 Retry 後焦點掉了",
     ' document.querySelector(".pr.open .pr-row").focus(); return; }', " return; }", ["pr-diff-retry"]),
    ("diff Retry 後焦點掉了",
     " renderDiff(); diffEl.focus(); }", " renderDiff(); }", ["diff-retry"]),
    # 5b 審查（2026-10-11）：行裡的裸 CR 經 innerHTML 會變 LF、多一列
    ("esc 不把 CR 寫成字元參照",
     'replace(/[&<>"\\r]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;", "\\r": "&#13;" }[ch]))',
     'replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;" }[ch]))', ["diff-bidi"]),
    # Phase 5 第 0 步（5c，子超 2026-10-12）：graph 回來前不畫 via（Q-L）、PR 展開的收合條、PR 太大（GitHub 406 / 1 MB）
    ("graph 還沒回來時 PR 列照畫 via",
     "line = walk.loading ? null : lineOf(pr.head);", "line = lineOf(pr.head);", ["pr-via-loading"]),
    ("graph 回來後 PR 列也不畫 via",
     "line = walk.loading ? null : lineOf(pr.head);", "line = null;", ["pr-diff"]),
    ("PR 展開不數收合的檔",
     'limitStrips(files, diffCut.has(pr.diff), "pull request") + ', "", ["pr-diff-limits"]),
    ("PR 展開的條沒貼齊檔案",
     "  .diff-scroll > .strip, .pr-body > .strip { margin: 0 0 12px; }", "  .diff-scroll > .strip { margin: 0 0 12px; }",
     ["pr-diff-limits"]),
    ("PR 太大時照畫檔案",
     '    if (panel.prDiff === "large") return strip(', "    if (false) return strip(", ["pr-diff-too-large"]),
    ("PR 太大當讀取失敗、給 Retry",
     'if (panel.prDiff === "error") return', 'if (panel.prDiff === "error" || panel.prDiff === "large") return',
     ["pr-diff-too-large"]),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="只跑這些編號的變異（逗號分隔，1 起算）")
    a = ap.parse_args()
    pick = {int(x) for x in a.only.split(",") if x}
    src = REF.read_text(encoding="utf-8")
    survived = []
    for i, (name, old, new, *flows) in enumerate(MUTANTS, 1):
        if pick and i not in pick:
            continue
        n = src.count(old)
        if n != 1:
            sys.exit(f"mutant {i} ({name}): pattern found {n} times, expected 1")
        path = REF.parent / f".mut-{i}.html"
        path.write_text(src.replace(old, new), encoding="utf-8")
        try:
            fails = run(path, quiet=True, only=flows[0] if flows else None)
        finally:
            path.unlink(missing_ok=True)
        print(f"{'killed ' if fails else 'SURVIVED'}  {i:2}. {name}" + (f"  ({fails} assertions failed)" if fails else ""))
        if not fails:
            survived.append(name)
    total = len(pick) if pick else len(MUTANTS)
    print(f"\n{total - len(survived)}/{total} killed" + (f" — survivors: {survived}" if survived else ""))
    sys.exit(1 if survived else 0)


if __name__ == "__main__":
    main()
