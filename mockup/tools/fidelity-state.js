(() => JSON.stringify({
  ready: document.documentElement.dataset.ready,
  theme: document.documentElement.dataset.theme,
  log: window.__fidelityLog,
  rows: document.querySelectorAll("svg g[role='button']").length,
  staged: document.body.innerText.includes("GraphCanvas.tsx"),
}, null, 1))()
