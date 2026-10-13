// fidelity.html 的入口：用 fixture 資料把真正的 App 跑起來，給 v8 複刻的截圖比對用。
// 參數（同基準 mockup/v8-kirazuri-lines-sys.html）：
//   ?theme=light|dark
//   ?on=<branch>         先 checkout 到那條分支
//   ?state=<name>[,...]  站牌的狀態：資料類（behind、diverged、no-upstream、no-remote、detached、
//                        signed-out）開機前轉換 fixture（states.ts）；畫面類（connecting、account-menu、
//                        error-*）開機後直接設狀態（同基準的 applyState，不模擬操作）；graph 的狀態
//                        （loading、empty、young、routes、new-branch、head-beyond、lodger、long-refs）與側欄的
//                        （opening、pruned、branches-error）也是資料類。opening 的讀取永不回應；branches-error
//                        走真實錯誤路徑，它的 console.error 要對得上預期錯誤帳本（states.ts 的 failures）。
//                        diff 區的（diff-empty、diff-error、diff-limits、diff-many、diff-bidi）也是資料類：
//                        diff 跟著狀態走，要選非 HEAD 的站時開機後選（同基準 select()，不給焦點）
//   ?unexpected=<指令>   對照組：這個指令回錯但不記帳，該格必須 FAIL（帳外的錯誤照樣進 __fidelityLog）
//   ?chrome=full         macOS 全螢幕（is_fullscreen 回 true）
//   ?scroll=end          graph 捲到載入的歷史盡頭（截斷的頁尾在那裡）
//   ?tip=<短 oid>        那列的站牌（tooltip）開著；日期依本地時區，比對要在台北時區跑
//   ?diffat=<路徑>       diff 捲到那個檔的檔頭（第一屏以下的檔、收合格、註記行才比得到）
//   ?tab=prs             右欄開在 Pull Requests 分頁，#38 展開（同基準 activate(tab-prs) + openPr = 38）；右欄的狀態
//                        （conflict、many-changes、changes-error、prs-*、pr-diff-*）也是資料類，prs-rate 的時刻依本地時區
// 就緒時設 html[data-ready="1"]（截圖工具輪詢它）；錯誤收進 window.__fidelityLog。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mockWindows } from "@tauri-apps/api/mocks";
import App from "@/App";
import "@/index.css";
import { initTheme, useThemeStore } from "@/stores/themeStore";
import { useRepoStore } from "@/stores/repoStore";
import { useGraphStore } from "@/stores/graphStore";
import { useAuthStore } from "@/stores/authStore";
import { useNoticeStore, SHELL_NOTICES } from "@/stores/noticeStore";
import { commitNotice, transportErrorNotice } from "@/lib/tauri";
import { escCode } from "@/lib/v8-highlight";
import { branchOpNotice } from "@/components/BranchList/branchOpNotice";
import { installFidelityBackend, ipcActivity, thrownErrors } from "./mockBackend";
import { diffOf, fixtureFor, type FixtureData } from "./states";
import { NOW } from "./fixture";

declare global {
  interface Window {
    __fidelityLog: string[];
  }
}

window.__fidelityLog = [];
const log = (msg: string) => window.__fidelityLog.push(msg);
window.addEventListener("error", (e) => log(`error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => log(`rejection: ${String(e.reason)}`));
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  // 帳上的錯誤（假後端照狀態宣告丟的那個物件，見 states.ts 的 failures）：app 照真實錯誤路徑記下它，
  // 每丟一次只准記一次；其餘一律算錯（多一行、字串不同、帳外的都是）。只印錯誤碼的路徑（getDiff）比對
  // 帳上宣告的那一整行
  const line = args.map(String).join(" ");
  const owed = thrownErrors.find((t) => !t.logged && (args.includes(t.error) || t.log === line));
  if (owed) owed.logged = true;
  else log(`console.error: ${args.map(String).join(" ")}`);
  consoleError(...args);
};

const params = new URLSearchParams(location.search);
const states = (params.get("state") ?? "").split(",").filter(Boolean);

// 每次都從乾淨狀態開始：截圖工具的 WebView 若共用儲存，上一輪的主題選擇會滲進來
localStorage.clear();
// 主題 store 在 import 時就用清除前的 storage hydrate 過（import 先於本檔其餘程式執行）：清完重來一次
void useThemeStore.persist.rehydrate();
// 凍結「現在」：PR 的 "2h ago" 等相對時間才會固定
Date.now = () => NOW;

let data: FixtureData | null = null;
try {
  // 拼錯的狀態名直接丟錯：靜默套成預設，截圖會「看起來正常」
  data = fixtureFor(params.get("on"), states);
} catch (err) {
  log(`boot failed: ${String(err)}`);
  document.documentElement.dataset.ready = "error";
}

if (data) {
  // getCurrentWindow() 要有視窗 metadata 才不會 throw（全螢幕偵測用）
  mockWindows("main");
  installFidelityBackend(data, { fullscreen: params.get("chrome") === "full", unexpected: params.get("unexpected") });
  initTheme();
  const theme = params.get("theme");
  if (theme) useThemeStore.getState().setTheme(theme === "dark" ? "dark" : "light");

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  boot(data).catch((err: unknown) => {
    log(`boot failed: ${String(err)}`);
    document.documentElement.dataset.ready = "error";
  });
}

function waitFor<T>(probe: () => T | null | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = probe();
      if (value) return resolve(value);
      if (performance.now() - start > timeoutMs) return reject(new Error(`fidelity: timed out waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const settle = () => new Promise((r) => setTimeout(r, 50));

async function boot(d: FixtureData): Promise<void> {
  // 走真正的使用者路徑：首頁近期清單 → 點第一個 repo → App 的 applyOpenResult
  const item = await waitFor(
    () => document.querySelector<HTMLButtonElement>(`button[title="${d.repoInfo.path}"]`),
    "recent repo item",
  );
  item.click();
  // ?tab=prs：開在 PR 分頁（同基準 activate(tab-prs)）。開 repo 後 tabs 才在；早點切，進場的淡入在就緒前就結束
  const prsTab = params.get("tab") === "prs";
  if (prsTab) (await waitFor(() => document.getElementById("tab-prs"), "the Pull Requests tab")).click();
  // 永不回應的（states.ts 的 pending）不等；讀不到的（branches-error / changes-error）等到它說讀不到
  const pending = (cmd: string) => d.pending.includes(cmd);
  await waitFor(() => {
    const repo = useRepoStore.getState();
    return (
      repo.repoId &&
      (pending("git_get_status") || repo.workingTreeStatus || repo.statusError) &&
      (pending("git_list_branches") || repo.branches || repo.branchesError) &&
      (pending("git_get_ahead_behind") || repo.aheadBehind) &&
      (pending("git_get_graph") || useGraphStore.getState().graphData)
    );
  }, "repo data");
  // IPC 靜止 250ms 視為載入完成，再等兩次繪製
  await waitFor(() => performance.now() - ipcActivity.last > 250, "IPC to settle");
  await settle();
  for (const s of states) await applyViewState(s, d);
  // IPC 靜止只證明沒有新請求，不證明畫面已提交：站牌、graph、側欄都要已經反映這一輪的資料
  await waitFor(() => signReflects(d), "the station sign to reflect the data");
  await waitFor(() => graphReflects(d), "the graph to reflect the data");
  await waitFor(() => sidebarReflects(d), "the sidebar to reflect the data");
  await waitFor(() => changesReflects(d), "the Changes pane to reflect the data");
  if (prsTab) {
    await waitFor(() => prsReflects(d), "the Pull Requests pane to reflect the data");
    await openPullRequest(d);
  }
  // diff 的狀態選的站（同基準 select()：不給焦點，graph 把那列捲進視野）
  if (d.select) {
    const commit = useGraphStore.getState().graphData?.commits.find((c) => c.oid === d.select);
    if (!commit) throw new Error(`fidelity: no commit ${d.select} to select`);
    useGraphStore.getState().actions.setSelectedCommit(commit);
  }
  await waitFor(() => diffReflects(d), "the diff to reflect the data");
  // ?diffat=<路徑>：diff 畫好之後捲到那個檔的檔頭、離頂端 12px（同基準，比對截圖才拍得到第一屏以下）。
  // 找不到那個檔寫進日誌：拼錯的路徑靜默不捲，兩邊都停在頂端也會「看起來一樣」
  const diffAt = params.get("diffat");
  if (diffAt) {
    const area = document.getElementById("diff")!;
    const file = [...area.querySelectorAll(".dfile")].find((f) => f.querySelector(".dpath")?.textContent === diffAt);
    if (file) area.scrollTop += file.getBoundingClientRect().top - area.getBoundingClientRect().top - 12;
    else log(`?diffat=: no file "${diffAt}" in the diff`);
  }
  // 側欄近期清單的日期依本地時區算，基準寫死台北的日期：時區不同就不是同一張圖
  const offset = new Date().getTimezoneOffset();
  if (offset !== -480) log(`recent dates need the Asia/Taipei timezone (getTimezoneOffset ${offset})`);
  // ?scroll=end：捲到載入的歷史盡頭（同基準，給頁尾的比對截圖用）
  if (params.get("scroll") === "end") {
    const scroller = document.querySelector<HTMLElement>(".graph-scroll");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
  // ?tip=<短 oid>：那列的站牌開著（同基準）。走真的 hover 路徑：mouseover → 300ms 意圖延遲 → 顯示
  const tipAt = params.get("tip");
  if (tipAt) {
    // 基準站牌上的日期是寫死的台北時間字串，app 用本地時區算：時區不同就不是同一張圖，寫進日誌讓它 FAIL
    const offset = new Date().getTimezoneOffset();
    if (offset !== -480) log(`?tip= needs the Asia/Taipei timezone (getTimezoneOffset ${offset})`);
    const row = await waitFor(() => document.querySelector<HTMLElement>(`.graph [data-oid^="${tipAt}"]`), `row ${tipAt}`);
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await waitFor(() => document.querySelector(".tip.show"), "the station board");
  }
  if (ipcActivity.unmocked.length) log(`unmocked: ${[...new Set(ipcActivity.unmocked)].join(", ")}`);
  // 結帳：宣告的錯誤要照次數丟出、每次都被 app 記下（沒用完 = 該走的錯誤路徑沒走到）；silent 的要丟了但不被記
  for (const f of d.failures) {
    const mine = thrownErrors.filter((t) => t.cmd === f.cmd);
    const logged = mine.filter((t) => t.logged).length;
    const wantLogged = f.silent ? 0 : f.times;
    if (mine.length !== f.times || logged !== wantLogged) {
      log(`ledger: ${f.cmd} expected ${f.times} error(s)${f.silent ? " unlogged" : ""}, thrown ${mine.length}, logged ${logged}`);
    }
  }
  document.documentElement.dataset.ready = "1";
}

/** 站牌與資料對得上：loading 時「你在這裡」不在、Switch repo 停用（開 repo 還在跑）；其餘開 repo 的流程
 *  已經結束（Switch repo 啟用——graph 寫進 store 之後 bootLoading 才在下一輪清掉，只等 IPC 靜止的話
 *  機器忙時會截到停用的 Switch repo，10-08 實際截到過一次）、unborn 有 note、「你在這裡」已經畫出來 */
function signReflects(d: FixtureData): boolean {
  const youAre = document.querySelector("#youare");
  const switchRepo = [...document.querySelectorAll<HTMLButtonElement>(".tools > .btn")].at(-1);
  if (switchRepo?.textContent?.trim() !== "Switch repo") return false;
  if (d.pending.includes("git_get_graph")) return youAre === null && switchRepo.disabled;
  if (switchRepo.disabled) return false;
  if (d.graph.head.oid === null && d.graph.head.branch !== null) return document.querySelector("#you-note") !== null;
  return youAre !== null;
}

/** graph 區畫的是這一份資料：loading 有骨架、空 repo 有空狀態，其餘每個 commit 一列 */
function graphReflects(d: FixtureData): boolean {
  if (d.pending.includes("git_get_graph")) return document.querySelector(".graph-loading") !== null;
  if (d.graph.commits.length === 0) return document.querySelector(".graph-empty") !== null;
  return document.querySelectorAll('.graph [role="option"]').length === d.graph.commits.length;
}

/** 側欄分支區畫的是這一份資料：還沒回來是四列骨架、讀不到是那一行，其餘每個分支一列（沒有就是
 *  No branches yet）；graph 回來了的話圓標也到了（沒有骨架圓點） */
function sidebarReflects(d: FixtureData): boolean {
  const list = document.querySelector("#branch-list");
  if (!list) return false;
  if (d.pending.includes("git_list_branches")) return list.querySelectorAll(".sk-branch").length === 4;
  if (d.failures.some((f) => f.cmd === "git_list_branches")) return list.querySelector("[role=alert]") !== null;
  const rows = list.querySelectorAll(".branch").length;
  const want = d.listBranches.branches.length;
  if (want === 0) return list.querySelector(".empty-line") !== null;
  if (rows !== want) return false;
  return d.pending.includes("git_get_graph") || list.querySelector(".sk-rd") === null;
}

/** Changes 分頁畫的是這一份資料：status 還沒回來是骨架列、讀不到是 pane-empty 那格，其餘三個清單各一列一個檔 */
function changesReflects(d: FixtureData): boolean {
  if (d.pending.includes("git_get_status")) return document.querySelectorAll("#staged .sk-file").length === 2;
  if (d.failures.some((f) => f.cmd === "git_get_status")) return document.querySelector("#changes-state") !== null;
  const count = (sel: string) => document.querySelectorAll(sel).length;
  return (
    count("#staged .file") === d.status.staged.length &&
    count("#unstaged .file") === d.status.unstaged.length &&
    count("#conflicted .file") === d.status.conflicted.length
  );
}

/** PR 分頁畫的是這一份資料：還沒回來是三列骨架、讀不到是 role=alert 的那格、沒有 remote / 未登入 / 沒有開著的 PR
 *  各是它的空狀態，其餘每筆一列；graph 回來了的話 head 停在有 ref 的站上的那幾筆有 via（Q-L） */
function prsReflects(d: FixtureData): boolean {
  const list = document.getElementById("prs");
  const box = document.getElementById("prs-state");
  if (!list || !box) return false;
  if (d.pending.includes("github_get_prs")) return list.querySelectorAll(".sk-pr").length === 3;
  if (d.failures.some((f) => f.cmd === "github_get_prs")) return box.getAttribute("role") === "alert";
  if (d.repoInfo.remotes.length === 0) return box.textContent?.includes("No GitHub remote") ?? false;
  if (!d.auth.authenticated) return box.querySelector("#prs-connect") !== null;
  if (d.prs.length === 0) return box.textContent?.includes("No open pull requests") ?? false;
  if (list.querySelectorAll(".pr-row").length !== d.prs.length) return false;
  if (d.pending.includes("git_get_graph")) return list.querySelector(".via") === null;
  const targets = new Set(d.graph.branches.map((b) => b.target));
  return list.querySelectorAll(".via").length === d.prs.filter((p) => targets.has(p.head_sha)).length;
}

/** PR 分頁預設展開 #38（基準 openPr = 38）：清單在才點；它的檔到了（或永不回應的骨架、讀不到的那行、太大的那條）才算就緒 */
async function openPullRequest(d: FixtureData): Promise<void> {
  const row = document.querySelector<HTMLButtonElement>('.pr-row[data-pr="38"]');
  if (!row) return;
  row.click();
  await waitFor(() => prBodyReflects(d), "the pull request's files to reflect the data");
}

function prBodyReflects(d: FixtureData): boolean {
  const body = document.querySelector(".pr.open .pr-body");
  if (!body) return false;
  if (d.pending.includes("github_get_pr_diff")) return body.querySelector(".skeleton") !== null;
  const failure = d.failures.find((f) => f.cmd === "github_get_pr_diff");
  if (failure) {
    return failure.silent
      ? body.querySelector(".strip") !== null && body.querySelector("[role=alert]") === null
      : body.querySelector("[role=alert]") !== null;
  }
  const files = d.prDiffs[38] ?? [];
  if (files.length === 0) return body.querySelector(".empty-line") !== null;
  const shown = [...body.querySelectorAll(".dfile .dpath")].map((p) => p.textContent);
  return shown.length === files.length && shown.every((p, i) => p === shownPath(files[i].path));
}

/** 檔頭路徑畫出來的文字：雙向控制字元換成名字（同 FileDiff 走的 escCode） */
const shownPath = (path: string) => {
  const span = document.createElement("span");
  span.innerHTML = escCode(path);
  return span.textContent;
};

/** diff 區畫的是這一份資料：沒有選取是空狀態、讀不到是那一行，其餘是選取那個 commit 的檔、依序一個不差
 *  （比路徑不比檔數：剛換選取時舊的 diff 還在畫面上，檔數可能剛好一樣） */
function diffReflects(d: FixtureData): boolean {
  const area = document.getElementById("diff");
  const selected = useGraphStore.getState().selectedCommit;
  if (!area) return false;
  if (!selected) return area.querySelector(".diff-empty") !== null;
  if (d.failures.some((f) => f.cmd === "git_get_diff")) return area.querySelector("[role=alert]") !== null;
  const want = diffOf(d, selected.full_oid).files.map((f) => shownPath(f.path));
  if (want.length === 0) return area.querySelector(".diff-empty") !== null;
  const shown = [...area.querySelectorAll(".dfile .dpath")].map((p) => p.textContent);
  return shown.length === want.length && shown.every((p, i) => p === want[i]);
}

// 畫面類狀態：直接設狀態（同基準的 applyState），資料類在開機前已由 fixtureFor 轉好。
// 提示用真實失敗路徑的同一個文案函式並帶錯誤碼，錯誤碼 → 文案的對照因此也在 D1 驗到
async function applyViewState(s: string, d: FixtureData): Promise<void> {
  const notice = useNoticeStore.getState();
  switch (s) {
    case "connecting":
      // 未登入（fixture 已轉）後按了 Connect、還在等 GitHub；沒有 deviceFlow，對話框不出現
      useAuthStore.getState().setStatus("starting");
      break;
    case "account-menu": {
      // 開關是元件狀態：點帳號打開，再拿掉焦點（基準的靜態狀態沒有焦點環）
      document.querySelector<HTMLButtonElement>("#account")!.click();
      await settle();
      (document.activeElement as HTMLElement | null)?.blur();
      break;
    }
    case "error-push":
      notice.show({ ...transportErrorNotice(d.aheadBehind.has_upstream ? "Push" : "Publish", { code: "REJECTED" }), from: "push" });
      break;
    case "error-pull":
      notice.show({ ...transportErrorNotice("Pull", { code: "CONFLICT" }), from: "pull" });
      break;
    case "error-refresh":
      notice.show(SHELL_NOTICES.refresh);
      break;
    case "error-open":
      notice.show(SHELL_NOTICES.openRecent);
      break;
    case "error-auth":
      notice.show(SHELL_NOTICES.signIn);
      break;
    case "error-signout":
      notice.show(SHELL_NOTICES.signOut);
      break;
    case "error-checkout": {
      // 側欄按了 checkout、工作區有改動（基準 NOTICES：焦點回 fix/toolbar-jump 那一列）
      const row = () =>
        [...document.querySelectorAll<HTMLElement>("#branch-list .branch-btn")].find(
          (b) => b.dataset.branch === "fix/toolbar-jump",
        ) ?? null;
      notice.show({ ...branchOpNotice("checkout", { code: "DIRTY_TREE" }), from: row });
      break;
    }
    case "error-commit":
      // 按了 Commit、git 沒設身分（基準 NOTICES：焦點回 Commit）
      notice.show({ ...commitNotice({ code: "GIT_IDENTITY_MISSING" }), from: () => document.getElementById("commit") });
      break;
    default:
      // 資料類（fixtureFor 已套用）
      return;
  }
  await settle();
}
