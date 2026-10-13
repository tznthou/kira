import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { Topbar } from "@/components/Topbar/Topbar";
import { useRepoStore } from "@/stores/repoStore";
import { useNoticeStore } from "@/stores/noticeStore";
import { computeRoutes } from "@/lib/routeMap";
import { fixtureFor } from "@/dev/fidelity/states";
import * as fx from "@/dev/fidelity/fixture";

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return { ...actual, homeDir: vi.fn() };
});

import { homeDir } from "@/lib/tauri";

const mockedHomeDir = vi.mocked(homeDir);

function renderTopbar(state: { on?: string | null; states?: string[] } = {}, tools = <button id="push">Push</button>) {
  const d = fixtureFor(state.on ?? null, state.states ?? []);
  useRepoStore.setState({ repoInfo: d.repoInfo });
  return render(
    <Topbar routes={computeRoutes(d.graph)} head={d.graph.head}>
      {tools}
    </Topbar>,
  );
}

describe("Topbar", () => {
  beforeEach(() => {
    mockedHomeDir.mockReset();
    mockedHomeDir.mockResolvedValue(fx.HOME);
    useNoticeStore.setState({ notice: null });
  });

  afterEach(() => {
    cleanup();
  });

  // 基準：「kira」+「~/Documents/kira」，完整路徑放 title
  it("test_topbar_station_namesTheRepoAndAbbreviatesHome", async () => {
    const { container } = renderTopbar();
    expect(container.querySelector(".st-name")?.textContent).toBe("kira");
    const path = container.querySelector(".st-path")!;
    expect(path.getAttribute("title")).toBe(fx.REPO_PATH);
    await waitFor(() => expect(path.textContent).toBe("~/Documents/kira"));
  });

  it("test_topbar_station_showsTheWholePathWithoutAHome", async () => {
    mockedHomeDir.mockResolvedValue(null);
    const { container } = renderTopbar();
    await waitFor(() => expect(container.querySelector(".st-path")?.textContent).toBe(fx.REPO_PATH));
  });

  // 期望值同 fidelityStates.test.ts 的 REFERENCE（WKWebView 實跑基準讀出）
  it("test_topbar_youAre_onABranch", () => {
    const { container } = renderTopbar();
    const you = container.querySelector("#youare")!;
    expect(you.getAttribute("title")).toBe("Current branch");
    expect(container.querySelector("#you-lbl")?.textContent).toBe("You are on");
    const rd = container.querySelector<HTMLElement>("#you-rd")!;
    expect(rd.textContent).toBe("T");
    expect(rd.style.getPropertyValue("--l")).toBe("var(--l-rokusho)");
    const bn = container.querySelector("#you-bn")!;
    expect(bn.textContent).toBe("feat/t15g-graph-density");
    expect(bn.className).toBe("bn");
  });

  it("test_topbar_youAre_onMainIsTheTrunk", () => {
    const { container } = renderTopbar({ on: "main" });
    expect(container.querySelector("#you-rd")?.textContent).toBe("M");
    expect(container.querySelector<HTMLElement>("#you-rd")!.style.getPropertyValue("--l")).toBe("var(--l-trunk)");
    expect(container.querySelector("#you-bn")?.textContent).toBe("main");
  });

  it("test_topbar_youAre_detachedShowsTheStation", () => {
    const { container } = renderTopbar({ states: ["detached"] });
    expect(container.querySelector("#you-lbl")?.textContent).toBe("Detached at");
    const bn = container.querySelector("#you-bn")!;
    expect(bn.textContent).toBe("7b03d5e");
    expect(bn.className).toBe("bn mono");
    expect(container.querySelector("#youare")?.getAttribute("title")).toBe(
      "HEAD is detached at 7b03d5e — no branch is checked out",
    );
    expect(container.querySelector("#you-rd")?.textContent).toBe("T");
  });

  // 載入中（graphData 先清空）、讀不到 HEAD（HeadInfo 兩者皆 null）：只留站名，不崩潰
  it("test_topbar_youAre_absentWhileLoadingOrHeadUnreadable", () => {
    useRepoStore.setState({ repoInfo: fx.repoInfo });
    const loading = render(<Topbar routes={null} head={null}>{null}</Topbar>);
    expect(loading.container.querySelector("#youare")).toBeNull();
    expect(loading.container.querySelector(".st-name")?.textContent).toBe("kira");
    cleanup();

    const unreadable = { ...fx.graph, commits: [], branches: [], tags: [], head: { oid: null, branch: null } };
    const { container } = render(
      <Topbar routes={computeRoutes(unreadable)} head={unreadable.head}>
        {null}
      </Topbar>,
    );
    expect(container.querySelector("#youare")).toBeNull();
    expect(container.querySelector(".st-name")?.textContent).toBe("kira");
  });

  // unborn（git init 後還沒 commit）：照樣寫分支（主幹 M），後面加 note（基準 ?state=empty）
  it("test_topbar_youAre_unbornNamesTheBranchWithANote", () => {
    useRepoStore.setState({ repoInfo: fx.repoInfo });
    const unborn = { ...fx.graph, commits: [], branches: [], tags: [], head: { oid: null, branch: "main" } };
    const { container } = render(
      <Topbar routes={computeRoutes(unborn)} head={unborn.head}>
        {null}
      </Topbar>,
    );
    expect(container.querySelector("#you-lbl")?.textContent).toBe("You are on");
    const rd = container.querySelector<HTMLElement>("#you-rd")!;
    expect(rd.textContent).toBe("M");
    expect(rd.style.getPropertyValue("--l")).toBe("var(--l-trunk)");
    expect(container.querySelector("#you-bn")?.textContent).toBe("main");
    expect(container.querySelector("#you-note")?.textContent).toBe("No commits yet");
    expect(container.querySelector("#youare")?.getAttribute("title")).toBe("main has no commits yet");
  });

  it("test_topbar_youAre_noNoteOnceThereAreCommits", () => {
    const { container } = renderTopbar();
    expect(container.querySelector("#you-note")).toBeNull();
  });

  // detached 在 graph 視窗外：路線放不下 HEAD、沒有字母 → 一樣只留站名
  it("test_topbar_youAre_absentWhenHeadIsOutsideTheWindow", () => {
    useRepoStore.setState({ repoInfo: fx.repoInfo });
    const graph = { ...fx.graph, head: { oid: "f".repeat(40), branch: null } };
    const routes = computeRoutes(graph);
    expect(routes.head.letter).toBeNull();
    const { container } = render(
      <Topbar routes={routes} head={graph.head}>
        {null}
      </Topbar>,
    );
    expect(container.querySelector("#youare")).toBeNull();
  });

  it("test_topbar_notice_takesTheStationsPlace", () => {
    const { container } = renderTopbar();
    expect(container.querySelector(".topbar")?.className).toBe("topbar");
    act(() => useNoticeStore.getState().show({ title: "Push rejected.", detail: "Pull first.", from: "push" }));
    expect(container.querySelector(".topbar")?.className).toBe("topbar has-notice");
    const notice = container.querySelector("#notice")!;
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.getAttribute("title")).toBe("Push rejected. Pull first.");
    expect(container.querySelector("#notice-text")?.innerHTML).toBe("<b>Push rejected.</b> Pull first.");
  });

  it("test_topbar_notice_withoutDetailIsTheVerdictAlone", () => {
    const { container } = renderTopbar();
    act(() => useNoticeStore.getState().show({ title: "Refresh failed.", from: "refresh" }));
    expect(container.querySelector("#notice")?.getAttribute("title")).toBe("Refresh failed.");
    expect(container.querySelector("#notice-text")?.innerHTML).toBe("<b>Refresh failed.</b>");
  });

  it("test_topbar_notice_dismissReturnsFocusToTheButton", () => {
    const { container, getByRole } = renderTopbar();
    act(() => useNoticeStore.getState().show({ title: "Push rejected.", detail: "Pull first.", from: "push" }));
    fireEvent.click(getByRole("button", { name: "Dismiss" }));
    expect(useNoticeStore.getState().notice).toBeNull();
    expect(container.querySelector(".topbar")?.className).toBe("topbar");
    expect(document.activeElement?.id).toBe("push");
  });

  // 側欄的列、Changes 的按鈕會重畫：from 給函式，× 的時候才去找，拿到的是當下的節點
  it("test_topbar_notice_dismissFindsTheElementWhenClosed", () => {
    const { getByRole } = renderTopbar();
    let target: HTMLElement | null = null;
    act(() =>
      useNoticeStore.getState().show({ title: "Checkout failed.", detail: "Commit or stash first.", from: () => target }),
    );
    // 提示出現之後列才重畫成新節點
    const row = document.createElement("button");
    row.textContent = "main";
    document.body.appendChild(row);
    target = row;
    fireEvent.click(getByRole("button", { name: "Dismiss" }));
    expect(document.activeElement).toBe(row);
    row.remove();
  });
});
