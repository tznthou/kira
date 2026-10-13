import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import { ThemeSwitcher } from "@/components/ThemeSwitcher/ThemeSwitcher";
import { useThemeStore } from "@/stores/themeStore";

// jsdom 沒有 view transition：需要時掛一個替身。元件會接 ready，所以替身要回傳 ViewTransition 的形狀
const doc = document as unknown as { startViewTransition?: (cb: () => void) => unknown };
const transition = (ready: Promise<void> = Promise.resolve()) => ({
  ready,
  finished: Promise.resolve(),
  updateCallbackDone: Promise.resolve(),
});
const reduceMotion = (on: boolean) =>
  vi
    .spyOn(window, "matchMedia")
    .mockImplementation(
      (query: string) =>
        ({ matches: on && query === "(prefers-reduced-motion: reduce)", media: query }) as MediaQueryList,
    );

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: "light" });
    localStorage.clear();
    document.documentElement.setAttribute("data-theme", "light");
  });

  afterEach(() => {
    cleanup();
    delete doc.startViewTransition;
    vi.restoreAllMocks();
  });

  it("test_themeSwitcher_namesTheThemeItSwitchesTo", () => {
    const { getByRole } = render(<ThemeSwitcher />);
    const btn = getByRole("button", { name: "Switch to dark theme" });
    expect(btn.id).toBe("theme");
    expect(btn.title).toBe("白雲母摺 · white mica — click for black mica");
  });

  it("test_themeSwitcher_motionAllowed_switchesThroughViewTransition", () => {
    const vt = vi.fn((cb: () => void) => {
      cb();
      return transition();
    });
    doc.startViewTransition = vt;
    reduceMotion(false);
    const { getByRole } = render(<ThemeSwitcher />);
    fireEvent.click(getByRole("button"));
    expect(vt).toHaveBeenCalledTimes(1);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(getByRole("button").getAttribute("aria-label")).toBe("Switch to light theme");
    expect(getByRole("button").title).toBe("黒雲母摺 · black mica — click for white mica");
  });

  it("test_themeSwitcher_reducedMotion_switchesDirectly", () => {
    const vt = vi.fn((cb: () => void) => {
      cb();
      return transition();
    });
    doc.startViewTransition = vt;
    reduceMotion(true);
    const { getByRole } = render(<ThemeSwitcher />);
    fireEvent.click(getByRole("button"));
    expect(vt).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  // view transition 的回呼要等拍完舊畫面才跑：兩下快速點擊都落在回呼之前時，仍要各切一次
  it("test_themeSwitcher_twoQuickClicks_switchTwice", () => {
    const pending: (() => void)[] = [];
    doc.startViewTransition = vi.fn((cb: () => void) => {
      pending.push(cb);
      return transition();
    });
    reduceMotion(false);
    const { getByRole } = render(<ThemeSwitcher />);
    fireEvent.click(getByRole("button"));
    fireEvent.click(getByRole("button"));
    act(() => pending.forEach((cb) => cb()));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(useThemeStore.getState().theme).toBe("light");
  });

  // 連點：前一個 transition 被取代時 ready 會 reject（AbortError；視窗 hidden 時是 InvalidStateError）。
  // 回呼照跑、主題照切，但沒人接的 reject 會變成 unhandled rejection
  it("test_themeSwitcher_skippedTransition_leavesNoUnhandledRejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      doc.startViewTransition = vi.fn((cb: () => void) => {
        cb();
        return transition(Promise.reject(new DOMException("Transition was skipped", "AbortError")));
      });
      reduceMotion(false);
      const { getByRole } = render(<ThemeSwitcher />);
      fireEvent.click(getByRole("button"));
      fireEvent.click(getByRole("button"));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("test_themeSwitcher_noViewTransitions_switchesDirectly", () => {
    const { getByRole } = render(<ThemeSwitcher />);
    fireEvent.click(getByRole("button"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(getByRole("button"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
