import { describe, expect, it } from "vitest";
import { computeRoutes } from "@/lib/routeMap";
import { legendRoundel, type RoundelLook } from "@/lib/rowRefs";
import { fixtureFor } from "@/dev/fidelity/states";

// 側欄每列的圓標 = 基準畫出來的樣子（Phase 5 5a step 7）。參照值是 2026-10-11 在 WKWebView 讀基準的側欄
// （mockup 工作副本：?on= 已在 state 之後、loading 是骨架圓點；讀法 `mockup/tools/sidebar-dump.js`
// 的 class、字母、--l），不是手推。格式：solid:T:rokusho / hollow:… / lodge::trunk / hollow.lodge::… /
// beyond（虛線圈）/ -（骨架圓點）
const fmt = (look: RoundelLook | null): string => {
  if (!look) return "-";
  if (look.beyond) return "beyond";
  const cls = [look.hollow && "hollow", look.lodge && "lodge"].filter(Boolean).join(".") || "solid";
  return `${cls}:${look.letter}:${look.color}`;
};

const REMOTES = [
  "R origin/feat/t15e-graph-layout hollow:E:odo",
  "R origin/feat/t15f-motion hollow:F:gunjo",
  "R origin/feat/t15g-graph-density hollow:T:rokusho",
  "R origin/feat/t9d-watcher beyond",
  "R origin/fix/toolbar-jump hollow:J:murasaki",
  "R origin/main hollow:M:trunk",
];
const DEFAULT = [
  "L feat/t15g-graph-density solid:T:rokusho",
  "L feat/t9d-watcher beyond",
  "L fix/toolbar-jump solid:J:murasaki",
  "L main solid:M:trunk",
  ...REMOTES,
];
const LODGERS = ["L release/0.1 lodge::trunk"];

const REFERENCE: Array<[label: string, on: string | null, states: string[], rows: string[]]> = [
  ["default", null, [], DEFAULT],
  ["onMain", "main", [], DEFAULT],
  ["detached", null, ["detached"], DEFAULT],
  ["noRemote", null, ["no-remote"], DEFAULT.filter((r) => r.startsWith("L "))],
  [
    "headBeyond",
    null,
    ["head-beyond"],
    [
      "L feat/old solid:O:odo",
      ...DEFAULT.filter((r) => r.startsWith("L ")),
      "R origin/feat/old hollow:O:odo",
      ...REMOTES,
    ],
  ],
  [
    "lodger",
    null,
    ["lodger"],
    [...DEFAULT.filter((r) => r.startsWith("L ")), ...LODGERS, ...REMOTES, "R origin/release/0.1 hollow.lodge::trunk"],
  ],
  [
    "longRefs",
    null,
    ["long-refs"],
    [
      "L feat/t14-unstaged-cap-and-console-discipline solid:U:shinsha",
      "L feat/t15g-graph-density solid:T:rokusho",
      "L feat/t9d-watcher beyond",
      "L main solid:M:trunk",
      ...LODGERS,
      "R origin/feat/t14-unstaged-cap-and-console-discipline hollow:U:shinsha",
      "R origin/feat/t15e-graph-layout hollow:E:odo",
      "R origin/feat/t15f-motion hollow:F:gunjo",
      "R origin/feat/t15g-graph-density hollow:T:rokusho",
      "R origin/feat/t9d-watcher beyond",
      "R origin/main hollow:M:trunk",
      "R origin/release/0.1 hollow.lodge::trunk",
    ],
  ],
  [
    "newBranch",
    null,
    ["new-branch"],
    [
      "L feat/t15g-graph-density solid:T:rokusho",
      "L feat/t9d-watcher beyond",
      "L feat/v8-graph solid:V:shinsha",
      "L fix/toolbar-jump solid:J:murasaki",
      "L main solid:M:trunk",
      ...REMOTES,
    ],
  ],
  [
    "routes",
    null,
    ["routes"],
    [
      "L feat/legend solid:L:murasaki",
      "L feat/notes solid:N:gunjo",
      "L feat/search solid:S:shinsha",
      "L fix/compass solid:C:rokusho",
      "L fix/gutter solid:G:odo",
      "L main solid:M:trunk",
      "R origin/feat/search hollow:S:shinsha",
      "R origin/main hollow:M:trunk",
    ],
  ],
  ["young", null, ["young"], ["L main solid:M:trunk"]],
  ["empty", null, ["empty"], []],
  // graph 還沒回來：名字已讀到，圓標等路線圖（Q-L）
  ["loading", null, ["loading"], DEFAULT.map((r) => r.replace(/ \S+$/, " -"))],
  // 視窗外的分支被 checkout：拿 HEAD 的字母 T 與偏好色（決策 D），feat/t15g-graph-density 讓出 T 變 G
  [
    "onBeyond",
    "feat/t9d-watcher",
    [],
    [
      "L feat/t15g-graph-density solid:G:rokusho",
      "L feat/t9d-watcher solid:T:shinsha",
      "L fix/toolbar-jump solid:J:murasaki",
      "L main solid:M:trunk",
      "R origin/feat/t15e-graph-layout hollow:E:odo",
      "R origin/feat/t15f-motion hollow:F:gunjo",
      "R origin/feat/t15g-graph-density hollow:G:rokusho",
      "R origin/feat/t9d-watcher hollow:T:shinsha",
      "R origin/fix/toolbar-jump hollow:J:murasaki",
      "R origin/main hollow:M:trunk",
    ],
  ],
  // 寄宿分支被 checkout：自己的 A 與偏好色，它的 remote 也是（空心）
  [
    "lodgerOnRelease",
    "release/0.1",
    ["lodger"],
    [
      ...DEFAULT.filter((r) => r.startsWith("L ")),
      "L release/0.1 solid:A:shinsha",
      ...REMOTES,
      "R origin/release/0.1 hollow:A:shinsha",
    ],
  ],
];

describe("legendRoundel: the sidebar's roundels match the reference", () => {
  it.each(REFERENCE)("test_legendRoundel_%s_matchesTheReference", (_label, on, states, rows) => {
    const d = fixtureFor(on, states);
    const routes = d.pending.includes("git_get_graph") ? null : computeRoutes(d.graph);
    const got = d.listBranches.branches.map(
      (b) => `${b.is_remote ? "R" : "L"} ${b.name} ${fmt(legendRoundel(routes, b, d.graph.head.branch))}`,
    );
    expect(got).toEqual(rows);
  });
});

describe("legendRoundel: before the route map knows the branch", () => {
  // 分支清單先重讀、graph 最後才到（runBranchOp）：剛建的分支還不在路線圖裡 → 骨架圓點，不猜
  it("test_legendRoundel_branchNotInTheRouteMapYet_isASkeletonDot", () => {
    const routes = computeRoutes(fixtureFor(null, []).graph);
    expect(legendRoundel(routes, { name: "feat/just-made", is_remote: false }, "feat/t15g-graph-density")).toBeNull();
  });
});
