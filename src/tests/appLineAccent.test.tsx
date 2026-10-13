import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import App from "@/App";
import { useRepoStore } from "@/stores/repoStore";
import { useGraphStore } from "@/stores/graphStore";
import { computeRoutes } from "@/lib/routeMap";
import type { GraphData } from "@/lib/tauri";
import { graph as fixtureGraph } from "@/dev/fidelity/fixture";

vi.mock("@/lib/tauri", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    getStatus: vi.fn(() =>
      Promise.resolve({ staged: [], unstaged: [], conflicted: [], unstaged_truncated: false }),
    ),
    githubGetAuthStatus: vi.fn(() => Promise.resolve({ authenticated: false, username: null })),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
// 讀不到 HEAD（HeadInfo 兩者皆 null；unborn 會帶分支名）→ 主幹（路線規則 §6.1）
const TRUNK_GRAPH: GraphData = {
  commits: [],
  branches: [],
  tags: [],
  truncated: false,
  head: { oid: null, branch: null },
  default_branch: null,
};
const line = () => document.documentElement.dataset.line;

function openRepo(graph: GraphData | null) {
  useRepoStore.setState({
    repoId: REPO,
    repoInfo: { path: "/tmp/repo", head_branch: "main", branches: [], remotes: ["origin"] },
  });
  useGraphStore.getState().actions.setRepoId(REPO);
  useGraphStore.getState().actions.setGraphData(graph);
}

describe("App line accent (html[data-line])", () => {
  beforeEach(() => {
    // 先放一個不是路線色的值（odo 等顏料都是 App 可能寫出的值），證明下面每個斷言都是 App 寫的
    document.documentElement.dataset.line = "unset";
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useRepoStore.setState({ repoId: null, repoInfo: null });
    useGraphStore.getState().actions.setGraphData(null);
  });

  it("test_app_lineAccent_followsTheLineYouAreOn", () => {
    const want = computeRoutes(fixtureGraph).accent;
    expect(want).not.toBe("trunk"); // fixture 的 HEAD 在自己的分支線上，否則這個測試證明不了什麼
    openRepo(fixtureGraph);
    render(<App />);
    expect(line()).toBe(want);
  });

  it("test_app_lineAccent_keptWhileTheNextGraphLoads", () => {
    openRepo(fixtureGraph);
    render(<App />);
    const before = line();
    expect(before).toBe(computeRoutes(fixtureGraph).accent); // 不是主幹，「沒閃回主幹」才驗得出來
    // applyOpenResult 換 repo 時先清空 graph 再載入：空檔不閃回主幹
    act(() => useGraphStore.getState().actions.setGraphData(null));
    expect(line()).toBe(before);
    act(() => useGraphStore.getState().actions.setGraphData(TRUNK_GRAPH));
    expect(line()).toBe("trunk");
    // 主幹也是路線圖失敗時的退路：確認是算出來的，不是例外被吞掉
    expect(console.error).not.toHaveBeenCalledWith("[kira] route map failed:", expect.anything());
  });

  it("test_app_lineAccent_noRepo_isTrunk", () => {
    useRepoStore.setState({ repoId: null, repoInfo: null });
    render(<App />);
    expect(line()).toBe("trunk");
  });
});
