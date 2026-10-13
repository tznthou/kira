import { useThemeStore } from "@/stores/themeStore";

// v8 基準的 #theme：白雲母摺（light）↔ 黒雲母摺（dark）。v8.css 管樣式：.icon-btn、
// 暗色時圖示鏡像（#theme svg）、切換的交叉淡化時長（::view-transition-*）；圖示取自 App root 的 sprite。
// 減少動態時不走 view transition，直接切。
export function ThemeSwitcher() {
  const theme = useThemeStore((s) => s.theme);
  const toggle = useThemeStore((s) => s.toggle);
  const dark = theme === "dark";

  const onClick = () => {
    if (
      typeof document.startViewTransition === "function" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      // 回呼要等拍完舊畫面才跑：在回呼裡才依 store 的當下值切換（不用 render 時的 dark），
      // 兩下快速點擊才會各切一次；toggle 同步寫 html[data-theme]，新快照拍得到新主題。
      // 被下一次點擊取代、或視窗 hidden 時跳過的 transition，ready 會 reject（AbortError /
      // InvalidStateError）——回呼照樣會跑、主題照樣切，只是沒有淡化，接住就好
      const transition = document.startViewTransition(() => toggle());
      transition.ready.catch(() => {});
    } else {
      toggle();
    }
  };

  return (
    <button
      className="icon-btn"
      id="theme"
      type="button"
      onClick={onClick}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={
        dark
          ? "黒雲母摺 · black mica — click for white mica"
          : "白雲母摺 · white mica — click for black mica"
      }
    >
      <svg aria-hidden="true">
        <use href="#i-theme" />
      </svg>
    </button>
  );
}
