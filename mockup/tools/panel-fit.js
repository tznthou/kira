// 0b P5 新文案放不放得下：量每個新元素有沒有被截（scrollWidth > clientWidth）、有沒有超出它所在的框
// （側欄的列 = .branch-btn，其餘 = 所在的 .sheet），段落另報幾行。
// 用法：wk-shot "<基準>?state=…[&tab=prs]" 1200 800 - panel-fit.js ready
// 側欄的計數 / pruned 標籤是 flex: none，名稱先截（…）；這裡驗的是標籤本身完整、沒被擠出列外
(() => {
  const out = [];
  const SEL = ".strip, .dcell, .dcell code, .pane-empty p, .pane-empty .btn, .diff-empty p, .diff-empty .btn, .b-tag, .b-stats, "
    + ".stage-head, .pr-body .empty-line, .badge.C, #n-unstaged";
  for (const el of document.querySelectorAll(SEL)) {
    if (!el.getClientRects().length || el.closest("[hidden]")) continue;
    const box = (el.closest(".branch-btn") || el.closest(".sheet") || document.body).getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const over = el.scrollWidth - el.clientWidth;
    const out_r = Math.round(r.right - box.right), out_l = Math.round(box.left - r.left);
    const cs = getComputedStyle(el), lh = parseFloat(cs.lineHeight) || 18;
    const inner = r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const lines = el.tagName === "P" || el.classList.contains("strip") ? ` ${Math.round(inner / lh)} line(s)` : "";
    const bad = over > 0 || out_r > 0 || out_l > 0;
    const name = (el.className || el.id || el.tagName).toString().split(" ")[0];
    out.push(`${bad ? "CUT " : "fits"}  ${name.padEnd(10)} ${String(Math.round(r.width)).padStart(4)}px${lines}${over > 0 ? ` scroll+${over}` : ""}${out_r > 0 ? ` past right ${out_r}` : ""}${out_l > 0 ? ` past left ${out_l}` : ""}  ${el.innerText.replace(/\s+/g, " ").slice(0, 70)}`);
  }
  return out.join("\n") || "(nothing measured)";
})()
