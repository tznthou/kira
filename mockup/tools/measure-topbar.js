(() => {
  const r = {};
  const round = (v) => Math.round(v * 100) / 100;
  const refresh = document.getElementById("refresh");
  const push = document.getElementById("push");
  const natural = (el) => {
    const mw = el.style.minWidth;
    el.style.minWidth = "0px";
    const w = el.getBoundingClientRect().width;
    el.style.minWidth = mw;
    return round(w);
  };
  const lbl = (el) => el.querySelector(".label");
  r.refresh = {};
  for (const t of ["Refresh", "Refreshing…"]) { lbl(refresh).textContent = t; r.refresh[t] = natural(refresh); }
  lbl(refresh).textContent = "Refresh";
  r.push = {};
  for (const t of ["Push", "88%", "100%"]) { lbl(push).textContent = t; r.push[t] = natural(push); }
  lbl(push).textContent = "Push";
  r.minWidths = { refresh: getComputedStyle(refresh).minWidth, push: getComputedStyle(push).minWidth };
  const h = document.querySelector(".hash");
  r.hash = { text: h.textContent, width: round(h.getBoundingClientRect().width), font: getComputedStyle(h).fontFamily };
  r.subjectFont = getComputedStyle(document.querySelector(".subject")).fontFamily;
  r.chrome = document.documentElement.dataset.chrome;
  r.theme = document.documentElement.dataset.theme;
  r.lang = document.documentElement.lang;
  const pos = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return [round(b.left), round(b.top), round(b.width), round(b.height)];
  };
  r.pos = { traffic: pos(".traffic"), brand: pos(".brand"), station: pos(".station"), youare: pos(".youare"), tools: pos(".tools"), graphPane: pos(".graph-pane"), firstRow: pos(".row") };
  const bn = document.querySelector(".youare .bn");
  r.bnTruncated = bn.scrollWidth > bn.clientWidth;
  const subj = [...document.querySelectorAll(".subject")];
  r.subjectsTruncated = subj.filter((s) => s.scrollWidth > s.clientWidth).length + "/" + subj.length;
  return JSON.stringify(r, null, 1);
})()
