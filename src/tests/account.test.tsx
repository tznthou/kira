import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Profiler } from "react";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import { Account } from "@/components/Topbar/Account";
import { useAuthStore } from "@/stores/authStore";
import { useNoticeStore } from "@/stores/noticeStore";

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    githubGetAuthStatus: vi.fn(),
    githubStartDeviceFlow: vi.fn(),
    githubLogout: vi.fn(),
  };
});

import { githubGetAuthStatus, githubStartDeviceFlow, githubLogout } from "@/lib/tauri";

const mocked = {
  status: vi.mocked(githubGetAuthStatus),
  start: vi.mocked(githubStartDeviceFlow),
  logout: vi.mocked(githubLogout),
};

const FLOW = {
  device_code: "dc",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

function renderAccount() {
  const utils = render(
    <>
      <Account />
      <button id="elsewhere">Elsewhere</button>
    </>,
  );
  const q = <T extends Element>(sel: string) => utils.container.querySelector<T>(sel)!;
  return {
    ...utils,
    account: () => q<HTMLButtonElement>("#account"),
    menu: () => q<HTMLDivElement>("#acct-menu"),
    signOut: () => q<HTMLButtonElement>("#signout"),
  };
}

describe("Account", () => {
  beforeEach(() => {
    Object.values(mocked).forEach((m) => m.mockReset());
    mocked.status.mockResolvedValue({ authenticated: true, username: "tznthou" });
    useAuthStore.getState().reset();
    useNoticeStore.setState({ notice: null });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("test_account_signedIn_showsInitialsAndAClosedMenu", async () => {
    const { account, menu, container } = renderAccount();
    await waitFor(() => expect(account().className).toBe("account"));
    expect(container.querySelector("#avatar")?.textContent).toBe("TZ");
    expect(container.querySelector("#acct-name")?.textContent).toBe("tznthou");
    expect(account().title).toBe("Signed in to GitHub");
    expect(account().getAttribute("aria-haspopup")).toBe("menu");
    expect(account().getAttribute("aria-expanded")).toBe("false");
    expect(menu().hidden).toBe(true);
    expect(container.querySelector(".menu-head")?.textContent).toBe("Signed in as tznthou");
  });

  // 選單在站牌（deep 拖曳區）裡：不設 false 的話按住標題會拖動視窗、雙擊會 zoom
  it("test_account_menu_optsOutOfTheDragRegion", () => {
    const { menu } = renderAccount();
    expect(menu().getAttribute("data-tauri-drag-region")).toBe("false");
    expect(menu().getAttribute("role")).toBe("menu");
  });

  it("test_account_click_opensTheMenuAndFocusesSignOut", async () => {
    const { account, menu, signOut } = renderAccount();
    await waitFor(() => expect(account().className).toBe("account"));
    fireEvent.click(account());
    expect(menu().hidden).toBe(false);
    expect(account().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(signOut());
    fireEvent.click(account());
    expect(menu().hidden).toBe(true);
  });

  it("test_account_escape_closesAndReturnsFocus", async () => {
    const { account, menu, signOut } = renderAccount();
    await waitFor(() => expect(account().className).toBe("account"));
    fireEvent.click(account());
    fireEvent.keyDown(signOut(), { key: "Escape" });
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(account());
  });

  it("test_account_tab_closesTheMenu", async () => {
    const { account, menu, signOut } = renderAccount();
    await waitFor(() => expect(account().className).toBe("account"));
    fireEvent.click(account());
    fireEvent.keyDown(signOut(), { key: "Tab" });
    expect(menu().hidden).toBe(true);
  });

  // 點外面關：drag.js 會吃掉拖曳區裡的 mousedown / click，所以聽 capture 階段的 pointerdown
  it("test_account_pointerDownOutside_closesTheMenu", async () => {
    const { account, menu, getByText } = renderAccount();
    await waitFor(() => expect(account().className).toBe("account"));
    fireEvent.click(account());
    fireEvent.pointerDown(menu().querySelector(".menu-head")!);
    expect(menu().hidden).toBe(false);
    fireEvent.pointerDown(getByText("Elsewhere"));
    expect(menu().hidden).toBe(true);
  });

  it("test_account_signOut_signsOutAndKeepsFocusOnTheAccount", async () => {
    mocked.logout.mockResolvedValue(undefined);
    const { account, signOut, container } = renderAccount();
    await waitFor(() => expect(account().className).toBe("account"));
    useNoticeStore.getState().show({ title: "Refresh failed.", from: "refresh" });
    fireEvent.click(account());
    fireEvent.click(signOut());

    await waitFor(() => expect(account().className).toBe("account out"));
    expect(mocked.logout).toHaveBeenCalledTimes(1);
    expect(container.querySelector("#acct-name")?.textContent).toBe("Connect GitHub");
    expect(document.activeElement).toBe(account());
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  // token 還在 keychain：不能顯示成已登出；失敗說在站牌上（原本看不到）
  it("test_account_signOutFailure_staysSignedInAndSaysSo", async () => {
    mocked.logout.mockRejectedValue({ code: "KEYRING_ERROR" });
    const { account, signOut } = renderAccount();
    await waitFor(() => expect(account().className).toBe("account"));
    fireEvent.click(account());
    fireEvent.click(signOut());

    await waitFor(() =>
      expect(useNoticeStore.getState().notice).toMatchObject({
        title: "Sign out failed.",
        detail: "Try again.",
        from: "account",
      }),
    );
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(account().className).toBe("account");
  });

  it("test_account_signedOut_offersConnect", async () => {
    mocked.status.mockResolvedValue({ authenticated: false, username: null });
    const { account, container } = renderAccount();
    await waitFor(() => expect(mocked.status).toHaveBeenCalled());
    expect(account().className).toBe("account out");
    expect(account().title).toBe("Connect GitHub to see pull requests");
    expect(account().hasAttribute("aria-haspopup")).toBe(false);
    expect(container.querySelector("#avatar use")?.getAttribute("href")).toBe("#i-person");
  });

  it("test_account_connect_waitsForGitHub", async () => {
    mocked.status.mockResolvedValue({ authenticated: false, username: null });
    mocked.start.mockResolvedValue(FLOW);
    const { account, container } = renderAccount();
    await waitFor(() => expect(mocked.status).toHaveBeenCalled());
    useNoticeStore.getState().show({ title: "Refresh failed.", from: "refresh" });

    fireEvent.click(account());

    expect(useNoticeStore.getState().notice).toBeNull();
    await waitFor(() => expect(useAuthStore.getState().deviceFlow?.user_code).toBe("ABCD-1234"));
    expect(account().disabled).toBe(true);
    expect(account().title).toBe("Waiting for GitHub…");
    expect(container.querySelector("#acct-name")?.textContent).toBe("Connecting…");
  });

  it("test_account_connectFailure_goesBackOutAndSaysSo", async () => {
    mocked.status.mockResolvedValue({ authenticated: false, username: null });
    mocked.start.mockRejectedValue({ code: "NETWORK_ERROR" });
    const { account } = renderAccount();
    await waitFor(() => expect(mocked.status).toHaveBeenCalled());

    fireEvent.click(account());

    await waitFor(() =>
      expect(useNoticeStore.getState().notice).toMatchObject({
        title: "GitHub sign-in failed.",
        detail: "Check your network.",
        from: "account",
      }),
    );
    expect(account().className).toBe("account out");
    expect(account().disabled).toBe(false);
  });

  // token 在別處失效（authStore.reset）時，開著的選單跟著收
  it("test_account_signedOutElsewhere_closesTheMenu", async () => {
    const { account, menu } = renderAccount();
    await waitFor(() => expect(account().className).toBe("account"));
    fireEvent.click(account());
    act(() => useAuthStore.getState().reset());
    expect(menu().hidden).toBe(true);
    expect(account().className).toBe("account out");
  });

  // 選單要跟登出在同一次 commit 收起來：effect 在 paint 之後才跑，中間那一幀會畫出 Connect GitHub
  // 旁邊還開著、名字空白的「Signed in as」（token 失效由 promise 觸發，不是離散事件，會被畫出來）。
  // act 會把 effect 一併跑完，只看最後的 DOM 抓不到 → Profiler 在每次 commit 記下當時的 DOM
  it("test_account_signedOutElsewhere_neverCommitsTheMenuOpenWhenOut", async () => {
    const commits: string[] = [];
    let recording = false;
    const record = () => {
      if (!recording) return;
      const account = document.querySelector<HTMLButtonElement>("#account")!;
      const menu = document.querySelector<HTMLDivElement>("#acct-menu")!;
      commits.push(`${account.className}|${menu.hidden ? "closed" : "open"}`);
    };
    render(
      <Profiler id="account" onRender={record}>
        <Account />
      </Profiler>,
    );
    await waitFor(() => expect(document.querySelector("#account")?.className).toBe("account"));
    fireEvent.click(document.querySelector("#account")!);
    expect(document.querySelector<HTMLDivElement>("#acct-menu")?.hidden).toBe(false);

    recording = true;
    act(() => useAuthStore.getState().reset());
    recording = false;
    expect(commits).not.toContain("account out|open");
    expect(commits[commits.length - 1]).toBe("account out|closed");
  });
});
