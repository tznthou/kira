(() => {
  // 基準實際畫出的走線（給 route_compare.mjs）：線那一組依繪製順序的 (顏色, 折線)，與每座橋 = 被挖洞的下層線 + 交點。
  // 交點從洞的那段套管與下層線的直段求，不讀基準的實作細節（洞要多長）
  const svg = document.getElementById("lanes");
  const pts = (d) => {
    const out = [];
    let x = 0, y = 0;
    for (const [, cmd, args] of d.matchAll(/([MLHV])([^MLHV]*)/g)) {
      const n = args.trim().split(/[\s,]+/).map(Number);
      if (cmd === "M" || cmd === "L") [x, y] = n;
      else if (cmd === "H") x = n[0];
      else y = n[0];
      out.push([x, y]);
    }
    return out;
  };
  // 套管那一組（全是 --sheet 的粗線）的下一組就是線
  const casings = [...svg.querySelectorAll("g")].find((g) => g.children.length && [...g.children].every((p) => p.getAttribute("stroke") === "var(--sheet)"));
  if (!casings) return JSON.stringify({ error: "no casing group" });
  const lines = [...casings.nextElementSibling.children].map((p) => ({
    color: (p.getAttribute("stroke").match(/--l-([a-z]+)/) || [])[1], pts: pts(p.getAttribute("d")), mask: p.getAttribute("mask"),
  }));
  const crossings = [];
  for (const l of lines) {
    if (!l.mask) continue;
    const mask = document.getElementById(l.mask.match(/#([^)]+)/)[1]);
    for (const piece of mask.querySelectorAll("path")) {
      const [[ax, ay], [bx, by]] = pts(piece.getAttribute("d"));
      l.pts.forEach((q, s) => {
        const p = l.pts[s - 1];
        if (!p || p[0] !== q[0] || p[0] <= Math.min(ax, bx) || p[0] >= Math.max(ax, bx)) return;
        const y = ay + ((p[0] - ax) / (bx - ax)) * (by - ay);
        if (y > Math.min(p[1], q[1]) && y < Math.max(p[1], q[1])) crossings.push({ lower: l.pts, x: p[0], y });
      });
    }
  }
  return JSON.stringify({ lines: lines.map(({ color, pts }) => ({ color, pts })), crossings, holes: lines.filter((l) => l.mask).length });
})()
