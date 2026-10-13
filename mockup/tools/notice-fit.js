// 失敗提示文案放不放得下：把候選字串塞進 #notice-text，量 scrollWidth − clientWidth（>0 = 被截）。
// 用法：wk-shot "<基準>?state=signed-out,diverged,error-auth" 1200 800 - notice-fit.js ready
// 最擠的情境 = 最窄視窗 + 帳號位最寬（未登入）+ Pull 帶落後計數（#pull 沒有 min-width）；
// 少了任一項都會量出錯誤的「fits」（2026-10-05 獨立審查抓到）

(() => {
  const C = [
    ["Push failed.", "Authentication required."],
    ["Push failed.", "Network error."],
    ["Push rejected.", "Pull first."],
    ["Push failed.", "Remote not found."],
    ["Push failed.", "Branch name not allowed."],
    ["Publish failed.", "Branch name not allowed."],
    ["Pull failed.", "Authentication required."],
    ["Can't fast-forward.", "Merge manually."],
    ["Pull failed.", "Commit your changes first."],
    ["Refresh failed.", ""],
    ["Graph reload failed.", "Your commit is saved."],
    ["Couldn't open repository.", ""],
    ["Couldn't open repository.", "It may have been moved or deleted."],
    ["Couldn't open repository.", "It may have moved."],
    ["Couldn't open repo.", ""],
    ["Couldn't open repo.", "It may have moved."],
    ["GitHub sign-in failed.", "Check your network."],
    ["Sign out failed.", "Try again."],
    // 0b P5：側欄與 Changes 按了才失敗的（規格 §3 站牌提示文案）
    ["Checkout failed.", "Commit or stash first."],
    ["Checkout failed.", "Finish the merge first."],
    ["Checkout failed.", "Branch not found."],
    ["Delete failed.", "Unmerged commits."],
    ["Delete failed.", "It has unmerged commits."],
    ["Delete failed.", "Switch branches first."],
    ["Create failed.", "Name already taken."],
    ["Create failed.", "Invalid name."],
    ["Create failed.", "Commit something first."],
    ["Stage failed.", ""],
    ["Unstage failed.", ""],
    ["Stage all failed.", ""],
    ["Unstage all failed.", ""],
    ["Commit failed.", ""],
    ["Commit failed.", "Set your git name and email."],
  ];
  const t = document.getElementById("notice-text");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return C.map(([a, b]) => {
    // 與基準 showNotice 相同：標題與說明之間有一個空格（第一版漏了它，量出來偏寬鬆）
    t.innerHTML = `<b>${esc(a)}</b>${b ? " " + esc(b) : ""}`;
    const over = t.scrollWidth - t.clientWidth;
    return `${over > 0 ? "CUT " + String(over).padStart(3) + "px" : "fits      "}  ${a} ${b}`;
  }).join("\n") + `\n(text box ${t.clientWidth}px)`;
})()
