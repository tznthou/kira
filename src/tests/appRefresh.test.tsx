import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import App from "@/App";
import { useRepoStore } from "@/stores/repoStore";
import { useGraphStore } from "@/stores/graphStore";

vi.mock("@/lib/tauri", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    getRepoInfo: vi.fn(),
    getAheadBehind: vi.fn(),
    getStatus: vi.fn(),
    getGraph: vi.fn(),
    pushBranch: vi.fn(),
    pullBranch: vi.fn(),
    githubGetAuthStatus: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

import {
  getRepoInfo,
  getAheadBehind,
  getStatus,
  getGraph,
  pushBranch,
  githubGetAuthStatus,
} from "@/lib/tauri";

const mocked = {
  getRepoInfo: vi.mocked(getRepoInfo),
  getAheadBehind: vi.mocked(getAheadBehind),
  getStatus: vi.mocked(getStatus),
  getGraph: vi.mocked(getGraph),
  pushBranch: vi.mocked(pushBranch),
  githubGetAuthStatus: vi.mocked(githubGetAuthStatus),
};

const REPO = "AAAAAAAAAAAAAAAAAAAAA";

describe("App handleRefresh", () => {
  beforeEach(() => {
    Object.values(mocked).forEach((m) => m.mockReset());
    mocked.githubGetAuthStatus.mockResolvedValue({
      authenticated: false,
      username: null,
    });
    mocked.getStatus.mockResolvedValue({ staged: [], unstaged: [], conflicted: [], unstaged_truncated: false });
    mocked.getGraph.mockResolvedValue({
      commits: [],
      branches: [],
      tags: [],
      truncated: false,
      head: { oid: null, branch: null },
      default_branch: null,
    });
    mocked.getAheadBehind.mockResolvedValue({
      ahead: 1,
      behind: 0,
      has_upstream: false,
      tracking_ref_exists: false,
      upstream_remote: null,
      upstream_branch: null,
    });

    useRepoStore.setState({
      repoId: REPO,
      repoInfo: {
        path: "/tmp/repo",
        head_branch: "main",
        branches: [],
        remotes: ["origin"],
      },
      workingTreeStatus: { staged: [], unstaged: [], conflicted: [], unstaged_truncated: false },
      loading: false,
      commitLoading: false,
      pushPull: { op: null, repoId: null, percent: null },
      aheadBehind: {
        ahead: 1,
        behind: 0,
        has_upstream: false,
        tracking_ref_exists: false,
        upstream_remote: null,
        upstream_branch: null,
      },
      aheadBehindRequestId: 0,
    });
    useGraphStore.getState().actions.setRepoId(REPO);
    useGraphStore.getState().actions.setGraphData({
      commits: [],
      branches: [],
      tags: [],
      truncated: false,
      head: { oid: null, branch: null },
      default_branch: null,
    });

    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // Regression (dev smoke): 守 handleRefresh → refreshRepoInfo →
  // 工具列整條 wiring (其他 contract/unit test 都覆蓋不到)。沒 upstream → 按鈕叫 Publish、帶 set_upstream。
  it("test_app_clickRefresh_invokesRefreshRepoInfo_pushSendsFreshBranch", async () => {
    mocked.getRepoInfo.mockResolvedValue({
      path: "/tmp/repo",
      head_branch: "feat-X",
      branches: [],
      remotes: ["origin"],
    });
    mocked.pushBranch.mockResolvedValue({ success: true, upstream_set: true });

    const { getByRole } = render(<App />);

    fireEvent.click(getByRole("button", { name: /Refresh/ }));

    await waitFor(() =>
      expect(mocked.getRepoInfo).toHaveBeenCalledWith(REPO),
    );
    await waitFor(() =>
      expect(useRepoStore.getState().repoInfo?.head_branch).toBe("feat-X"),
    );

    fireEvent.click(getByRole("button", { name: /Publish/ }));

    await waitFor(() =>
      expect(mocked.pushBranch).toHaveBeenCalledWith(
        REPO,
        "origin",
        "feat-X",
        true,
      ),
    );
  });
});
