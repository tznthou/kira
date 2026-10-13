(() => {
  // 基準 mockup 的五個區塊（CSS px）；比對腳本取相鄰 sheet 間隙的中線當區界
  const r = (sel) => {
    const b = document.querySelector(sel).getBoundingClientRect();
    return [b.left, b.top, b.width, b.height];
  };
  return JSON.stringify({
    topbar: r(".topbar"),
    sidebar: r(".sidebar"),
    graph: r(".graph-pane"),
    pane: r(".side-pane"),
    diff: r(".diff-pane"),
    vw: innerWidth,
    vh: innerHeight,
  });
})()
