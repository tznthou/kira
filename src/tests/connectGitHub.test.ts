import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectGitHub } from "@/components/Auth/connectGitHub";
import { useAuthStore } from "@/stores/authStore";
import { useNoticeStore } from "@/stores/noticeStore";
import type { DeviceCodeResponse } from "@/lib/tauri";

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return { ...actual, githubStartDeviceFlow: vi.fn() };
});

import { githubStartDeviceFlow } from "@/lib/tauri";

const mockedStart = vi.mocked(githubStartDeviceFlow);
const FLOW: DeviceCodeResponse = {
  device_code: "d",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Connect GitHub（帳號鈕與 PR 分頁共用）：開 device flow；已登入或連線中不動；等 GitHub 回應的期間登入了也不開對話框
describe("connectGitHub", () => {
  beforeEach(() => {
    mockedStart.mockReset();
    useAuthStore.setState({ isAuthenticated: false, username: null, deviceFlow: null, status: "idle", errorMessage: null });
    useNoticeStore.setState({ notice: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test_connectGitHub_startsTheFlow_connectingMeanwhile", async () => {
    const start = deferred<DeviceCodeResponse>();
    mockedStart.mockReturnValue(start.promise);
    useNoticeStore.getState().show({ title: "Refresh failed.", from: "refresh" });
    const done = connectGitHub("account");
    expect(useNoticeStore.getState().notice).toBeNull();
    expect(useAuthStore.getState().status).toBe("starting");
    start.resolve(FLOW);
    await done;
    expect(useAuthStore.getState().deviceFlow?.user_code).toBe("ABCD-EFGH");
    expect(useAuthStore.getState().status).toBe("pending");
  });

  it("test_connectGitHub_alreadySignedInOrConnecting_doesNothing", async () => {
    useAuthStore.setState({ isAuthenticated: true, username: "u", status: "success" });
    await connectGitHub("account");
    useAuthStore.setState({ isAuthenticated: false, username: null, status: "pending" });
    await connectGitHub("account");
    expect(mockedStart).not.toHaveBeenCalled();
  });

  // 開 device flow 的途中開機查詢先回來說已登入（keychain 裡本來就有 token）：不開對話框、登入狀態不動
  it("test_connectGitHub_signedInWhileTheFlowStarts_leavesTheSignInAlone", async () => {
    const start = deferred<DeviceCodeResponse>();
    mockedStart.mockReturnValue(start.promise);
    const done = connectGitHub("account");
    useAuthStore.getState().setAuthenticated("tznthou");
    start.resolve(FLOW);
    await done;
    expect(useAuthStore.getState().deviceFlow).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().status).toBe("success");
  });

  it("test_connectGitHub_startFails_backToSignedOut_noticeFromTheCaller", async () => {
    mockedStart.mockRejectedValue(new Error("boom"));
    const from = () => null;
    await connectGitHub(from);
    expect(useAuthStore.getState().status).toBe("idle");
    expect(useAuthStore.getState().deviceFlow).toBeNull();
    const notice = useNoticeStore.getState().notice!;
    expect(notice.title).toBe("GitHub sign-in failed.");
    expect(notice.detail).toBe("Check your network.");
    expect(notice.from).toBe(from);
  });
});
