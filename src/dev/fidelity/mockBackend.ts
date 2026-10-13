// fidelity 入口的假後端：用 Tauri 官方的 mockIPC 攔截 invoke，回傳 fixture。
// 沒 mock 到的指令一律丟錯並記錄 —— 靜默回 undefined 會讓畫面「看起來正常」卻少了一塊。
import { mockIPC } from "@tauri-apps/api/mocks";
import { BaseDirectory } from "@tauri-apps/api/path";
import type { BranchStats, WorkingTreeStatus } from "@/lib/tauri";
import * as fx from "./fixture";
import { diffOf, type FixtureData } from "./states";

/** 最後一次收到 IPC 的時間；就緒判定用「IPC 靜止」而不是固定秒數。 */
export const ipcActivity = { last: 0, unmocked: [] as string[] };

/** 假後端照帳本丟出去的錯誤（物件本身）：入口的 console.error 攔截拿它比對，同一個物件出現在 log 引數裡
 *  就算帳上的；app 在那條路徑只印錯誤碼的，比對帳上宣告的那一行（log，見 main.tsx）。cmd 記下來，帳沒對上時
 *  報得出是哪個指令 */
export const thrownErrors: Array<{ cmd: string; error: object; log: string | null; logged: boolean }> = [];

const clone = <T>(v: T): T => structuredClone(v);

/** 後端每次 stage 操作後重讀 status，libgit2 依路徑排序 */
function sorted(next: WorkingTreeStatus): WorkingTreeStatus {
  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { ...next, staged: [...next.staged].sort(byPath), unstaged: [...next.unstaged].sort(byPath) };
}

type Payload = Record<string, unknown> | undefined;

/** 這一輪開機的資料（?on= / ?state= 轉換過的 fixture，見 states.ts）與視窗狀態 */
interface Backend {
  data: FixtureData;
  fullscreen: boolean;
  /** 從 data.status 複製；stage 操作只改這份 */
  workingTree: WorkingTreeStatus;
  /** 每個預期錯誤還要丟幾次 */
  failuresLeft: number[];
  /** 對照組（?unexpected=<指令>）：這個指令回錯但不記帳，入口必須 FAIL */
  unexpected: string | null;
}

function handle(b: Backend, cmd: string, payload: Payload): unknown {
  // 定格：永不回應（loading 的 graph、opening 的開 repo 讀取）
  if (b.data.pending.includes(cmd)) return new Promise(() => undefined);
  const i = b.data.failures.findIndex((f, k) => f.cmd === cmd && b.failuresLeft[k] > 0);
  if (i >= 0) {
    b.failuresLeft[i]--;
    const error = { ...b.data.failures[i].error };
    thrownErrors.push({ cmd, error, log: b.data.failures[i].log ?? null, logged: false });
    throw error;
  }
  if (cmd === b.unexpected) throw { code: "GIT_ERROR", message: "git operation failed" };
  switch (cmd) {
    case "recent_repos_get":
      return clone(b.data.recentRepos);
    case "git_open_recent_repo":
      return { repo_id: fx.REPO_ID, info: clone(b.data.repoInfo) };
    case "git_get_repo_info":
      return clone(b.data.repoInfo);
    case "git_get_graph":
      return clone(b.data.graph);
    case "git_get_status":
      return clone(b.workingTree);
    case "git_get_ahead_behind":
      return clone(b.data.aheadBehind);
    case "git_list_branches":
      return clone(b.data.listBranches);
    case "git_get_branch_stats": {
      const names = (payload?.branch_names as string[] | undefined) ?? [];
      const out: Record<string, BranchStats> = {};
      for (const name of names) out[name] = b.data.branchStats[name] ?? { ahead: null, behind: null };
      return out;
    }
    case "git_get_diff":
      return diffOf(b.data, String(payload?.oid ?? ""));
    case "github_get_auth_status":
      return clone(b.data.auth);
    // 後端先問 origin 是不是 github.com、再讀 token（commands/github.rs）：沒有 remote 時就算未登入也是「非 GitHub」。
    // 這兩個是狀態不是失敗（app 不記 console），不走帳本
    case "github_get_prs":
    case "github_get_pr_diff":
      if (b.data.repoInfo.remotes.length === 0) throw { code: "NOT_A_GITHUB_REPO", message: "not a GitHub repository" };
      if (!b.data.auth.authenticated) throw { code: "AUTH_FAILED", message: "authentication required" };
      if (cmd === "github_get_prs") return clone(b.data.prs);
      return { files: clone(b.data.prDiffs[Number(payload?.pr_number)] ?? []), truncated: false };
    // 站牌的 ~ 縮寫（@tauri-apps/api/path 的 homeDir）；只認家目錄，其他目錄當沒 mock 到
    case "plugin:path|resolve_directory":
      if (payload?.directory !== BaseDirectory.Home) break;
      return fx.HOME;
    // macOS 全螢幕讓位（App 開始時與每次 resize 查一次）；?chrome=full = 全螢幕
    case "plugin:window|is_fullscreen":
      return b.fullscreen;
    // 互動（D4 用）：只改記憶體裡的 working tree，跟 mockup 的 demo 同等級
    case "git_stage_file":
    case "git_unstage_file": {
      const path = String(payload?.path ?? "");
      const toStaged = cmd === "git_stage_file";
      const wt = b.workingTree;
      const from = toStaged ? wt.unstaged : wt.staged;
      const moved = from.find((f) => f.path === path);
      if (moved) {
        b.workingTree = sorted({
          ...wt,
          staged: toStaged ? [...wt.staged, moved] : wt.staged.filter((f) => f !== moved),
          unstaged: toStaged ? wt.unstaged.filter((f) => f !== moved) : [...wt.unstaged, moved],
        });
      }
      return { success: true };
    }
    case "git_stage_all": {
      const wt = b.workingTree;
      b.workingTree = sorted({ ...wt, staged: [...wt.staged, ...wt.unstaged], unstaged: [] });
      return { success: true };
    }
    case "git_unstage_all": {
      const wt = b.workingTree;
      b.workingTree = sorted({ ...wt, unstaged: [...wt.staged, ...wt.unstaged], staged: [] });
      return { success: true };
    }
  }
  ipcActivity.unmocked.push(cmd);
  throw new Error(`fidelity backend: unmocked command "${cmd}"`);
}

export function installFidelityBackend(data: FixtureData, opts: { fullscreen: boolean; unexpected: string | null }): void {
  const backend: Backend = {
    data,
    fullscreen: opts.fullscreen,
    workingTree: clone(data.status),
    failuresLeft: data.failures.map((f) => f.times),
    unexpected: opts.unexpected,
  };
  mockIPC(
    (cmd, payload) => {
      ipcActivity.last = performance.now();
      return handle(backend, cmd, payload as Payload);
    },
    { shouldMockEvents: true },
  );
}
