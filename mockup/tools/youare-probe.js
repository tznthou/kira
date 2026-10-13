// 基準的「你在這裡」：圓標字母、圓標顏色、data-line、站牌文字（youare_probe.sh 用）
(() => JSON.stringify({
  line: document.documentElement.dataset.line,
  letter: document.getElementById("you-rd").textContent,
  rdL: document.getElementById("you-rd").style.getPropertyValue("--l"),
  lbl: document.getElementById("you-lbl").textContent,
  bn: document.getElementById("you-bn").textContent,
  // Phase 4：loading 時站牌隱藏、unborn 時有 note
  hidden: document.getElementById("youare").hidden,
  note: document.getElementById("you-note").hidden ? null : document.getElementById("you-note").textContent,
}))()
