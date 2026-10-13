import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";

// macOS 全螢幕讓位（html[data-chrome]）：tauri.ts 的 watchFullscreen 與 App 的接法。
// @tauri-apps/api/window 換成可控的假視窗；getCurrentWindow 可以同步 throw（同真的、沒有 metadata 時）
const h = vi.hoisted(() => ({
  throwOnGet: false,
  queries: [] as { resolve: (full: boolean) => void; reject: (e: unknown) => void }[],
  resized: null as (() => void) | null,
  unlisten: vi.fn(),
  listenFails: false,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    if (h.throwOnGet) throw new TypeError("Cannot read properties of undefined (reading 'metadata')");
    return {
      isFullscreen: () =>
        new Promise<boolean>((resolve, reject) => {
          h.queries.push({ resolve, reject });
        }),
      onResized: (handler: () => void) => {
        if (h.listenFails) return Promise.reject(new Error("no event permission"));
        h.resized = handler;
        return Promise.resolve(h.unlisten);
      },
    };
  },
}));

import { watchFullscreen } from "@/lib/tauri";
import App from "@/App";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const flush = () => act(async () => {});

beforeEach(() => {
  h.throwOnGet = false;
  h.queries = [];
  h.resized = null;
  h.unlisten = vi.fn();
  h.listenFails = false;
  document.documentElement.removeAttribute("data-chrome");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-chrome");
});

describe("watchFullscreen", () => {
  it("test_watchFullscreen_queriesOnStartAndOnEveryResize", async () => {
    const seen: boolean[] = [];
    watchFullscreen((full) => seen.push(full));
    h.queries[0].resolve(false);
    await flush();
    h.resized!();
    h.queries[1].resolve(true);
    await flush();
    expect(seen).toEqual([false, true]);
  });

  // 多個查詢的回應未必照順序回來：只採用最後一次發出的
  it("test_watchFullscreen_theLastQueryWins", async () => {
    const seen: boolean[] = [];
    watchFullscreen((full) => seen.push(full));
    h.resized!();
    h.queries[1].resolve(false);
    h.queries[0].resolve(true);
    await flush();
    expect(seen).toEqual([false]);
  });

  it("test_watchFullscreen_failedQueryMeansNotFullScreen", async () => {
    const seen: boolean[] = [];
    watchFullscreen((full) => seen.push(full));
    h.queries[0].reject(new Error("ipc"));
    await flush();
    expect(seen).toEqual([false]);
  });

  // 非 Tauri 環境 getCurrentWindow 同步 throw：退回「不是全螢幕」，不往外丟
  it("test_watchFullscreen_noWindowFallsBack", () => {
    h.throwOnGet = true;
    const seen: boolean[] = [];
    expect(() => watchFullscreen((full) => seen.push(full))).not.toThrow();
    expect(seen).toEqual([false]);
  });

  it("test_watchFullscreen_stopIgnoresLateAnswersAndUnlistens", async () => {
    const seen: boolean[] = [];
    const stop = watchFullscreen((full) => seen.push(full));
    await flush();
    stop();
    h.queries[0].resolve(true);
    await flush();
    expect(seen).toEqual([]);
    expect(h.unlisten).toHaveBeenCalled();
  });

  it("test_watchFullscreen_listenFailureStillQueriesOnce", async () => {
    h.listenFails = true;
    const seen: boolean[] = [];
    watchFullscreen((full) => seen.push(full));
    h.queries[0].resolve(true);
    await flush();
    expect(seen).toEqual([true]);
  });
});

describe("App: html[data-chrome]", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("test_appChrome_macOS_followsFullScreen", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(MAC);
    render(<App />);
    await waitFor(() => expect(h.queries).toHaveLength(1));
    h.queries[0].resolve(false);
    await waitFor(() => expect(document.documentElement.dataset.chrome).toBe("on"));

    h.resized!();
    h.queries[1].resolve(true);
    await waitFor(() => expect(document.documentElement.dataset.chrome).toBe("full"));

    h.resized!();
    h.queries[2].resolve(false);
    await waitFor(() => expect(document.documentElement.dataset.chrome).toBe("on"));
  });

  // 非 macOS：首繪 inline script 已寫 full，App 完全不碰（退回值 on 會把它蓋掉）
  it("test_appChrome_otherPlatforms_leaveTheFirstPaintValue", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(LINUX);
    document.documentElement.dataset.chrome = "full";
    render(<App />);
    await flush();
    expect(h.queries).toHaveLength(0);
    expect(document.documentElement.dataset.chrome).toBe("full");
  });
});
