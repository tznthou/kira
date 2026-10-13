import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "@/stores/authStore";
import { useNoticeStore, SHELL_NOTICES } from "@/stores/noticeStore";
import { githubLogout, githubGetAuthStatus } from "@/lib/tauri";
import { connectGitHub } from "@/components/Auth/connectGitHub";

// v8 基準站牌角落的 GitHub 帳號（0b §1、子超裁定 B1）：登入後點帳號開小選單「Signed in as … /
// Sign out」，未登入時同一個位置是 Connect GitHub，連線中停用。device code 對話框由 App root
// render（不在站牌裡：站牌整條是拖曳區）。
export function Account() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const username = useAuthStore((s) => s.username);
  const status = useAuthStore((s) => s.status);
  const [menuOpen, setMenuOpen] = useState(false);
  const acctRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const signOutRef = useRef<HTMLButtonElement>(null);

  const state: "in" | "connecting" | "out" = isAuthenticated
    ? "in"
    : status === "starting" || status === "pending"
      ? "connecting"
      : "out";

  // Boot: 嘗試從 keyring 拿既有 token，若有效自動登入
  useEffect(() => {
    let cancelled = false;
    githubGetAuthStatus()
      .then((s) => {
        if (cancelled) return;
        if (s.authenticated) useAuthStore.getState().setAuthenticated(s.username);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[kira] auth status check failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 登出、token 失效（authStore.reset）時選單跟著收。在 render 時就收、不用 effect：effect 在 paint
  // 之後才跑，中間那一幀會畫出 Connect GitHub 旁邊還開著、名字空白的選單
  if (menuOpen && state !== "in") setMenuOpen(false);

  // 點外面關：聽 document 的 capture 階段 pointerdown。站牌是 Tauri 的拖曳區，它的 drag.js 在
  // document 的 mousedown 上 stopImmediatePropagation 並開始原生拖曳，click 在那裡可能收不到
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!acctRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [menuOpen]);

  useEffect(() => {
    if (menuOpen) signOutRef.current?.focus();
  }, [menuOpen]);

  const signOut = async () => {
    setMenuOpen(false);
    useNoticeStore.getState().clear();
    try {
      await githubLogout();
      useAuthStore.getState().reset();
      buttonRef.current?.focus();
    } catch (err) {
      // keyring delete 失敗代表 token 仍在系統 keychain；前端不能虛假地顯示「已登出」，
      // 否則 UI 跟實際 credential state 脫鉤，後續 push/pull 仍會用到舊 token
      console.error("[kira] logout failed:", err);
      useNoticeStore.getState().show(SHELL_NOTICES.signOut);
    }
  };

  // 選單裡唯一能聚焦的是 Sign out，Esc / Tab 都從它發生（掛在選單上要讓選單可聚焦，基準沒有）
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setMenuOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === "Tab") {
      setMenuOpen(false);
    }
  };

  return (
    <div className="acct" ref={acctRef}>
      <button
        ref={buttonRef}
        className={state === "in" ? "account" : "account out"}
        id="account"
        type="button"
        disabled={state === "connecting"}
        title={
          state === "in"
            ? "Signed in to GitHub"
            : state === "connecting"
              ? "Waiting for GitHub…"
              : "Connect GitHub to see pull requests"
        }
        aria-haspopup={state === "in" ? "menu" : undefined}
        aria-expanded={state === "in" ? menuOpen : undefined}
        onClick={() => {
          if (state === "out") void connectGitHub("account");
          else if (state === "in") setMenuOpen((open) => !open);
        }}
      >
        <span className="avatar" id="avatar" aria-hidden="true">
          {/* 頭像 = 登入名前兩個字母；GitHub 頭像圖要網路，不抓 */}
          {state === "in" ? (
            (username ?? "").slice(0, 2).toUpperCase()
          ) : (
            <svg aria-hidden="true">
              <use href="#i-person" />
            </svg>
          )}
        </span>
        <span id="acct-name">{state === "in" ? username : state === "connecting" ? "Connecting…" : "Connect GitHub"}</span>
      </button>
      {/* 選單是站牌（deep 拖曳區）的後代，drag.js 不把 role=menu 當互動元素：不設 false 的話
          在「Signed in as」上按下會拖動視窗、雙擊會 zoom */}
      <div
        className="menu enter"
        id="acct-menu"
        role="menu"
        aria-label="GitHub account"
        hidden={!menuOpen}
        data-tauri-drag-region="false"
      >
        <p className="menu-head">
          Signed in as <b>{username}</b>
        </p>
        <button
          ref={signOutRef}
          className="menu-item"
          id="signout"
          type="button"
          role="menuitem"
          onClick={() => void signOut()}
          onKeyDown={onMenuKeyDown}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
