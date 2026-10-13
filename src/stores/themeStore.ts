import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// v8：白雲母摺（light）↔ 黒雲母摺（dark），寫在 html[data-theme]，v8.css 依它切換變數
export type Theme = "light" | "dark";

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = "kira-theme-v8";
// v8 以前的 key（ink = 暗 / paper = 亮）：只讀、永不寫入。revert 回舊版時，舊版仍讀得到使用者原本的選擇
const LEGACY_KEY = "kira-theme";

function applyTheme(theme: Theme) {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

function readLegacyTheme(): Theme {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    const legacy = raw ? (JSON.parse(raw) as { state?: { theme?: unknown } } | null)?.state?.theme : undefined;
    return legacy === "ink" ? "dark" : "light";
  } catch {
    // 讀取或 JSON parse 失敗：當作沒選過
    return "light";
  }
}

// persist merge（rehydrate）用：新 key 沒有有效值時看舊 key——ink → dark，其他（paper、沒選過、
// 損壞）→ light。從沒切過主題的舊使用者沒有任何 key（zustand persist hydrate 時不寫入），會由
// 舊預設的暗色變成 v8 預設的亮色——Phase 3 裁定接受
function resolveTheme(persisted: unknown): Theme {
  return persisted === "light" || persisted === "dark" ? persisted : readLegacyTheme();
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: "light",
      toggle: () =>
        set((s) => {
          const next: Theme = s.theme === "light" ? "dark" : "light";
          applyTheme(next);
          return { theme: next };
        }),
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => ({
        ...current,
        theme: resolveTheme((persisted as { theme?: unknown } | null | undefined)?.theme),
      }),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.theme);
      },
    },
  ),
);

// Sync DOM 寫入點：main.tsx 在 createRoot 前呼叫。localStorage 是同步 storage，store 建立時
// persist 已同步 hydrate 完（含 merge 的舊 key 回退），這裡照 store 的值寫 DOM。新 key 損壞時
// hydrate 會跳過 merge、onRehydrateStorage 也拿不到 state，store 停在初始值——靠這裡把同一個
// 值寫進 DOM，畫面與 store 才不會一個暗一個亮。
export function initTheme() {
  applyTheme(useThemeStore.getState().theme);
}
