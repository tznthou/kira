#!/usr/bin/env python3
"""Phase 0b 第一批：強調色跟著所在路線變，接進基準 mockup。
- CSS：accent_variants.py 驗過的 12 組 [data-line] token
- JS：data-line 跟著目前分支；側欄點本機分支 = 模擬 checkout；?on=<branch> 直接開在該分支
- commit / push 示範改為跟著目前分支（原本寫死 t15g）
每個替換斷言命中次數。"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
p = HERE.parent / "v8-kirazuri-lines-sys.html"
s = p.read_text(encoding="utf-8")


def sub(old, new, count=1):
    global s
    n = s.count(old)
    if n != count:
        sys.exit(f"ABORT: expected {count}, got {n}: {old[:90]!r}")
    s = s.replace(old, new)


# ---- CSS：取 accent_variants.py 的輸出（全部通過才有 CSS） ----
res = subprocess.run([sys.executable, str(HERE / "accent_variants.py"), "--css"], capture_output=True, text=True)
if res.returncode != 0:
    sys.exit("ABORT: accent_variants.py did not pass:\n" + res.stdout)
css = "\n".join(line for line in res.stdout.splitlines() if line.startswith("  :root"))
if css.count(":root") != 12:
    sys.exit("ABORT: expected 12 accent blocks")
sub("  * { box-sizing: border-box; }\n",
    "  /* accent follows your line: the line you are on tints focus, tabs, selection and the\n"
    "     station sign. Values from tools/accent_variants.py (rokusho = v8's originals;\n"
    "     every pair contrast-checked, every line ≥ 3:1 across every selected tint). */\n"
    + css + "\n\n  * { box-sizing: border-box; }\n")

# ---- HTML：站牌的圓標與分支名要能更新 ----
sub('<span class="rd lg" style="--l:var(--l-rokusho)" aria-hidden="true">G</span>',
    '<span class="rd lg" id="you-rd" style="--l:var(--l-rokusho)" aria-hidden="true">G</span>')
sub('<span class="bn">feat/t15g-graph-density</span>', '<span class="bn" id="you-bn">feat/t15g-graph-density</span>')

# ---- JS：分支按鈕帶名字 ----
sub('        <button class="branch-btn" ${b.remote ?', '        <button class="branch-btn" data-branch="${esc(b.n)}" ${b.remote ?')

# checkout / 強調色同步 / 站牌更新，接在 renderBranches 之後
sub('    $("branch-list").innerHTML = local.map(row).join("") + `<li class="group-label">Remote</li>` + remote.map(row).join("");\n  }\n',
    '    $("branch-list").innerHTML = local.map(row).join("") + `<li class="group-label">Remote</li>` + remote.map(row).join("");\n  }\n'
    '\n'
    '  /* ---------- your line: checkout moves you, the accent follows ---------- */\n'
    '  const current = () => branches.find((b) => b.current);\n'
    '  function syncLine() {\n'
    '    root.dataset.line = (LINE[current().br] || "--l-trunk").slice(4);\n'
    '  }\n'
    '  function renderYouAre() {\n'
    '    const b = current();\n'
    '    $("you-rd").style.setProperty("--l", lc(b.br));\n'
    '    $("you-rd").textContent = LETTER[b.br] || "?";\n'
    '    $("you-bn").textContent = b.n;\n'
    '  }\n'
    '  function tipOf(name) {\n'
    '    for (const [id, list] of Object.entries(refs)) {\n'
    '      if (list.some((r) => (r.k === "local" || r.k === "head") && r.n === name)) return id;\n'
    '    }\n'
    '    return null;\n'
    '  }\n'
    '  function checkout(name) {\n'
    '    const target = branches.find((b) => b.n === name && !b.remote), tip = tipOf(name);\n'
    '    if (!target || target.current || !tip || busy) return;\n'
    '    for (const list of Object.values(refs)) {\n'
    '      for (const r of list) {\n'
    '        if (r.k === "head") r.k = "local";\n'
    '        else if (r.k === "local" && r.n === name) r.k = "head";\n'
    '      }\n'
    '    }\n'
    '    current().ahead = ahead;\n'
    '    branches.forEach((b) => (b.current = b === target));\n'
    '    ahead = target.ahead || 0;\n'
    '    headId = tip;\n'
    '    firstPaint = true;\n'
    '    syncLine(); renderYouAre(); renderGraph(); updateAhead();\n'
    '  }\n'
    '  $("branch-list").addEventListener("click", (e) => {\n'
    '    const b = e.target.closest(".branch-btn");\n'
    '    if (b && !b.closest(".remote")) checkout(b.dataset.branch);\n'
    '  });\n')

# commit：新 commit 落在目前分支、目前 lane；只拿掉舊 HEAD 的 head 標籤（main 上還有 origin/main 與 tag）
sub('      delete refs[headId];\n'
    '      commits.unshift({ id, lane: 1, br: "t15g", s: first, p: [headId], t: "2026/10/03 14:31" });\n'
    '      refs[id] = [{ k: "head", n: "feat/t15g-graph-density", br: "t15g" }];\n',
    '      const cur = current(), lane = commits[indexOf().get(headId)].lane;\n'
    '      refs[headId] = refs[headId].filter((r) => r.k !== "head");\n'
    '      if (!refs[headId].length) delete refs[headId];\n'
    '      commits.unshift({ id, lane, br: cur.br, s: first, p: [headId], t: "2026/10/03 14:31" });\n'
    '      refs[id] = [{ k: "head", n: cur.n, br: cur.br }];\n')

# push：推的是目前分支的 upstream
sub('      for (const id of Object.keys(refs)) {\n'
    '        refs[id] = refs[id].filter((r) => r.n !== "origin/feat/t15g-graph-density");\n'
    '        if (!refs[id].length) delete refs[id];\n'
    '      }\n'
    '      refs[headId].push({ k: "remote", n: "origin/feat/t15g-graph-density", br: "t15g" });\n',
    '      const cur = current(), upstream = `origin/${cur.n}`;\n'
    '      for (const id of Object.keys(refs)) {\n'
    '        refs[id] = refs[id].filter((r) => r.n !== upstream);\n'
    '        if (!refs[id].length) delete refs[id];\n'
    '      }\n'
    '      refs[headId].push({ k: "remote", n: upstream, br: cur.br });\n')

# boot：同步強調色；?on=<branch> 直接開在該分支並選取 HEAD（模擬「開 repo 自動選 HEAD」）
sub('  renderDiff();\n  updateAhead();\n})();\n',
    '  renderDiff();\n  updateAhead();\n  syncLine();\n'
    '  // ?on=<branch> opens the demo already checked out there (e.g. ?on=main)\n'
    '  const on = new URLSearchParams(location.search).get("on");\n'
    '  if (on) { checkout(on); select(headId); }\n'
    '})();\n')

# 檔頭紀錄
sub("     the push flake moves per progress event under a CSS transition.\n",
    "     the push flake moves per progress event under a CSS transition.\n"
    "     Phase 0b: the accent follows the line you are on — click a local branch\n"
    "     to check it out, or open with ?on=main.\n")

p.write_text(s, encoding="utf-8")
print("patched", p.name, len(s), "chars")
