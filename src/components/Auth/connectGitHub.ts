import { useAuthStore } from "@/stores/authStore";
import { useNoticeStore, SHELL_NOTICES, type NoticeTarget } from "@/stores/noticeStore";
import { githubStartDeviceFlow } from "@/lib/tauri";

/**
 * Connect GitHub：站牌角落的帳號鈕與 PR 分頁的按鈕共用同一個動作（0b P5 §3.1 D2，Phase 5c step 8）。
 * 開 device flow（對話框由 App root 畫）；失敗回到未登入（同基準）、提示在站牌、× 後焦點回實際按的那顆。
 * 已經登入、或已經在連線中就不動：PR 分頁的「未登入」是上一次讀的結果，可能比登入狀態晚一步
 */
export async function connectGitHub(from: NoticeTarget): Promise<void> {
  const auth = useAuthStore.getState();
  if (auth.isAuthenticated || auth.status === "starting" || auth.status === "pending") return;
  useNoticeStore.getState().clear();
  auth.setStatus("starting");
  try {
    const flow = await githubStartDeviceFlow();
    // 等 GitHub 回 device code 的期間登入了（開機查詢 keychain 的 token 這時才回來）：不開對話框、不改狀態
    if (useAuthStore.getState().isAuthenticated) return;
    useAuthStore.getState().setDeviceFlow(flow);
  } catch (err) {
    console.error("[kira] start device flow failed:", err);
    useAuthStore.getState().setStatus("idle");
    useNoticeStore.getState().show({ ...SHELL_NOTICES.signIn, from });
  }
}
