import { useCallback, useEffect, useRef, useState } from "react";
import { githubGetPRs, githubGetPRDiff, type DiffResult, type PullRequestInfo } from "@/lib/tauri";
import { useAuthStore } from "@/stores/authStore";
import { resetHint } from "@/lib/resetHint";
import { viaLook } from "@/lib/rowRefs";
import type { RouteMap } from "@/lib/routeMap";
import { Roundel } from "@/components/ui/Roundel";
import { FileDiff } from "@/components/DiffViewer/FileDiff";
import { LimitStrips, Strip } from "@/components/DiffViewer/Strips";
import { connectGitHub } from "@/components/Auth/connectGitHub";

type ListState =
  | { kind: "loading" }
  | { kind: "ok"; prs: PullRequestInfo[] }
  | { kind: "empty" }
  | { kind: "not-github" }
  | { kind: "signed-out" }
  | { kind: "rate"; hint: string }
  | { kind: "error" };

type DiffState = { kind: "loading" } | { kind: "ok"; diff: DiffResult } | { kind: "error" } | { kind: "large" };

const errorCode = (err: unknown) =>
  typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "";

// 清單讀不到時畫什麼（0b P5 §1.4）。後端先問 origin 是不是 github.com、再讀 token：沒有 remote 時就算未登入也是
// 「非 GitHub」。未登入與非 GitHub 是狀態不是失敗，不記 console；rate limit 與其他失敗只記錯誤碼（安全 M01）
function listFailure(err: unknown): ListState {
  const code = errorCode(err);
  switch (code) {
    case "AUTH_FAILED":
      return { kind: "signed-out" };
    case "NOT_A_GITHUB_REPO":
      return { kind: "not-github" };
    case "RATE_LIMITED":
      console.error("[kira] getPRs failed:", code);
      // 重置時刻寫成時鐘時間，畫面停著也不會過期（0b §3.1；reset_at 是 step 1 加的）
      return { kind: "rate", hint: resetHint((err as { reset_at?: number | null }).reset_at, Date.now()) };
    default:
      console.error("[kira] getPRs failed:", code || "unknown");
      return { kind: "error" };
  }
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** 審查與 CI 的狀態圖示（基準 STATUS / statusIcon）；不認得的狀態不畫 */
const STATUS: Record<string, { cls: "ok" | "bad" | "wait"; label: string }> = {
  approved: { cls: "ok", label: "Approved" },
  changes_requested: { cls: "bad", label: "Changes requested" },
  success: { cls: "ok", label: "Checks passing" },
  failure: { cls: "bad", label: "Checks failing" },
  pending: { cls: "wait", label: "Checks pending" },
};

function StatusIcon({ state }: { state: string | null }) {
  const s = state === null ? undefined : STATUS[state];
  if (!s) return null;
  return (
    <svg className={`st ${s.cls}`} role="img" aria-label={s.label}>
      <title>{s.label}</title>
      <use href={`#i-${s.cls}`} />
    </svg>
  );
}

/** 區的圖：離開主幹又回來的一條線——路線圖的話裡的 pull request（基準 PR_PICTURE） */
function PrPicture() {
  return (
    <svg viewBox="0 0 176 36" aria-hidden="true">
      <path d="M10 27H166" stroke="var(--l-trunk)" strokeWidth="3.25" strokeLinecap="round" />
      <path
        d="M40 27 50 13H116L126 27"
        fill="none"
        stroke="var(--line)"
        strokeWidth="3.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path d="M72 13v-6M96 13v-6" stroke="var(--line)" strokeWidth="3.25" strokeLinecap="round" />
      <circle cx="126" cy="27" r="5.6" fill="var(--sheet-hi)" stroke="var(--l-trunk)" strokeWidth="2.2" />
    </svg>
  );
}

/** 清單讀不到（基準 READ_FAILED）：記號 + 粗體結論 + 一句 + Retry */
function ReadFailed({ what, hint, onRetry }: { what: string; hint: string; onRetry: () => void }) {
  return (
    <>
      <svg className="mark" aria-hidden="true">
        <use href="#i-bad" />
      </svg>
      <p>
        <b>{what}</b>
      </p>
      <p className="hint">{hint}</p>
      <button className="btn" type="button" id="prs-retry" onClick={onRetry}>
        Retry
      </button>
    </>
  );
}

const SK_PR: readonly [number, number][] = [
  [78, 46],
  [64, 52],
  [71, 40],
];

/**
 * Pull Requests 分頁（Phase 5 5c step 8，照基準 renderPRs / prBody）。清單來自 GitHub API，不在 repoStore 那批
 * refresh 裡：開 repo、使用者按 Refresh（refreshToken）、登入成功（未登入 → 已登入；AUTH_FAILED 的 reset 是反方向，
 * 不重抓）才讀；watcher 不碰它（§4）。登出 → 區內回到 Connect GitHub（沒有 GitHub remote 的照舊）。
 * 展開一筆讀它的檔（全部，D11），用 diff 區的檔案元件與條；太大（GitHub 的 406 或 Kira 的 1 MB）是事實不是失敗：
 * 一條、沒有 Retry。Retry 之後焦點（Q-F）：清單 → 這一格（tabpanel）、檔案 → 那筆 PR 的列；再失敗且焦點還在 →
 * 新的 Retry；中途移走不動。分頁藏起來時不卸載（PaneTabs 用 hidden）
 */
export function PRPanel({
  repoId,
  refreshToken = 0,
  routes,
}: {
  repoId: string;
  refreshToken?: number;
  /** 路線圖：每筆 PR 的 via（head_sha 停的那站的 ref）從這裡讀；graph 還沒回來（null）不畫（Q-L） */
  routes: RouteMap | null;
}) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const authStatus = useAuthStore((s) => s.status);
  const connecting = !isAuthenticated && (authStatus === "starting" || authStatus === "pending");
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [open, setOpen] = useState<number | null>(null);
  const [diff, setDiff] = useState<DiffState>({ kind: "loading" });
  const listRef = useRef<HTMLUListElement>(null);
  const requestId = useRef(0);
  const diffRequestId = useRef(0);
  // 同一把 key 的清單讀還在飛就跟它、不再送一次：StrictMode 開發時 mount 的 effect 跑兩次，重送會把假後端帳上
  // 「只回錯一次」的失敗吃掉、第一次的結果又因不是最新被丟（D1 的 prs-rate 看到的是清單）。Retry 與登入另發
  const inflight = useRef<{ key: string; done: Promise<void> } | null>(null);
  const fetchSeq = useRef(0);
  // Retry 之後的焦點（Q-F）：effect 讀當下的狀態，不綁進依賴
  const latest = useRef({ state, open, diff });
  latest.current = { state, open, diff };
  const [listRetried, setListRetried] = useState(0);
  const [diffRetried, setDiffRetried] = useState(0);

  const pane = () => listRef.current?.closest<HTMLElement>("[role=tabpanel]") ?? null;
  const rowOf = (n: number) =>
    [...(listRef.current?.querySelectorAll<HTMLElement>(".pr-row") ?? [])].find((b) => b.dataset.pr === String(n)) ??
    null;

  const fetchPRs = useCallback(
    (key: string): Promise<void> => {
      if (inflight.current?.key === key) return inflight.current.done;
      const myId = ++requestId.current;
      setState({ kind: "loading" });
      const done = (async () => {
        try {
          const prs = await githubGetPRs(repoId, "open");
          if (requestId.current !== myId) return;
          setState(prs.length > 0 ? { kind: "ok", prs } : { kind: "empty" });
        } catch (err) {
          if (requestId.current !== myId) return;
          const failure = listFailure(err);
          // 請求是在還沒有 token 時送出的、回來前登入了（同一次登入的 AUTH_FAILED 會先被 auth guard 登出，到這裡
          // 還是已登入的就是後來才登入的）：帶著新 token 再讀一次，不停在「未登入」
          if (failure.kind === "signed-out" && useAuthStore.getState().isAuthenticated) {
            void fetchPRs(`signin#${++fetchSeq.current}`);
            return;
          }
          setState(failure);
        } finally {
          if (inflight.current?.key === key) inflight.current = null;
        }
      })();
      inflight.current = { key, done };
      return done;
    },
    [repoId],
  );
  const fetchAgain = () => fetchPRs(`again#${++fetchSeq.current}`);

  // 換 repo：展開的那筆與它的檔都不是這個 repo 的
  useEffect(() => {
    setOpen(null);
    setDiff({ kind: "loading" });
    diffRequestId.current++;
  }, [repoId]);

  // refreshToken 是刻意的「重抓」訊號——掛在 effect 上而非 useCallback 依賴：bump 就重跑一次（key 跟著換）
  useEffect(() => {
    void fetchPRs(`${repoId}#${refreshToken}`);
  }, [fetchPRs, repoId, refreshToken]);

  // 登入狀態換了：未登入 → 已登入是使用者操作，重抓一次（基準 connect 之後 fetchPRs）——但只在上一次讀的結果是
  // 「未登入」時：開機時 keychain 裡本來就有 token，清單早就帶著它讀到了，狀態查詢把旗標翻成已登入不算登入、
  // 不多打一次 GitHub。已登入 → 未登入（登出、token 失效）區內回到 Connect GitHub，不打 GitHub；還在飛的讀作廢
  // （帶著舊 token 的結果不該在登出後出現）
  const wasAuthenticated = useRef(isAuthenticated);
  useEffect(() => {
    if (wasAuthenticated.current === isAuthenticated) return;
    wasAuthenticated.current = isAuthenticated;
    if (isAuthenticated) {
      if (latest.current.state.kind === "signed-out") void fetchPRs(`signin#${++fetchSeq.current}`);
      return;
    }
    requestId.current++;
    // 展開的那筆的檔也作廢：登出後不留別人 repo 的 diff 在記憶體裡（Gemini G2-5；畫不出來，所以沒有紅測試）
    diffRequestId.current++;
    setDiff({ kind: "loading" });
    setOpen(null);
    setState((s) => (s.kind === "not-github" ? s : { kind: "signed-out" }));
  }, [isAuthenticated, fetchPRs]);

  const retryList = async () => {
    pane()?.focus();
    await fetchAgain();
    setListRetried((n) => n + 1);
  };
  useEffect(() => {
    if (listRetried === 0) return;
    const p = pane();
    const k = latest.current.state.kind;
    if ((k === "rate" || k === "error") && p !== null && document.activeElement === p) {
      p.querySelector<HTMLElement>("#prs-retry")?.focus();
    }
  }, [listRetried]);

  const fetchDiff = useCallback(
    async (n: number) => {
      const myId = ++diffRequestId.current;
      setDiff({ kind: "loading" });
      try {
        const d = await githubGetPRDiff(repoId, n);
        if (diffRequestId.current !== myId) return;
        setDiff({ kind: "ok", diff: d });
      } catch (err) {
        if (diffRequestId.current !== myId) return;
        const code = errorCode(err);
        if (code === "PR_DIFF_TOO_LARGE") {
          setDiff({ kind: "large" });
          return;
        }
        console.error("[kira] getPRDiff failed:", code || "unknown");
        setDiff({ kind: "error" });
      }
    },
    [repoId],
  );
  const toggle = (n: number) => {
    if (open === n) {
      setOpen(null);
      diffRequestId.current++;
      return;
    }
    setOpen(n);
    void fetchDiff(n);
  };
  const retryDiff = async () => {
    const n = open;
    if (n === null) return;
    rowOf(n)?.focus();
    await fetchDiff(n);
    setDiffRetried((x) => x + 1);
  };
  useEffect(() => {
    if (diffRetried === 0) return;
    const { open: n, diff: d } = latest.current;
    if (d.kind === "error" && n !== null && document.activeElement === rowOf(n)) {
      listRef.current?.querySelector<HTMLElement>("#pr-diff-retry")?.focus();
    }
  }, [diffRetried]);

  // an open pull request's files, every one of them (github_get_pr_diff); it is not a local commit, so a file the
  // display limit kept back says so without a command
  const body = (d: DiffState) => {
    switch (d.kind) {
      case "loading":
        return (
          <div className="skeleton" aria-label="Loading files">
            <i style={{ width: "46%" }} />
            <i style={{ width: "84%" }} />
            <i style={{ width: "70%" }} />
          </div>
        );
      case "error":
        return (
          <p className="empty-line" role="alert">
            <b>Couldn&apos;t load the files.</b>{" "}
            <button className="text-btn" type="button" id="pr-diff-retry" onClick={() => void retryDiff()}>
              Retry
            </button>
          </p>
        );
      case "large":
        return <Strip title="Too large to show here." detail="Read this pull request on GitHub." />;
      case "ok":
        return d.diff.files.length === 0 ? (
          <p className="empty-line">No file changes</p>
        ) : (
          <>
            <LimitStrips files={d.diff.files} cut={d.diff.truncated} whole="pull request" />
            {d.diff.files.map((f, i) => (
              <FileDiff key={i} file={f} at={null} />
            ))}
          </>
        );
    }
  };

  const listShown = state.kind === "ok" || state.kind === "loading";
  const alert = state.kind === "rate" || state.kind === "error";
  return (
    <>
      <ul
        className="prs"
        id="prs"
        ref={listRef}
        hidden={!listShown}
        aria-label={state.kind === "loading" ? "Loading pull requests" : undefined}
      >
        {state.kind === "loading" &&
          SK_PR.map(([a, b], i) => (
            <li key={i} className="sk sk-pr" aria-hidden="true">
              <i style={{ width: `${a}%` }} />
              <i style={{ width: `${b}%` }} />
            </li>
          ))}
        {state.kind === "ok" &&
          state.prs.map((pr) => {
            const isOpen = open === pr.number;
            // the line it runs on is read off the map, so none until git_get_graph answers (Phase 5 Q-L)
            const via = routes ? viaLook(routes, pr.head_sha) : null;
            return (
              <li key={pr.number} className={isOpen ? "pr open" : "pr"}>
                <button
                  type="button"
                  className="pr-row"
                  data-pr={pr.number}
                  aria-expanded={isOpen}
                  onClick={() => toggle(pr.number)}
                >
                  <svg className="chev" aria-hidden="true">
                    <use href="#i-chev" />
                  </svg>
                  <span>
                    <span className="pr-title">
                      {pr.title}
                      {pr.draft && <span className="draft">Draft</span>}
                    </span>
                    <span className="pr-meta">
                      <span className="num">#{pr.number}</span>
                      <span>
                        by {pr.author} · {timeAgo(pr.updated_at)}
                      </span>
                      {via && (
                        <span className="via">
                          <Roundel {...via.look} />
                          {via.name}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="pr-status">
                    <StatusIcon state={pr.review_state} />
                    <StatusIcon state={pr.check_status} />
                  </span>
                </button>
                {isOpen && <div className="pr-body">{body(diff)}</div>}
              </li>
            );
          })}
      </ul>
      <div className="pane-empty" id="prs-state" hidden={listShown} role={alert ? "alert" : undefined}>
        {state.kind === "not-github" && (
          <>
            <PrPicture />
            <p>No GitHub remote</p>
            <p className="hint">Pull requests come from origin on github.com.</p>
          </>
        )}
        {state.kind === "signed-out" && (
          <>
            <PrPicture />
            <p>Connect GitHub to see pull requests</p>
            <button
              className="btn"
              type="button"
              id="prs-connect"
              disabled={connecting}
              onClick={() => void connectGitHub(() => document.getElementById("prs-connect"))}
            >
              {connecting ? "Connecting…" : "Connect GitHub"}
            </button>
          </>
        )}
        {state.kind === "empty" && (
          <>
            <PrPicture />
            <p>No open pull requests</p>
          </>
        )}
        {state.kind === "rate" && (
          <ReadFailed what="GitHub's rate limit is used up." hint={state.hint} onRetry={() => void retryList()} />
        )}
        {state.kind === "error" && (
          <ReadFailed
            what="Couldn't load pull requests."
            hint="Check your network, then try again."
            onRetry={() => void retryList()}
          />
        )}
      </div>
    </>
  );
}
