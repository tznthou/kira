import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import App from "@/App";
import { useRepoStore } from "@/stores/repoStore";
import { useGraphStore } from "@/stores/graphStore";
import { useAuthStore } from "@/stores/authStore";

// device code 對話框只在未登入時畫（舊 LoginButton 的 gate，3b 安全 O1）：開 device flow 的途中登入了
// （開機查詢 keychain 的 token 這時才回來），對話框不該出現
vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    getRepoInfo: vi.fn(),
    getAheadBehind: vi.fn(),
    getStatus: vi.fn(),
    getGraph: vi.fn(),
    listBranches: vi.fn(),
    getBranchStats: vi.fn(),
    githubGetAuthStatus: vi.fn(),
    githubGetPRs: vi.fn(),
    githubPollToken: vi.fn(),
    homeDir: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

import { githubGetAuthStatus, githubGetPRs, githubPollToken, homeDir } from "@/lib/tauri";

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
const EMPTY_GRAPH = {
  commits: [],
  branches: [],
  tags: [],
  truncated: false,
  head: { oid: null, branch: null },
  default_branch: null,
};

describe("App: the device code dialog", () => {
  beforeEach(() => {
    vi.mocked(githubGetAuthStatus).mockResolvedValue({ authenticated: false, username: null });
    vi.mocked(githubGetPRs).mockRejectedValue({ code: "AUTH_FAILED", message: "authentication required" });
    vi.mocked(githubPollToken).mockReturnValue(new Promise(() => undefined));
    vi.mocked(homeDir).mockResolvedValue("/Users/x");
    useRepoStore.setState({
      repoId: REPO,
      repoInfo: { path: "/tmp/repo", head_branch: "main", branches: [], remotes: ["origin"] },
      workingTreeStatus: { staged: [], unstaged: [], conflicted: [], unstaged_truncated: false },
      statusError: false,
      loading: false,
      commitLoading: false,
      refreshing: false,
      pushPull: { op: null, repoId: null, percent: null },
      aheadBehind: null,
      branches: [],
      branchesError: false,
      branchStats: {},
    });
    useGraphStore.getState().actions.setRepoId(REPO);
    useGraphStore.getState().actions.setGraphData(EMPTY_GRAPH);
    useAuthStore.setState({ isAuthenticated: false, username: null, deviceFlow: null, status: "idle", errorMessage: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const startFlow = () =>
    useAuthStore.getState().setDeviceFlow({
      device_code: "d",
      user_code: "ABCD-EFGH",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });

  it("test_app_deviceFlow_signedOut_showsTheDialog", () => {
    act(() => startFlow());
    const { queryByText } = render(<App />);
    expect(queryByText("Connect to GitHub")).not.toBeNull();
  });

  it("test_app_deviceFlow_butSignedIn_showsNoDialog", () => {
    act(() => {
      startFlow();
      useAuthStore.setState({ isAuthenticated: true, username: "tznthou", status: "success" });
    });
    const { queryByText } = render(<App />);
    expect(queryByText("Connect to GitHub")).toBeNull();
  });
});
