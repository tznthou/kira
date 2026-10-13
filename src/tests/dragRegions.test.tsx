import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Topbar } from "@/components/Topbar/Topbar";
import { RepoSidebar } from "@/components/RepoSidebar/RepoSidebar";
import { CloneRepoModal } from "@/components/CloneRepo/CloneRepoModal";
import { CheckoutConfirmDialog } from "@/components/BranchList/dialogs";
import { DeviceCodeModal } from "@/components/Auth/DeviceCodeModal";

// Overlay 標題列下只有標了 data-tauri-drag-region 的地方能拖視窗（Tauri 的 drag.js：無值 / "true" =
// 只有元素本身，"deep" = 整個子樹，"false" = 擋住）。jsdom 測不到真的拖曳，這裡守 DOM 契約；
// 實際拖不拖得動列在 D5 實機
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return { ...actual, githubPollToken: vi.fn(() => new Promise(() => {})), homeDir: vi.fn(() => Promise.resolve(null)) };
});

const STRIP = "absolute inset-x-0 top-0 h-[60px]";

/** 對話框的拖曳帶：deep、同站牌高、在遮罩頂端；DOM 順序在 Dismiss 之後、卡片之前（畫在 Dismiss
 *  上面，點它不會關對話框；卡片要 relative 才畫得在它上面） */
function expectDialogStrip(root: Element) {
  const strip = root.querySelector('[data-tauri-drag-region="deep"]');
  expect(strip, "drag strip").not.toBeNull();
  expect(strip!.className).toBe(STRIP);
  const siblings = [...strip!.parentElement!.children];
  const at = siblings.indexOf(strip!);
  const dismiss = siblings.findIndex((e) => e.getAttribute("aria-label") === "Dismiss dialog");
  if (dismiss !== -1) expect(dismiss).toBeLessThan(at);
  const card = siblings[at + 1];
  expect(card, "card after the strip").toBeDefined();
  expect(card.className.split(" ")).toContain("relative");
}

afterEach(() => {
  cleanup();
});

describe("drag regions under the overlay title bar", () => {
  it("test_dragRegions_stationSignIsDeep", () => {
    const { container } = render(
      <Topbar routes={null} head={null}>
        {null}
      </Topbar>,
    );
    expect(container.querySelector(".topbar")?.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  // 首頁沒有站牌：根節點裡頂端一條拖曳帶（放外面會被滿版、疊在上層的根節點蓋住）
  it("test_dragRegions_landingHasATopStrip", () => {
    const { container } = render(
      <RepoSidebar mode="landing" onPickAndOpen={vi.fn()} onOpenRecent={vi.fn()} onClickClone={vi.fn()} />,
    );
    const root = container.firstElementChild!;
    const strip = root.firstElementChild!;
    expect(strip.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect(strip.className).toBe(STRIP);
  });

  it("test_dragRegions_cloneDialogHasAStrip", () => {
    render(<CloneRepoModal open onClose={vi.fn()} onOpened={vi.fn()} />);
    expectDialogStrip(document.querySelector('[role="dialog"]')!);
  });

  it("test_dragRegions_branchDialogHasAStrip", () => {
    render(<CheckoutConfirmDialog branchName="feat/x" busy={false} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expectDialogStrip(document.querySelector('[role="dialog"]')!);
  });

  it("test_dragRegions_deviceCodeDialogHasAStrip", () => {
    render(
      <DeviceCodeModal
        flow={{
          device_code: "dc",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
          expires_at: Date.now() + 900_000,
        }}
      />,
    );
    const code = document.body.querySelector(".select-all")!;
    expectDialogStrip(code.closest(".fixed")!);
  });
});
