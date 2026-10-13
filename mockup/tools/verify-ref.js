(() => {
  // 基準健檢：初始化有沒有跑完、決策有沒有生效；最後按下 Push 讓截圖拍到小金箔
  const r = {};
  r.rows = document.querySelectorAll(".row").length;
  r.branches = document.querySelectorAll(".branch").length;
  r.diffFiles = document.querySelectorAll(".dfile").length;
  r.beamGone = !document.querySelector(".beam, .glints");
  r.flecks = !!document.querySelector(".flecks");
  r.traffic = !!document.querySelector(".traffic");
  const refresh = document.getElementById("refresh");
  r.btnTransition = getComputedStyle(refresh).transitionProperty;
  r.textBtnTransition = getComputedStyle(document.getElementById("stage-all")).transitionProperty;
  document.getElementById("push").click();
  r.pushLabelAfterClick = document.querySelector("#push .label").textContent;
  r.carriageRunning = document.getElementById("carriage").classList.contains("run");
  return JSON.stringify(r, null, 1);
})()
