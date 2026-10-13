import { create } from "zustand";

// 站牌上的失敗提示（v8 0b §3）：一次一則，佔站名與 youare 的位置，× 關掉或下一個使用者發起的
// 殼層操作開始時清掉。獨立的狀態，不從各處的錯誤推導：
// - 背景 refresh（watcher / focus）不清它：pull 不能 fast-forward 時 fetch 已更新追蹤 ref，
//   watcher 隨即觸發 refresh，若跟著清，提示約 400ms 就不見了
// - 主題鈕不清（同基準：只有 refresh / pull / push / 帳號動作 / 開 repo 清）
// - DeviceCodeModal 輪詢的錯誤留在對話框卡片裡，不進這裡
export type NoticeFrom = "pull" | "push" | "refresh" | "account";

/** × 關閉後焦點回到哪：工具列 / 帳號按鈕的 id，或關的時候才去找元素的函式——側欄的列、Changes 的按鈕
 *  會重畫，出事當下的節點到關的時候可能已經換掉。找不到、看不見的處理見 `focusBack` */
export type NoticeTarget = NoticeFrom | (() => HTMLElement | null);

export interface NoticeInput {
  title: string;
  detail?: string;
  /** null = 沒有對應的元素 */
  from?: NoticeTarget | null;
}

export interface Notice {
  title: string;
  detail: string;
  from: NoticeTarget | null;
  /** 每次 show 都不同：同一句再出現一次也重播進場 */
  seq: number;
}

interface NoticeState {
  notice: Notice | null;
  show: (input: NoticeInput) => void;
  clear: () => void;
}

let seq = 0;

export const useNoticeStore = create<NoticeState>((set) => ({
  notice: null,
  show: ({ title, detail = "", from = null }) => set({ notice: { title, detail, from, seq: ++seq } }),
  clear: () => set({ notice: null }),
}));

/** 0b §3 的固定文案；push / pull 依錯誤碼的那幾句在 tauri.ts 的 transportErrorNotice。
 *  粗體結論 + 一句下一步，最長的要在 1200px、未登入的站牌裡放得下（notice-fit.js 實測） */
export const SHELL_NOTICES = {
  refresh: { title: "Refresh failed.", from: "refresh" },
  open: { title: "Couldn't open repo." },
  openRecent: { title: "Couldn't open repo.", detail: "It may have moved." },
  reloadAfterCommit: { title: "Graph reload failed.", detail: "Your commit is saved." },
  reloadAfterTransport: { title: "Graph reload failed." },
  signIn: { title: "GitHub sign-in failed.", detail: "Check your network.", from: "account" },
  signOut: { title: "Sign out failed.", detail: "Try again.", from: "account" },
} satisfies Record<string, NoticeInput>;
