// V12：基準側欄分支清單的內容（每列：目前 * / 本機 L 遠端 R、名稱、圓標、計數、標籤）
(() => {
  const rows = [...document.querySelectorAll("#branch-list > li")].map((li) => {
    if (li.classList.contains("group-label")) return "[Remote]";
    if (li.classList.contains("empty-line")) return `[empty: ${li.textContent.trim()}]`;
    if (li.classList.contains("sk")) return "[skeleton]";
    const rd = li.querySelector(".rd");
    const name = li.querySelector(".b-name")?.textContent ?? "";
    const stats = [...li.querySelectorAll(".b-stats")]
      .map((s) => `${s.className.replace("b-stats", "").trim() || "gold"}:${s.textContent}`)
      .join(" ");
    const tag = li.querySelector(".b-tag")?.textContent ?? "";
    const rdDesc = rd
      ? `${[...rd.classList].filter((c) => c !== "rd").join(".") || "solid"}:${rd.textContent}:${rd.style.getPropertyValue("--l").trim()}`
      : "-";
    return `${li.classList.contains("current") ? "*" : " "}${li.classList.contains("remote") ? "R" : "L"} ${name} {${rdDesc}} ${stats} ${tag}`.trimEnd();
  });
  return rows.join("\n");
})()
