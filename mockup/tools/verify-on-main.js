(() => {
  const r = {};
  r.line = document.documentElement.dataset.line;
  r.youAre = document.getElementById("you-bn").textContent + " / " + document.getElementById("you-rd").textContent;
  r.headPill = [...document.querySelectorAll(".ref.head span:last-child")].map((e) => e.textContent);
  r.selectedRow = document.querySelector('.row[aria-selected="true"] .hash')?.textContent;
  r.currentBranch = document.querySelector(".branch.current .b-name")?.textContent;
  r.pushCountShown = getComputedStyle(document.getElementById("ahead")).display !== "none";
  const cs = getComputedStyle(document.documentElement);
  r.lineToken = cs.getPropertyValue("--line").trim();
  r.selectedToken = cs.getPropertyValue("--selected").trim();
  return JSON.stringify(r, null, 1);
})()
