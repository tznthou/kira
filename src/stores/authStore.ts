import { create } from "zustand";
import type { DeviceCodeResponse } from "../lib/tauri";

export type AuthFlowStatus =
  | "idle"
  | "starting"
  | "pending"
  | "success"
  | "expired"
  | "denied"
  | "error";

export interface DeviceFlowState extends DeviceCodeResponse {
  /** epoch ms when device_code expires; 用於 DeviceCodeModal 倒數 */
  expires_at: number;
}

interface AuthState {
  isAuthenticated: boolean;
  username: string | null;
  deviceFlow: DeviceFlowState | null;
  status: AuthFlowStatus;
  errorMessage: string | null;
  /**
   * 登入代號：登入狀態每換一次（登入、登出、token 失效、已登入時查到的是另一個帳號）就加一；狀態查詢確認是
   * 同一次登入不算。請求出發時記下它，AUTH_FAILED 回來時代號沒變才重設（src/lib/tauri.ts invokeWithAuthGuard）
   * ——請求在外面時重新登入，舊請求晚到的 AUTH_FAILED 說的是已經不在的 token，不能把新的登入登出（Phase 5c；
   * 後端同理只刪當次那把）
   */
  session: number;
  setAuthenticated: (username: string | null) => void;
  setDeviceFlow: (resp: DeviceCodeResponse | null) => void;
  setStatus: (status: AuthFlowStatus) => void;
  setError: (msg: string | null) => void;
  reset: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  username: null,
  deviceFlow: null,
  status: "idle",
  errorMessage: null,
  session: 0,
  setAuthenticated: (username) =>
    set((s) => ({
      isAuthenticated: username !== null,
      username,
      deviceFlow: null,
      status: username !== null ? "success" : "idle",
      errorMessage: null,
      // 同一個帳號的確認不算換；keychain 裡的 token 被換成另一個帳號的（別的 Kira 視窗登入）算
      session: (username !== null) === s.isAuthenticated && username === s.username ? s.session : s.session + 1,
    })),
  setDeviceFlow: (resp) =>
    set({
      deviceFlow:
        resp === null
          ? null
          : { ...resp, expires_at: Date.now() + resp.expires_in * 1000 },
      status: resp === null ? "idle" : "pending",
    }),
  setStatus: (status) => set({ status }),
  setError: (msg) => set({ errorMessage: msg, status: "error" }),
  reset: () =>
    set((s) => ({
      isAuthenticated: false,
      username: null,
      deviceFlow: null,
      status: "idle",
      errorMessage: null,
      session: s.isAuthenticated ? s.session + 1 : s.session,
    })),
}));
