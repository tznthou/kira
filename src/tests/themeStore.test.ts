import { describe, it, expect, beforeEach } from "vitest";
import { useThemeStore, initTheme } from "@/stores/themeStore";

const KEY = "kira-theme-v8";
const LEGACY_KEY = "kira-theme";
const saved = (theme: unknown) => JSON.stringify({ state: { theme }, version: 0 });

// 模擬 app 啟動：store 依目前的 localStorage 重新 hydrate，再跑 main.tsx 的 initTheme
async function boot() {
  await useThemeStore.persist.rehydrate();
  initTheme();
  return {
    store: useThemeStore.getState().theme,
    dom: document.documentElement.getAttribute("data-theme"),
  };
}

describe("themeStore", () => {
  beforeEach(() => {
    // persist 包過的 setState 會寫進 storage：先重設 state 再清，每個測試才從空的 storage 開始
    useThemeStore.setState({ theme: "light" });
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("test_themeStore_toggle_lightToDark_writesAttr", () => {
    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("test_themeStore_toggle_darkToLight_writesAttr", () => {
    useThemeStore.setState({ theme: "dark" });
    useThemeStore.getState().toggle();
    expect(useThemeStore.getState().theme).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("test_themeStore_setTheme_writesAttrDirectly", () => {
    useThemeStore.getState().setTheme("dark");
    expect(useThemeStore.getState().theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("test_boot_savedV8Choice_restored", async () => {
    localStorage.setItem(KEY, saved("dark"));
    expect(await boot()).toEqual({ store: "dark", dom: "dark" });
  });

  describe("migration from the pre-v8 key (read only)", () => {
    it("test_boot_noKeys_defaultsLight", async () => {
      expect(await boot()).toEqual({ store: "light", dom: "light" });
    });

    it("test_boot_legacyInk_becomesDark", async () => {
      localStorage.setItem(LEGACY_KEY, saved("ink"));
      expect(await boot()).toEqual({ store: "dark", dom: "dark" });
    });

    it("test_boot_legacyPaper_becomesLight", async () => {
      localStorage.setItem(LEGACY_KEY, saved("paper"));
      expect(await boot()).toEqual({ store: "light", dom: "light" });
    });

    it("test_boot_legacyCorrupt_defaultsLight", async () => {
      localStorage.setItem(LEGACY_KEY, "{not json");
      expect(await boot()).toEqual({ store: "light", dom: "light" });
    });

    it("test_boot_v8KeyWinsOverLegacy", async () => {
      localStorage.setItem(LEGACY_KEY, saved("ink"));
      localStorage.setItem(KEY, saved("light"));
      expect(await boot()).toEqual({ store: "light", dom: "light" });
    });

    it("test_boot_v8KeyInvalidValue_fallsBackToLegacy", async () => {
      localStorage.setItem(LEGACY_KEY, saved("ink"));
      localStorage.setItem(KEY, saved("sepia"));
      expect(await boot()).toEqual({ store: "dark", dom: "dark" });
    });

    // zustand 讀到壞掉的 JSON 會跳過 merge、store 停在初始值；DOM 必須跟 store 一致，
    // 否則畫面是暗的、主題鈕卻以為是亮的（第一下按了沒反應）
    it("test_boot_v8KeyCorrupt_storeAndDomAgree", async () => {
      localStorage.setItem(LEGACY_KEY, saved("ink"));
      localStorage.setItem(KEY, "{not json");
      const { store, dom } = await boot();
      expect(dom).toBe(store);
    });

    // revert 回舊版時，舊版要讀得到使用者原本的選擇
    it("test_legacyKey_neverWritten", async () => {
      localStorage.setItem(LEGACY_KEY, saved("paper"));
      await boot();
      useThemeStore.getState().toggle();
      useThemeStore.getState().setTheme("light");
      expect(localStorage.getItem(LEGACY_KEY)).toBe(saved("paper"));
    });

    it("test_legacyKey_neverCreated", async () => {
      await boot();
      useThemeStore.getState().toggle();
      expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    });

    // 沒選過主題就不寫新 key：舊 key 的值每次啟動都重新換算，直到使用者自己切一次
    it("test_v8Key_writtenOnlyWhenUserPicks", async () => {
      localStorage.setItem(LEGACY_KEY, saved("ink"));
      await boot();
      expect(localStorage.getItem(KEY)).toBeNull();
      useThemeStore.getState().toggle();
      expect(JSON.parse(localStorage.getItem(KEY)!).state.theme).toBe("light");
    });
  });
});
