import { StrictMode } from "react";
import { render, fireEvent, act, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaneTabs } from "@/components/PaneTabs/PaneTabs";
import { PRPanel } from "@/components/PRPanel/PRPanel";
import { useAuthStore } from "@/stores/authStore";
import { useNoticeStore } from "@/stores/noticeStore";
import { computeRoutes, type RouteMap } from "@/lib/routeMap";
import { legendRoundel } from "@/lib/rowRefs";
import { resetHint } from "@/lib/resetHint";
import * as fx from "@/dev/fidelity/fixture";
import type { DiffResult, DiffFile, PullRequestInfo } from "@/lib/tauri";

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    githubGetPRs: vi.fn(),
    githubGetPRDiff: vi.fn(),
    githubStartDeviceFlow: vi.fn(),
  };
});

import { githubGetPRs, githubGetPRDiff, githubStartDeviceFlow } from "@/lib/tauri";

const mocked = {
  getPRs: vi.mocked(githubGetPRs),
  getPRDiff: vi.mocked(githubGetPRDiff),
  startDeviceFlow: vi.mocked(githubStartDeviceFlow),
};

const REPO = "AAAAAAAAAAAAAAAAAAAAA";
const GIT_ERROR = { code: "GIT_ERROR", message: "git operation failed" };
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
/** fixture 的三筆 PR，時間改成相對現在（「2h ago」這類是相對時間） */
const PRS: PullRequestInfo[] = fx.prs.map((pr, i) => ({ ...pr, updated_at: hoursAgo([77, 2.1, 26][i]) }));
const routes: RouteMap = computeRoutes(fx.graph);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const plain = (path: string, extra: Partial<DiffFile> = {}): DiffFile => ({
  path,
  status: "Modified",
  hunks: [],
  binary: false,
  too_large: false,
  omitted: null,
  ...extra,
});
const diffOf = (files: DiffFile[], truncated = false): DiffResult => ({ files, truncated });
const ONE_FILE = diffOf([
  plain("src/main.ts", {
    hunks: [
      {
        old_start: 1,
        old_lines: 3,
        new_start: 1,
        new_lines: 4,
        context: "",
        lines: [
          { origin: " ", content: "line1", old_lineno: 1, new_lineno: 1 },
          { origin: "+", content: "added", old_lineno: null, new_lineno: 2 },
        ],
      },
    ],
  }),
]);

const list = (c: ParentNode) => c.querySelector<HTMLUListElement>("#prs")!;
const stateBox = (c: ParentNode) => c.querySelector<HTMLElement>("#prs-state")!;
const row = (c: ParentNode, n: number) => c.querySelector<HTMLButtonElement>(`.pr-row[data-pr="${n}"]`)!;
const texts = (c: ParentNode, sel: string) => [...c.querySelectorAll(sel)].map((e) => e.textContent);

/** 在 PaneTabs 裡畫、切到 PR 分頁（Retry 之後的焦點落在 #panel-prs） */
function renderPane(props: Partial<{ routes: RouteMap | null; refreshToken: number }> = {}) {
  const r = render(<PaneTabs changes={<div />} prs={<PRPanel repoId={REPO} routes={props.routes ?? null} refreshToken={props.refreshToken} />} />);
  fireEvent.click(r.getByRole("tab", { name: "Pull Requests" }));
  return r;
}

beforeEach(() => {
  Object.values(mocked).forEach((m) => m.mockReset());
  mocked.getPRs.mockResolvedValue(PRS);
  mocked.getPRDiff.mockResolvedValue(ONE_FILE);
  useAuthStore.setState({ isAuthenticated: true, username: "tznthou", deviceFlow: null, status: "success", errorMessage: null });
  useNoticeStore.setState({ notice: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---- 清單與它的狀態（Phase 5 5c step 8，基準 renderPRs）----
describe("PR pane: the list and its states", () => {
  it("test_prPane_loading_skeletonRowsWithALabel", () => {
    mocked.getPRs.mockReturnValue(new Promise(() => undefined));
    const { container } = renderPane();
    expect(list(container).getAttribute("aria-label")).toBe("Loading pull requests");
    expect(list(container).querySelectorAll(".sk-pr").length).toBe(3);
    expect(list(container).hidden).toBe(false);
    expect(stateBox(container).hidden).toBe(true);
  });

  it("test_prPane_rows_titleMetaStatusAndVia", async () => {
    const { container } = renderPane({ routes });
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    expect(list(container).hasAttribute("aria-label")).toBe(false);
    expect(texts(container, ".pr-title")).toEqual([
      "chore(deps): pin tauri to the version resolved in Cargo.lock",
      "Give Refresh a fixed min-width so the toolbar stops shifting",
      "T15g: adaptive lane gutter for dense historiesDraft",
    ]);
    expect(container.querySelectorAll(".pr-title .draft").length).toBe(1);
    expect(texts(container, ".pr-meta .num")).toEqual(["#39", "#38", "#37"]);
    expect(texts(container, ".pr-meta > span:nth-child(2)")).toEqual(["by tznthou · 3d ago", "by tznthou · 2h ago", "by tznthou · 1d ago"]);
    // 審查與 CI 的圖示：有的才畫
    const icons = (n: number) => [...row(container, n).querySelectorAll(".pr-status svg")].map((s) => `${s.getAttribute("class")}|${s.getAttribute("aria-label")}`);
    expect(icons(39)).toEqual(["st bad|Changes requested", "st bad|Checks failing"]);
    expect(icons(38)).toEqual(["st ok|Approved", "st wait|Checks pending"]);
    expect(icons(37)).toEqual(["st ok|Checks passing"]);
    expect(row(container, 38).getAttribute("aria-expanded")).toBe("false");
    // via：#38 的 head 停在 fix/toolbar-jump 那一站 → 那條線的圓標 + 名字（同側欄那一列的圓標）；#39 的 head 不在任何 ref 上
    const via = row(container, 38).querySelector(".via")!;
    const sidebar = legendRoundel(routes, { name: "fix/toolbar-jump", is_remote: false }, "main")!;
    expect(sidebar.letter).toBe("J");
    expect(via.textContent).toBe("Jfix/toolbar-jump");
    expect(via.querySelector(".rd")?.textContent).toBe("J");
    expect((via.querySelector(".rd") as HTMLElement).style.getPropertyValue("--l")).toBe(`var(--l-${sidebar.color})`);
    expect(row(container, 39).querySelector(".via")).toBeNull();
  });

  // graph 還沒回來（routes null）不畫 via（Q-L）
  it("test_prPane_noRoutesYet_drawsNoVia", async () => {
    const { container } = renderPane({ routes: null });
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    expect(container.querySelector(".via")).toBeNull();
  });

  it("test_prPane_empty_notGithub_signedOut", async () => {
    mocked.getPRs.mockResolvedValue([]);
    const { container, unmount } = renderPane();
    await waitFor(() => expect(stateBox(container).hidden).toBe(false));
    expect(list(container).hidden).toBe(true);
    expect(stateBox(container).hasAttribute("role")).toBe(false);
    expect(texts(stateBox(container), "p")).toEqual(["No open pull requests"]);
    expect(stateBox(container).querySelector("svg")).not.toBeNull();
    unmount();

    mocked.getPRs.mockRejectedValue({ code: "NOT_A_GITHUB_REPO", message: "not a GitHub repository" });
    const r2 = renderPane();
    await waitFor(() => expect(stateBox(r2.container).hidden).toBe(false));
    expect(texts(stateBox(r2.container), "p")).toEqual(["No GitHub remote", "Pull requests come from origin on github.com."]);
    r2.unmount();

    mocked.getPRs.mockRejectedValue({ code: "AUTH_FAILED", message: "authentication required" });
    useAuthStore.setState({ isAuthenticated: false, username: null, status: "idle" });
    const r3 = renderPane();
    await waitFor(() => expect(stateBox(r3.container).hidden).toBe(false));
    expect(texts(stateBox(r3.container), "p")).toEqual(["Connect GitHub to see pull requests"]);
    const connect = stateBox(r3.container).querySelector<HTMLButtonElement>("#prs-connect")!;
    expect(connect.textContent).toBe("Connect GitHub");
    expect(connect.disabled).toBe(false);
  });

  it("test_prPane_rateLimited_hintAndRetry", async () => {
    mocked.getPRs.mockRejectedValue({ code: "RATE_LIMITED", message: "API rate limited", reset_at: null });
    const { container, unmount } = renderPane();
    await waitFor(() => expect(stateBox(container).hidden).toBe(false));
    expect(stateBox(container).getAttribute("role")).toBe("alert");
    expect(stateBox(container).querySelector("p b")?.textContent).toBe("GitHub's rate limit is used up.");
    expect(stateBox(container).querySelector(".hint")?.textContent).toBe("Try again later.");
    expect(stateBox(container).querySelector("#prs-retry")?.classList.contains("btn")).toBe(true);
    unmount();

    mocked.getPRs.mockRejectedValue({ code: "RATE_LIMITED", message: "API rate limited", reset_at: Math.floor(Date.now() / 1000) - 60 });
    const r2 = renderPane();
    await waitFor(() => expect(stateBox(r2.container).hidden).toBe(false));
    expect(stateBox(r2.container).querySelector(".hint")?.textContent).toBe("Try again now.");
    r2.unmount();

    // 還沒到：時鐘時刻（整分，兩邊算出來一樣；格式與進位在 resetHint 的測試）
    const at = Math.ceil(Date.now() / 60_000) * 60 + 600;
    mocked.getPRs.mockRejectedValue({ code: "RATE_LIMITED", message: "API rate limited", reset_at: at });
    const r3 = renderPane();
    await waitFor(() => expect(stateBox(r3.container).hidden).toBe(false));
    expect(stateBox(r3.container).querySelector(".hint")?.textContent).toBe(resetHint(at, Date.now()));
    expect(stateBox(r3.container).querySelector(".hint")?.textContent).toMatch(/^Try again after \d\d:\d\d\.$/);
  });

  it("test_prPane_otherFailure_saysSoWithRetry", async () => {
    mocked.getPRs.mockRejectedValue(GIT_ERROR);
    const { container } = renderPane();
    await waitFor(() => expect(stateBox(container).hidden).toBe(false));
    expect(stateBox(container).getAttribute("role")).toBe("alert");
    expect(stateBox(container).querySelector("p b")?.textContent).toBe("Couldn't load pull requests.");
    expect(stateBox(container).querySelector(".hint")?.textContent).toBe("Check your network, then try again.");
    expect(stateBox(container).querySelector("#prs-retry")).not.toBeNull();
    expect(console.error).toHaveBeenCalledWith("[kira] getPRs failed:", "GIT_ERROR");
  });

  // StrictMode 開發時 mount 的 effect 跑兩次：清單只讀一次——重送會把假後端帳上「只回錯一次」的失敗吃掉，第一次的
  // 結果又因不是最新被丟（D1 的 prs-rate 看到的是清單）
  it("test_prPane_strictModeMount_readsOnce", async () => {
    mocked.getPRs.mockRejectedValue(GIT_ERROR);
    const { container } = render(
      <StrictMode>
        <PRPanel repoId={REPO} routes={null} />
      </StrictMode>,
    );
    await waitFor(() => expect(stateBox(container).getAttribute("role")).toBe("alert"));
    expect(mocked.getPRs).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  // 使用者按 Refresh（refreshToken）→ 再讀一次：骨架、然後清單
  it("test_prPane_refreshToken_readsAgain", async () => {
    const { container, rerender } = renderPane();
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    rerender(<PaneTabs changes={<div />} prs={<PRPanel repoId={REPO} routes={null} refreshToken={1} />} />);
    expect(mocked.getPRs).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
  });
});

// ---- Retry 之後的焦點（Q-F）：清單 → 這一格；檔案 → 那筆 PR 的列 ----
describe("PR pane: the focus after Retry", () => {
  it("test_prPane_listRetry_readsAgain_focusStaysInThePane", async () => {
    mocked.getPRs.mockRejectedValueOnce(GIT_ERROR);
    const { container } = renderPane();
    await waitFor(() => expect(container.querySelector("#prs-retry")).not.toBeNull());
    act(() => container.querySelector<HTMLButtonElement>("#prs-retry")!.focus());
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#prs-retry")!.click();
    });
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    expect(document.activeElement).toBe(container.querySelector("#panel-prs"));
  });

  it("test_prPane_listRetryFailsAgain_focusGoesToTheNewRetry", async () => {
    mocked.getPRs.mockRejectedValue(GIT_ERROR);
    const { container } = renderPane();
    await waitFor(() => expect(container.querySelector("#prs-retry")).not.toBeNull());
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#prs-retry")!.click();
    });
    await waitFor(() => expect(document.activeElement?.id).toBe("prs-retry"));
  });

  it("test_prPane_listRetry_focusMovedAwayWhileReading_isLeftAlone", async () => {
    mocked.getPRs.mockRejectedValueOnce(GIT_ERROR);
    const { container } = renderPane();
    await waitFor(() => expect(container.querySelector("#prs-retry")).not.toBeNull());
    const read = deferred<PullRequestInfo[]>();
    mocked.getPRs.mockReturnValue(read.promise);
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    act(() => container.querySelector<HTMLButtonElement>("#prs-retry")!.click());
    act(() => elsewhere.focus());
    await act(async () => {
      read.reject(GIT_ERROR);
      await read.promise.catch(() => undefined);
    });
    await waitFor(() => expect(container.querySelector("#prs-retry")).not.toBeNull());
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("test_prPane_diffRetry_readsAgain_focusStaysOnThatRow", async () => {
    mocked.getPRDiff.mockRejectedValueOnce(GIT_ERROR);
    const { container } = renderPane();
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    fireEvent.click(row(container, 38));
    await waitFor(() => expect(container.querySelector("#pr-diff-retry")).not.toBeNull());
    expect(container.querySelector(".pr-body [role=alert]")?.textContent).toBe("Couldn't load the files. Retry");
    act(() => container.querySelector<HTMLButtonElement>("#pr-diff-retry")!.focus());
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#pr-diff-retry")!.click();
    });
    await waitFor(() => expect(container.querySelector(".pr-body .dfile")).not.toBeNull());
    expect(document.activeElement).toBe(row(container, 38));
  });

  it("test_prPane_diffRetryFailsAgain_focusGoesToTheNewRetry", async () => {
    mocked.getPRDiff.mockRejectedValue(GIT_ERROR);
    const { container } = renderPane();
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    fireEvent.click(row(container, 38));
    await waitFor(() => expect(container.querySelector("#pr-diff-retry")).not.toBeNull());
    await act(async () => {
      container.querySelector<HTMLButtonElement>("#pr-diff-retry")!.click();
    });
    await waitFor(() => expect(document.activeElement?.id).toBe("pr-diff-retry"));
  });

  it("test_prPane_diffRetry_focusMovedAwayWhileReading_isLeftAlone", async () => {
    mocked.getPRDiff.mockRejectedValueOnce(GIT_ERROR);
    const { container } = renderPane();
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    fireEvent.click(row(container, 38));
    await waitFor(() => expect(container.querySelector("#pr-diff-retry")).not.toBeNull());
    const read = deferred<DiffResult>();
    mocked.getPRDiff.mockReturnValue(read.promise);
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    act(() => container.querySelector<HTMLButtonElement>("#pr-diff-retry")!.click());
    act(() => elsewhere.focus());
    await act(async () => {
      read.reject(GIT_ERROR);
      await read.promise.catch(() => undefined);
    });
    await waitFor(() => expect(container.querySelector("#pr-diff-retry")).not.toBeNull());
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});

// ---- 登入與 Connect GitHub ----
describe("PR pane: signing in and out", () => {
  beforeEach(() => {
    mocked.getPRs.mockRejectedValue({ code: "AUTH_FAILED", message: "authentication required" });
    useAuthStore.setState({ isAuthenticated: false, username: null, status: "idle" });
  });

  // 分頁裡的 Connect GitHub 跟帳號鈕同一個動作：開 device flow、連線中按鈕停用寫 Connecting…
  it("test_prPane_connect_startsTheDeviceFlow_andSaysConnecting", async () => {
    const start = deferred<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }>();
    mocked.startDeviceFlow.mockReturnValue(start.promise);
    const { container } = renderPane();
    await waitFor(() => expect(container.querySelector("#prs-connect")).not.toBeNull());
    fireEvent.click(container.querySelector<HTMLButtonElement>("#prs-connect")!);
    expect(mocked.startDeviceFlow).toHaveBeenCalledOnce();
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>("#prs-connect")!.disabled).toBe(true));
    expect(container.querySelector("#prs-connect")?.textContent).toBe("Connecting…");
    await act(async () => {
      start.resolve({ device_code: "d", user_code: "ABCD-EFGH", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
      await start.promise;
    });
    expect(useAuthStore.getState().deviceFlow).not.toBeNull();
  });

  // 開 device flow 失敗：回到未登入、提示在站牌、× 後焦點回分頁裡那顆按鈕（實際按的那顆）
  it("test_prPane_connectFails_noticeFromThePanesButton", async () => {
    mocked.startDeviceFlow.mockRejectedValue(new Error("boom"));
    const { container } = renderPane();
    await waitFor(() => expect(container.querySelector("#prs-connect")).not.toBeNull());
    fireEvent.click(container.querySelector<HTMLButtonElement>("#prs-connect")!);
    await waitFor(() => expect(useNoticeStore.getState().notice?.title).toBe("GitHub sign-in failed."));
    expect(useAuthStore.getState().status).toBe("idle");
    const from = useNoticeStore.getState().notice!.from as () => HTMLElement | null;
    expect(from()).toBe(container.querySelector("#prs-connect"));
    expect(container.querySelector<HTMLButtonElement>("#prs-connect")!.disabled).toBe(false);
  });

  // 登入成功（未登入 → 已登入）→ 重抓一次；是使用者操作，跟「watcher 不打 GitHub」不衝突
  it("test_prPane_signIn_readsAgain", async () => {
    const { container } = renderPane();
    await waitFor(() => expect(container.querySelector("#prs-connect")).not.toBeNull());
    expect(mocked.getPRs).toHaveBeenCalledTimes(1);
    mocked.getPRs.mockResolvedValue(PRS);
    act(() => useAuthStore.getState().setAuthenticated("tznthou"));
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    expect(mocked.getPRs).toHaveBeenCalledTimes(2);
  });

  // 開機：keychain 裡本來就有 token，清單帶著它讀到了；狀態查詢這時才把旗標翻成已登入——不算登入、不多讀一次
  it("test_prPane_bootCheckSignsInWhileTheListIsBeingRead_readsOnce", async () => {
    const read = deferred<PullRequestInfo[]>();
    mocked.getPRs.mockReturnValue(read.promise);
    const { container } = renderPane();
    act(() => useAuthStore.getState().setAuthenticated("tznthou"));
    await act(async () => {
      read.resolve(PRS);
      await read.promise;
    });
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    expect(mocked.getPRs).toHaveBeenCalledTimes(1);
  });

  // 請求在還沒有 token 時送出、回來前登入了（Refresh 按下去時 device flow 還在跑）：回來的「未登入」不算數，帶著
  // 新 token 再讀一次；畫面沒出現過 Connect GitHub
  it("test_prPane_signedInAfterARequestWentOutWithoutAToken_readsAgain", async () => {
    const first = deferred<PullRequestInfo[]>();
    mocked.getPRs.mockReturnValueOnce(first.promise).mockResolvedValueOnce(PRS);
    const { container } = renderPane();
    act(() => useAuthStore.getState().setAuthenticated("tznthou"));
    await act(async () => {
      first.reject({ code: "AUTH_FAILED", message: "authentication required" });
      await first.promise.catch(() => undefined);
    });
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    expect(mocked.getPRs).toHaveBeenCalledTimes(2);
    expect(container.querySelector("#prs-connect")).toBeNull();
  });

  // 登出 → 區內回到 Connect GitHub，不再打 GitHub；沒有 GitHub remote 的照舊
  it("test_prPane_signOut_showsConnectWithoutReading", async () => {
    mocked.getPRs.mockResolvedValue(PRS);
    useAuthStore.setState({ isAuthenticated: true, username: "tznthou", status: "success" });
    const { container, unmount } = renderPane();
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    act(() => useAuthStore.getState().reset());
    await waitFor(() => expect(container.querySelector("#prs-connect")).not.toBeNull());
    expect(list(container).hidden).toBe(true);
    expect(mocked.getPRs).toHaveBeenCalledTimes(1);
    unmount();

    mocked.getPRs.mockRejectedValue({ code: "NOT_A_GITHUB_REPO", message: "not a GitHub repository" });
    useAuthStore.setState({ isAuthenticated: true, username: "tznthou", status: "success" });
    const r2 = renderPane();
    await waitFor(() => expect(texts(stateBox(r2.container), "p")[0]).toBe("No GitHub remote"));
    act(() => useAuthStore.getState().reset());
    expect(texts(stateBox(r2.container), "p")[0]).toBe("No GitHub remote");
  });
});

// ---- 展開一筆：它的檔（D11 全部），用 diff 區的檔案元件與條 ----
describe("PR pane: a pull request's files", () => {
  it("test_prPane_open_skeletonThenFiles_andCloseAgain", async () => {
    const read = deferred<DiffResult>();
    mocked.getPRDiff.mockReturnValue(read.promise);
    const { container } = renderPane();
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    fireEvent.click(row(container, 38));
    expect(row(container, 38).closest(".pr")?.classList.contains("open")).toBe(true);
    expect(row(container, 38).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".pr-body .skeleton")?.getAttribute("aria-label")).toBe("Loading files");
    expect(mocked.getPRDiff).toHaveBeenCalledWith(REPO, 38);
    await act(async () => {
      read.resolve(ONE_FILE);
      await read.promise;
    });
    expect(container.querySelector(".pr-body .dfile .dpath")?.textContent).toBe("src/main.ts");
    expect(container.querySelector(".pr-body .dl.add code")?.textContent).toBe("added");
    // 再點一次收起來
    fireEvent.click(row(container, 38));
    expect(container.querySelector(".pr-body")).toBeNull();
    expect(row(container, 38).getAttribute("aria-expanded")).toBe("false");
  });

  it("test_prPane_noFiles_emptyLine", async () => {
    mocked.getPRDiff.mockResolvedValue(diffOf([]));
    const { container } = renderPane();
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    fireEvent.click(row(container, 38));
    await waitFor(() => expect(container.querySelector(".pr-body .empty-line")?.textContent).toBe("No file changes"));
  });

  // 超過 GitHub 的上限（406 too_large）或 Kira 的 1 MB：一條、沒有 Retry（是事實不是失敗，D12）
  it("test_prPane_tooLarge_stripWithoutRetry", async () => {
    mocked.getPRDiff.mockRejectedValue({ code: "PR_DIFF_TOO_LARGE", message: "pull request diff too large" });
    const { container } = renderPane();
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    fireEvent.click(row(container, 38));
    await waitFor(() => expect(container.querySelector(".pr-body .strip")).not.toBeNull());
    expect(container.querySelector(".pr-body .strip")?.textContent).toBe("Too large to show here. Read this pull request on GitHub.");
    expect(container.querySelector(".pr-body button")).toBeNull();
    expect(container.querySelector(".pr-body [role=alert]")).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  // 收合的檔（B1）：跟 diff 區同兩條，文案換 pull request；格內沒有指令（PR 的檔不在本機）
  it("test_prPane_limits_stripsAndCellsWithoutACommand", async () => {
    mocked.getPRDiff.mockResolvedValue(
      diffOf(
        [
          plain("package-lock.json", { omitted: { reason: "File", lines: 2400, bytes: 96000 } }),
          plain("b.json", { omitted: { reason: "Total", lines: 10, bytes: 400 } }),
          plain("c.ts"),
        ],
        true,
      ),
    );
    const { container } = renderPane();
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    fireEvent.click(row(container, 38));
    await waitFor(() => expect(container.querySelectorAll(".pr-body .strip").length).toBe(2));
    expect(texts(container, ".pr-body .strip")).toEqual([
      "Showing the first 3 files. This pull request changes more.",
      "2 of 3 files not shown. 1 too large, 1 over the display limit.",
    ]);
    expect(container.querySelectorAll(".pr-body .dfile").length).toBe(3);
    expect(container.querySelector(".pr-body .dcell.warn .size")?.textContent).toBe("2,400 lines · 93.8 KiB");
    expect(container.textContent).not.toContain("In a terminal");
  });

  it("test_prPane_switchingPullRequests_readsTheOtherOnesFiles", async () => {
    mocked.getPRDiff
      .mockResolvedValueOnce(diffOf([plain("file-a.ts")]))
      .mockResolvedValueOnce(diffOf([plain("file-b.ts")]));
    const { container } = renderPane();
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    fireEvent.click(row(container, 39));
    await waitFor(() => expect(texts(container, ".pr-body .dpath")).toEqual(["file-a.ts"]));
    fireEvent.click(row(container, 38));
    await waitFor(() => expect(texts(container, ".pr-body .dpath")).toEqual(["file-b.ts"]));
    expect(container.querySelectorAll(".pr-body").length).toBe(1);
    expect(row(container, 39).getAttribute("aria-expanded")).toBe("false");
    expect(mocked.getPRDiff).toHaveBeenCalledTimes(2);
  });

  // 連點兩筆、先點的那筆的檔後到：畫的是後點的那筆（守門：diffRequestId；Gemini 測試面）
  it("test_prPane_switchingPullRequests_theEarlierOnesFilesLandingLate_areIgnored", async () => {
    const d39 = deferred<DiffResult>();
    const d38 = deferred<DiffResult>();
    mocked.getPRDiff.mockReturnValueOnce(d39.promise).mockReturnValueOnce(d38.promise);
    const { container } = renderPane();
    await waitFor(() => expect(list(container).querySelectorAll(".pr").length).toBe(3));
    fireEvent.click(row(container, 39));
    fireEvent.click(row(container, 38));
    await act(async () => {
      d38.resolve(diffOf([plain("file-b.ts")]));
      await d38.promise;
    });
    await waitFor(() => expect(texts(container, ".pr-body .dpath")).toEqual(["file-b.ts"]));
    await act(async () => {
      d39.resolve(diffOf([plain("file-a.ts")]));
      await d39.promise;
    });
    expect(texts(container, ".pr-body .dpath")).toEqual(["file-b.ts"]);
    expect(row(container, 38).getAttribute("aria-expanded")).toBe("true");
  });
});
