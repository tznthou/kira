import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { RepoSidebar } from "@/components/RepoSidebar/RepoSidebar";
import { useRecentReposStore } from "@/stores/recentReposStore";

// 側欄近期清單的 ~ 縮寫跟站牌同一個家目錄來源
vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return { ...actual, homeDir: vi.fn().mockResolvedValue("/Users/x"), getBranchStats: vi.fn().mockResolvedValue({}) };
});

const RECENT_SAMPLE = [
  { path: "/Users/x/projects/alpha", last_opened: 1715731200 },
  { path: "/Users/x/projects/beta", last_opened: 1715644800 },
];

describe("RepoSidebar", () => {
  beforeEach(() => {
    useRecentReposStore.setState({ recent: [], requestId: 0 });
  });

  afterEach(() => {
    cleanup();
  });

  it("test_repoSidebar_landingNoRecent_showsOpenAndEnabledClone", () => {
    const onPickAndOpen = vi.fn();
    const onOpenRecent = vi.fn();
    const onClickClone = vi.fn();
    const { getByRole, queryByText } = render(
      <RepoSidebar
        mode="landing"
        onPickAndOpen={onPickAndOpen}
        onOpenRecent={onOpenRecent}
        onClickClone={onClickClone}
      />,
    );

    const openBtn = getByRole("button", { name: /Open Repository/i });
    expect((openBtn as HTMLButtonElement).disabled).toBe(false);

    const cloneBtn = getByRole("button", { name: /Clone Repository/i });
    expect((cloneBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(cloneBtn);
    expect(onClickClone).toHaveBeenCalledTimes(1);

    expect(queryByText(/Recent repositories/i)).toBeNull();
  });

  it("test_repoSidebar_landingWithRecent_listsItemsAndOpensOnClick", () => {
    useRecentReposStore.setState({ recent: RECENT_SAMPLE });
    const onPickAndOpen = vi.fn();
    const onOpenRecent = vi.fn();
    const { getByText, getAllByRole } = render(
      <RepoSidebar
        mode="landing"
        onPickAndOpen={onPickAndOpen}
        onOpenRecent={onOpenRecent}
        onClickClone={vi.fn()}
      />,
    );

    expect(getByText(/Recent repositories/i)).not.toBeNull();
    expect(getByText("alpha")).not.toBeNull();
    expect(getByText("beta")).not.toBeNull();

    const items = getAllByRole("button").filter(
      (b) => b.title === "/Users/x/projects/alpha",
    );
    expect(items).toHaveLength(1);
    fireEvent.click(items[0]);
    expect(onOpenRecent).toHaveBeenCalledWith("/Users/x/projects/alpha");
  });

  it("test_repoSidebar_landing_clickOpen_callsPickAndOpen", () => {
    const onPickAndOpen = vi.fn();
    const onOpenRecent = vi.fn();
    const { getByRole } = render(
      <RepoSidebar
        mode="landing"
        onPickAndOpen={onPickAndOpen}
        onOpenRecent={onOpenRecent}
        onClickClone={vi.fn()}
      />,
    );

    fireEvent.click(getByRole("button", { name: /Open Repository/i }));
    expect(onPickAndOpen).toHaveBeenCalledTimes(1);
  });

  it("test_repoSidebar_landing_busy_disablesOpenAndShowsLabel", () => {
    const { getByRole } = render(
      <RepoSidebar
        mode="landing"
        onPickAndOpen={vi.fn()}
        onOpenRecent={vi.fn()}
        onClickClone={vi.fn()}
        busy
      />,
    );
    const openBtn = getByRole("button", { name: /Opening/i });
    expect((openBtn as HTMLButtonElement).disabled).toBe(true);
    // busy also gates the Clone button so user can't fire both flows at once
    const cloneBtn = getByRole("button", { name: /Clone Repository/i });
    expect((cloneBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("test_repoSidebar_landing_error_displaysMessage", () => {
    const { getByText } = render(
      <RepoSidebar
        mode="landing"
        onPickAndOpen={vi.fn()}
        onOpenRecent={vi.fn()}
        onClickClone={vi.fn()}
        error="Boom"
      />,
    );
    expect(getByText("Boom")).not.toBeNull();
  });

  // ---- panel mode（v8 基準的側欄，Phase 5 5a）----

  const renderPanel = (props: Partial<Parameters<typeof RepoSidebar>[0]> = {}) =>
    render(
      <RepoSidebar
        mode="panel"
        onPickAndOpen={props.onPickAndOpen ?? vi.fn()}
        onOpenRecent={props.onOpenRecent ?? vi.fn()}
        onClickClone={props.onClickClone ?? vi.fn()}
        busy={props.busy}
      />,
    );

  it("test_repoSidebar_panel_showsRecentAndBranchList", () => {
    useRecentReposStore.setState({ recent: RECENT_SAMPLE });
    const { container } = renderPanel();
    const titles = [...container.querySelectorAll(".side-sec .sec-title")].map((t) => t.textContent);
    expect(titles).toEqual(["Recent", "Branches"]);
    expect(container.querySelector(".side-sec.branches #branch-list")).not.toBeNull();
    // 分支清單還沒回來：骨架
    expect(container.querySelectorAll("#branch-list .sk-branch")).toHaveLength(4);
    expect([...container.querySelectorAll(".repo-item .ri-name")].map((n) => n.textContent)).toEqual(["alpha", "beta"]);
  });

  // 基準 .repo-item：名稱、~ 縮寫的路徑（同站牌的家目錄）、本地日期 y/m/d 不補零；完整路徑放 title
  it("test_repoSidebar_panel_recentItem_namePathAndDate", async () => {
    const noon = Math.floor(new Date(2026, 9, 3, 12, 0).getTime() / 1000);
    useRecentReposStore.setState({ recent: [{ path: "/Users/x/projects/alpha", last_opened: noon }] });
    const { container } = renderPanel();
    const item = container.querySelector<HTMLButtonElement>(".repo-item")!;
    expect(item.title).toBe("/Users/x/projects/alpha");
    await waitFor(() => expect(item.querySelector(".ri-path")?.textContent).toBe("~/projects/alpha"));
    expect(item.querySelector(".ri-date")?.textContent).toBe("2026/10/3");
  });

  it("test_repoSidebar_panel_clickRecent_opensIt", () => {
    useRecentReposStore.setState({ recent: RECENT_SAMPLE });
    const onOpenRecent = vi.fn();
    const { container } = renderPanel({ onOpenRecent });
    fireEvent.click(container.querySelectorAll<HTMLButtonElement>(".repo-item")[1]);
    expect(onOpenRecent).toHaveBeenCalledWith("/Users/x/projects/beta");
  });

  it("test_repoSidebar_panel_emptyRecent_showsNoRecentMessage", () => {
    const { container } = renderPanel();
    expect(container.querySelector(".side-sec .side-list .empty-line")?.textContent).toBe("No recent repositories");
  });

  it("test_repoSidebar_panel_footerButtons_callHandlers", () => {
    const onPickAndOpen = vi.fn();
    const onClickClone = vi.fn();
    const { container, getByRole } = renderPanel({ onPickAndOpen, onClickClone });
    expect([...container.querySelectorAll(".side-foot .btn")].map((b) => b.textContent)).toEqual(["Open", "Clone"]);
    fireEvent.click(getByRole("button", { name: "Open" }));
    expect(onPickAndOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(getByRole("button", { name: "Clone" }));
    expect(onClickClone).toHaveBeenCalledTimes(1);
  });

  // 開 repo 進行中：底部按鈕與近期清單停用
  it("test_repoSidebar_panel_busy_disablesFooterAndRecent", () => {
    useRecentReposStore.setState({ recent: RECENT_SAMPLE });
    const { container, getByRole } = renderPanel({ busy: true });
    expect((getByRole("button", { name: "Open" }) as HTMLButtonElement).disabled).toBe(true);
    expect((getByRole("button", { name: "Clone" }) as HTMLButtonElement).disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLButtonElement>(".repo-item")].every((b) => b.disabled)).toBe(true);
  });
});
