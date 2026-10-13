import { describe, it, expect, beforeEach } from "vitest";
import { useAuthStore } from "@/stores/authStore";

function getInitial() {
  return {
    isAuthenticated: false,
    username: null,
    deviceFlow: null,
    status: "idle" as const,
    errorMessage: null,
  };
}

describe("authStore", () => {
  beforeEach(() => {
    useAuthStore.setState(getInitial());
  });

  it("test_authStore_setAuthenticated_withUsername_marksAuthenticated", () => {
    useAuthStore.getState().setAuthenticated("octocat");
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.username).toBe("octocat");
    expect(s.status).toBe("success");
    expect(s.deviceFlow).toBeNull();
  });

  // 登入代號：同一個帳號的確認不算換；已登入時查到另一個帳號（keychain 的 token 被別的視窗換掉）算新的一次
  it("test_authStore_session_sameUserConfirmed_isTheSameSession_anotherUserIsANewOne", () => {
    useAuthStore.getState().setAuthenticated("octocat");
    const signedIn = useAuthStore.getState().session;
    useAuthStore.getState().setAuthenticated("octocat");
    expect(useAuthStore.getState().session).toBe(signedIn);
    useAuthStore.getState().setAuthenticated("hubot");
    expect(useAuthStore.getState().session).toBe(signedIn + 1);
    expect(useAuthStore.getState().username).toBe("hubot");
  });

  it("test_authStore_setAuthenticated_null_resetsToIdle", () => {
    useAuthStore.getState().setAuthenticated("octocat");
    useAuthStore.getState().setAuthenticated(null);
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.username).toBeNull();
    expect(s.status).toBe("idle");
  });

  it("test_authStore_setDeviceFlow_computesExpiresAtFromExpiresIn", () => {
    const before = Date.now();
    useAuthStore.getState().setDeviceFlow({
      device_code: "dc",
      user_code: "WDJB-MJHT",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });
    const after = Date.now();
    const s = useAuthStore.getState();
    expect(s.deviceFlow).not.toBeNull();
    expect(s.status).toBe("pending");
    // expires_at 在 expires_in*1000 後（容錯 100ms）
    const expected = before + 900 * 1000;
    expect(s.deviceFlow!.expires_at).toBeGreaterThanOrEqual(expected);
    expect(s.deviceFlow!.expires_at).toBeLessThanOrEqual(after + 900 * 1000);
  });

  it("test_authStore_setDeviceFlow_null_resetsToIdle", () => {
    useAuthStore.getState().setDeviceFlow({
      device_code: "dc",
      user_code: "X",
      verification_uri: "u",
      expires_in: 100,
      interval: 5,
    });
    useAuthStore.getState().setDeviceFlow(null);
    const s = useAuthStore.getState();
    expect(s.deviceFlow).toBeNull();
    expect(s.status).toBe("idle");
  });

  it("test_authStore_setError_marksStatusError", () => {
    useAuthStore.getState().setError("network failed");
    const s = useAuthStore.getState();
    expect(s.status).toBe("error");
    expect(s.errorMessage).toBe("network failed");
  });

  it("test_authStore_reset_clearsAllAuthFields", () => {
    useAuthStore.getState().setAuthenticated("octocat");
    useAuthStore.getState().setError("x");
    useAuthStore.getState().reset();
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.username).toBeNull();
    expect(s.deviceFlow).toBeNull();
    expect(s.status).toBe("idle");
    expect(s.errorMessage).toBeNull();
  });
});
