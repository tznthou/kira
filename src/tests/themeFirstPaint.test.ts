import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useThemeStore, initTheme } from "@/stores/themeStore";
import { isMacOS } from "@/lib/platform";

const KEY = "kira-theme-v8";
const LEGACY_KEY = "kira-theme";
const saved = (theme: unknown) => JSON.stringify({ state: { theme }, version: 0 });

// index.html 在 <head> 裡、首繪前就套用主題的 inline script（模組腳本要等解析完才跑，
// 暗色使用者會先閃一下 v8 預設的亮色）
function firstPaintScript(): string {
  const html = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  const inline = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(inline, "index.html has no inline theme script in <head>").toHaveLength(1);
  return inline[0];
}

// 首繪時的主題必須等於 store 開機後的主題，否則首繪後還會再跳一次
async function themes(storage: Record<string, string>) {
  useThemeStore.setState({ theme: "light" });
  localStorage.clear();
  for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
  document.documentElement.removeAttribute("data-theme");
  new Function(firstPaintScript())();
  const firstPaint = document.documentElement.getAttribute("data-theme");
  await useThemeStore.persist.rehydrate();
  initTheme();
  return { firstPaint, afterBoot: document.documentElement.getAttribute("data-theme") };
}

describe("theme before first paint (index.html)", () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: "light" });
    localStorage.clear();
  });

  it.each([
    ["nothing saved", {}, "light"],
    ["v8 dark", { [KEY]: saved("dark") }, "dark"],
    ["v8 light wins over legacy ink", { [KEY]: saved("light"), [LEGACY_KEY]: saved("ink") }, "light"],
    ["legacy ink", { [LEGACY_KEY]: saved("ink") }, "dark"],
    ["legacy paper", { [LEGACY_KEY]: saved("paper") }, "light"],
    ["legacy corrupt", { [LEGACY_KEY]: "{not json" }, "light"],
    ["v8 invalid value falls back to legacy", { [KEY]: saved("sepia"), [LEGACY_KEY]: saved("ink") }, "dark"],
    ["v8 corrupt stays light like the store", { [KEY]: "{not json", [LEGACY_KEY]: saved("ink") }, "light"],
  ])("test_firstPaint_%s_matchesBoot", async (_name, storage, want) => {
    expect(await themes(storage)).toEqual({ firstPaint: want, afterBoot: want });
  });
});

// 非 macOS 沒有紅綠燈：首繪前就寫 data-chrome="full"（否則先畫出 83px 留白再跳）；macOS 不寫，交給 App
// 依全螢幕切換。jsdom 的 UA 帶 process.platform（本機 darwin、CI linux），所以每個案例明確設定 UA
describe("chrome before first paint (index.html)", () => {
  const UAS: [string, string, boolean][] = [
    ["macOS WKWebView", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)", true],
    [
      "Windows WebView2",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      false,
    ],
    ["Linux WebKitGTK", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)", false],
  ];

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.removeAttribute("data-chrome");
  });

  it.each(UAS)("test_firstPaintChrome_%s", (_name, ua, mac) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
    document.documentElement.removeAttribute("data-chrome");
    new Function(firstPaintScript())();
    expect(document.documentElement.getAttribute("data-chrome")).toBe(mac ? null : "full");
    // 與 App 用的規則一致（inline script 不能 import，兩處各寫一次）
    expect(isMacOS()).toBe(mac);
  });
});
