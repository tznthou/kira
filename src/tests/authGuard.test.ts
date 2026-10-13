import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAuthStore } from "@/stores/authStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { githubGetPRs, githubGetPRDiff, pushBranch, pullBranch } from "@/lib/tauri";

const mockedInvoke = vi.mocked(invoke);

describe("invokeWithAuthGuard", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    useAuthStore.setState({
      isAuthenticated: true,
      username: "testuser",
      deviceFlow: null,
      status: "success",
      errorMessage: null,
    });
  });

  it("resets auth store on AUTH_FAILED from githubGetPRs", async () => {
    mockedInvoke.mockRejectedValueOnce({ code: "AUTH_FAILED", message: "authentication required" });
    await expect(githubGetPRs("repo-1", "open")).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it("resets auth store on AUTH_FAILED from githubGetPRDiff", async () => {
    mockedInvoke.mockRejectedValueOnce({ code: "AUTH_FAILED", message: "authentication required" });
    await expect(githubGetPRDiff("repo-1", 42)).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it("does not reset auth store on other errors", async () => {
    mockedInvoke.mockRejectedValueOnce({ code: "NETWORK_ERROR", message: "timeout" });
    await expect(githubGetPRs("repo-1", "open")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it("resets auth store on AUTH_FAILED from pushBranch", async () => {
    mockedInvoke.mockRejectedValueOnce({ code: "AUTH_FAILED", message: "authentication required" });
    await expect(pushBranch("repo-1", "origin", "main", false)).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it("resets auth store on AUTH_FAILED from pullBranch", async () => {
    mockedInvoke.mockRejectedValueOnce({ code: "AUTH_FAILED", message: "authentication required" });
    await expect(pullBranch("repo-1", "origin", "main")).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it("does not reset auth store on other errors", async () => {
    mockedInvoke.mockRejectedValueOnce({ code: "NETWORK_ERROR", message: "timeout" });
    await expect(githubGetPRs("repo-1", "open")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it("passes through successful responses unchanged", async () => {
    mockedInvoke.mockResolvedValueOnce([{ number: 1, title: "Test" }]);
    const result = await githubGetPRs("repo-1", "open");
    expect(result).toEqual([{ number: 1, title: "Test" }]);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});

// Phase 5c：請求帶著出發時的登入代號。登入狀態在它回來前換過（登出又登入），它的 AUTH_FAILED 說的是
// 已經不在的 token，不能把新的登入登出（後端同理只刪當次那把，commands/github.rs forget_if_rejected）
describe("invokeWithAuthGuard: an AUTH_FAILED from an earlier sign-in", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    useAuthStore.setState({
      isAuthenticated: true,
      username: "testuser",
      deviceFlow: null,
      status: "success",
      errorMessage: null,
    });
  });

  // 請求出去了、還沒回來：回一個由測試決定何時失敗的 promise
  function outstanding(): (err: unknown) => void {
    let fail!: (err: unknown) => void;
    mockedInvoke.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    return (err) => fail(err);
  }

  const calls: [string, () => Promise<unknown>][] = [
    ["githubGetPRs", () => githubGetPRs("repo-1", "open")],
    ["githubGetPRDiff", () => githubGetPRDiff("repo-1", 42)],
    ["pushBranch", () => pushBranch("repo-1", "origin", "main", false)],
    ["pullBranch", () => pullBranch("repo-1", "origin", "main")],
  ];

  for (const [name, call] of calls) {
    it(`${name}: signed out and in again while it was out — the new sign-in stays`, async () => {
      const fail = outstanding();
      const request = call();
      useAuthStore.getState().reset();
      useAuthStore.getState().setAuthenticated("newuser");
      fail({ code: "AUTH_FAILED", message: "authentication required" });
      await expect(request).rejects.toMatchObject({ code: "AUTH_FAILED" });
      expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, username: "newuser" });
    });
  }

  it("signed out when it went out, signed in before it came back — the sign-in stays", async () => {
    useAuthStore.getState().reset();
    const fail = outstanding();
    const request = githubGetPRs("repo-1", "open");
    useAuthStore.getState().setAuthenticated("newuser");
    fail({ code: "AUTH_FAILED", message: "authentication required" });
    await expect(request).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, username: "newuser" });
  });

  it("the same sign-in throughout — AUTH_FAILED still signs out", async () => {
    const fail = outstanding();
    const request = pushBranch("repo-1", "origin", "main", false);
    fail({ code: "AUTH_FAILED", message: "authentication required" });
    await expect(request).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it("a status check that finds the same sign-in is not a new one — AUTH_FAILED still signs out", async () => {
    const fail = outstanding();
    const request = githubGetPRs("repo-1", "open");
    useAuthStore.getState().setAuthenticated("testuser");
    fail({ code: "AUTH_FAILED", message: "authentication required" });
    await expect(request).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});
