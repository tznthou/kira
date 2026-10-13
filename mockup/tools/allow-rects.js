// ref_guard --allow 用：可以有差異的區塊（css px，[left, top, right, bottom]）；新舊兩版各量一次取聯集
(() => {
  const r = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return [b.left, b.top, b.right, b.bottom];
  };
  return JSON.stringify({
    branches: r("#branch-list"),
    diff: r(".diff-pane"),
    pane: r(".side-pane"),
    topbar: r(".topbar"),
  });
})()
