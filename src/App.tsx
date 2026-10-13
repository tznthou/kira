import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { GraphPane } from "@/components/Graph/GraphPane";
import { StagingArea } from "@/components/StagingArea/StagingArea";
import { PRPanel } from "@/components/PRPanel/PRPanel";
import { PaneTabs } from "@/components/PaneTabs/PaneTabs";
import { DeviceCodeModal } from "@/components/Auth/DeviceCodeModal";
import { DiffViewer } from "@/components/DiffViewer/DiffViewer";
import { ThemeSwitcher } from "@/components/ThemeSwitcher/ThemeSwitcher";
import { RepoSidebar } from "@/components/RepoSidebar/RepoSidebar";
import { CloneRepoModal } from "@/components/CloneRepo/CloneRepoModal";
import { Topbar } from "@/components/Topbar/Topbar";
import { Toolbar } from "@/components/Topbar/Toolbar";
import { Account } from "@/components/Topbar/Account";
import { useRepoStore } from "@/stores/repoStore";
import { useGraphStore } from "@/stores/graphStore";
import { useRecentReposStore } from "@/stores/recentReposStore";
import { useAuthStore } from "@/stores/authStore";
import { useNoticeStore, SHELL_NOTICES } from "@/stores/noticeStore";
import { computeRoutes } from "@/lib/routeMap";
import { isMacOS } from "@/lib/platform";
import v8Sprite from "@/styles/v8-sprite.svg?raw";
import {
  pickAndOpenRepo,
  openRecentRepo,
  getGraph,
  watchFullscreen,
  type GraphData,
  type RepoOpenResult,
  type ExternalChangeEvent,
} from "@/lib/tauri";

/** HEAD 那個 commit；unborn 或不在載入的視窗內為 null */
const headCommit = (graph: GraphData) => graph.commits.find((c) => c.full_oid === graph.head.oid) ?? null;

function App() {
  const [bootLoading, setBootLoading] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  // 遞增計數器：每次 handleRefresh 成功就 bump，驅動 PRPanel 重抓 GitHub 資料
  const [prRefreshToken, setPrRefreshToken] = useState(0);
  // T11b: clone modal open state. Lifted to App so onOpened funnels
  // through applyOpenResult — the canonical seed point for every
  // repo-opening flow.
  const [cloneModalOpen, setCloneModalOpen] = useState(false);

  const repoId = useRepoStore((s) => s.repoId);
  const graphData = useGraphStore((s) => s.graphData);
  const deviceFlow = useAuthStore((s) => s.deviceFlow);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  // Monotonic counter：連點 recent A → B 時 A 慢回覆的 getGraph 不能覆蓋 B 的
  // graphData（Codex 審查發現：repo state 與 graph data 的競態窗口）。
  const openRequestIdRef = useRef(0);

  // Boot: kick off recent_repos refresh once on mount。store 有 monotonic
  // requestId guard，後續 refresh (例如 open success 後) settle 順序自洽。
  useEffect(() => {
    void useRecentReposStore.getState().refresh();
  }, []);

  // 共用 open success path：pickAndOpen 與 openRecent 兩個入口都 funnel 進來，
  // 確保 store reset / graph load / aheadBehind / recent mirror refresh 對齊。
  const applyOpenResult = useCallback(async (result: RepoOpenResult) => {
    const myRequestId = ++openRequestIdRef.current;
    const { repo_id, info } = result;

    // 開 / 切 repo 是使用者發起的操作：清掉前一個 repo 的提示（clone 成功也走這裡）
    useNoticeStore.getState().clear();
    useGraphStore.getState().actions.setSelectedCommit(null);
    useGraphStore.getState().actions.setError(null);
    useGraphStore.getState().actions.setGraphData(null);
    useRepoStore.getState().setWorkingTreeStatus(null);
    useRepoStore.getState().clearPushPull();
    // Clear stale ahead/behind from previous repo before any consumer reads
    // it under the new repoId; bumping requestId also invalidates in-flight refreshes.
    useRepoStore.setState((s) => ({
      aheadBehind: null,
      aheadBehindRequestId: s.aheadBehindRequestId + 1,
      // 上一個 repo 的 status 讀還在跑：兩個序號都 bump，讓它回來時不寫入（同一個路徑重開拿回同一個 repoId，
      // 只比 repoId 不夠；清空的畫面算這一次寫入的）
      statusError: false,
      statusRequestId: s.statusRequestId + 1,
      statusWrittenId: s.statusRequestId + 1,
      statusUserPendingId: null,
      // Clear T10 branch state from prior repo before the new repo's first
      // refreshBranches lands; epoch bump invalidates any in-flight settle.
      branches: null,
      detachedHeadOid: null,
      branchesError: false,
      branchStats: {},
      branchOpRequestId: s.branchOpRequestId + 1,
      // 上一個 repo 的分支操作還在跑：上面的 bump 讓它不再是最新的那次，它結束時不清 refreshing——在這裡清，
      // 否則新 repo 的工具列與分支列一直「Disabled while refreshing」，watcher 也一直跳過
      refreshing: false,
      refreshSource: null,
    }));

    useRepoStore.getState().setRepoId(repo_id);
    useRepoStore.getState().setRepoInfo(info);
    useGraphStore.getState().actions.setRepoId(repo_id);

    // working tree 的讀跟 graph 並行、不等它：大 repo 的 status 要數百 ms，不能擋住 graph 與選 HEAD
    // （Changes 在它回來前畫骨架）。開 repo 是使用者操作：讀不到就說讀不到
    void useRepoStore.getState().refreshStatus({ source: "user" });
    const [graph] = await Promise.all([
      getGraph(repo_id),
      useRepoStore.getState().refreshAheadBehind(),
      useRepoStore.getState().refreshBranches(),
    ]);
    // 若已有更新的 open 啟動 → 丟棄這次回傳，避免 A 慢回覆覆寫 B 的 graphData
    if (openRequestIdRef.current !== myRequestId) return;
    // 開 repo 選 HEAD（不在視窗內或 unborn 就不選），跟這份 graph 一起寫入
    useGraphStore.getState().actions.adoptGraph(graph, headCommit(graph));

    // Backend 在 open 成功時內部已寫 recent，frontend mirror 立即拉一次跟上。
    void useRecentReposStore.getState().refresh();
  }, []);

  // 開 repo 失敗：已開著 repo 時進站牌的提示；首頁沒有站牌，維持首頁自己的錯誤顯示（Phase 6 再設計）
  const reportOpenFailure = useCallback((recent: boolean) => {
    if (useRepoStore.getState().repoId) {
      useNoticeStore.getState().show(recent ? SHELL_NOTICES.openRecent : SHELL_NOTICES.open);
    } else {
      setBootError(
        recent
          ? "Failed to open repository. It may have been moved or deleted."
          : "Failed to open repository",
      );
    }
  }, []);

  const handleOpenRepo = useCallback(async () => {
    useNoticeStore.getState().clear();
    setBootError(null);
    setBootLoading(true);
    try {
      const result = await pickAndOpenRepo();
      if (result === null) return;
      await applyOpenResult(result);
    } catch (err) {
      console.error("[kira] open repo failed:", err);
      reportOpenFailure(false);
    } finally {
      setBootLoading(false);
    }
  }, [applyOpenResult, reportOpenFailure]);

  const handleOpenRecent = useCallback(
    async (path: string) => {
      useNoticeStore.getState().clear();
      setBootError(null);
      setBootLoading(true);
      try {
        const result = await openRecentRepo(path);
        await applyOpenResult(result);
      } catch (err) {
        console.error("[kira] open recent repo failed:", err);
        reportOpenFailure(true);
        // 同步 frontend mirror — backend 下次 load 會 stale-prune（NotFound）
        void useRecentReposStore.getState().refresh();
      } finally {
        setBootLoading(false);
      }
    },
    [applyOpenResult, reportOpenFailure]
  );

  // commit / push / pull 成功後重載 graph。失敗時提示分兩種：commit 後要說「commit 已存」，
  // push / pull 之後只寫結論（那時沒有新 commit 可講）
  const reloadGraph = useCallback(async (after: "commit" | "transport") => {
    const repoIdNow = useRepoStore.getState().repoId;
    if (!repoIdNow) return;
    try {
      const [graph, , infoRead] = await Promise.all([
        getGraph(repoIdNow),
        useRepoStore.getState().refreshAheadBehind(),
        // 空 repo 的第一筆 commit 讓 HEAD 從 unborn 變成有分支：repoInfo.head_branch 要重讀，
        // 否則工具列寫「Detached HEAD」直到 watcher 觸發的 refresh
        after === "commit" ? useRepoStore.getState().refreshRepoInfo() : true,
      ]);
      if (useRepoStore.getState().repoId !== repoIdNow) return;
      // repo 資訊讀不到（repoInfo 已 fail closed、推拉停用）：算這次重載失敗，提示 commit 還在，
      // 也不套新的 graph——提示說重載失敗，畫面就不能已經是新的
      if (!infoRead) {
        useNoticeStore.getState().show(SHELL_NOTICES.reloadAfterCommit);
        return;
      }
      // commit 後選剛 commit 的那站（新的 HEAD），跟這份 graph 一起寫入；push / pull 之後選取不動
      if (after === "commit") useGraphStore.getState().actions.adoptGraph(graph, headCommit(graph));
      else useGraphStore.getState().actions.setGraphData(graph);
    } catch (err) {
      console.error(`[kira] reload graph failed after ${after}:`, err);
      if (useRepoStore.getState().repoId !== repoIdNow) return;
      useNoticeStore
        .getState()
        .show(after === "commit" ? SHELL_NOTICES.reloadAfterCommit : SHELL_NOTICES.reloadAfterTransport);
    }
  }, []);
  const handleCommitDone = useCallback(() => reloadGraph("commit"), [reloadGraph]);
  const handleTransportDone = useCallback(() => void reloadGraph("transport"), [reloadGraph]);

  // refreshPRs 只給使用者主動觸發的路徑（工具列 Refresh）。watcher 的
  // external-change 事件不帶它 —— 否則在 terminal 跑任何 git 指令都會打一輪
  // GitHub API（1 次 list + 每個 PR 2 次 enrichment，10 個 PR 就是 21 個
  // request），而 PRPanel 是用 CSS hidden 藏著、沒 unmount，使用者連 PR 分頁
  // 都沒開也照燒 quota，還會把列表閃回 Skeleton。
  //
  // 提示不在這裡清：watcher / focus 觸發的背景 refresh 也走這裡，而 pull 回 CONFLICT 時 fetch
  // 已更新追蹤 ref → watcher 隨即觸發 refresh，在這裡清會把「Can't fast-forward」約 400ms 就清掉。
  // 使用者按 Refresh 時由按鈕自己清（handleRefreshClick）。
  //
  // source：分支清單（Phase 5 Q-B）與 working tree（Q-S）讀不到時怎麼辦——使用者按的才清掉清單、說讀不到；
  // watcher 的背景 refresh 留著舊清單（預設）
  const handleRefresh = useCallback(async (opts?: { refreshPRs?: boolean; source?: "user" | "background" }) => {
    const repoIdNow = useRepoStore.getState().repoId;
    if (!repoIdNow) return;
    // store-level flag → 工具列讀得到，避免跨 refresh settle 視角不一致。
    // 旗標歸開始時的操作代號：之後換了 repo（applyOpenResult 已清旗標）或分支操作接手（它結束時自己清），
    // 這次結束就不碰——否則舊 repo 的 refresh 晚到，會清掉新 repo 正在用的旗標。只比 repoId 不夠：
    // 同一個路徑重開拿回同一個 repoId
    const owner = useRepoStore.getState().branchOpRequestId;
    const source = opts?.source ?? "background";
    // 來源也記進 store：Changes 的 Commit 與全部 stage 只被使用者發起的忙碌擋住，watcher 的背景 refresh 不擋
    useRepoStore.getState().setRefreshing(true, source);
    try {
      const [graph] = await Promise.all([
        getGraph(repoIdNow),
        useRepoStore.getState().refreshStatus({ source }),
        useRepoStore.getState().refreshAheadBehind(),
        useRepoStore.getState().refreshRepoInfo(),
        useRepoStore.getState().refreshBranches({ source }),
      ]);
      if (useRepoStore.getState().repoId !== repoIdNow) return;
      useGraphStore.getState().actions.setGraphData(graph);
      // PR 面板走 GitHub API，不在上面那批 store refresh 裡
      if (opts?.refreshPRs) {
        setPrRefreshToken((n) => n + 1);
      }

      const freshBranches = useRepoStore.getState().branches;
      if (freshBranches) {
        const localNames = freshBranches
          .filter((b) => !b.is_remote)
          .map((b) => b.name);
        if (localNames.length > 0) {
          useRepoStore.setState({ branchStats: {} });
          await useRepoStore.getState().refreshBranchStats(localNames);
        }
      }
    } catch (err) {
      console.error("[kira] refresh failed:", err);
      if (useRepoStore.getState().repoId !== repoIdNow) return;
      // 使用者與背景觸發的都提示（同一句）
      useNoticeStore.getState().show(SHELL_NOTICES.refresh);
    } finally {
      if (useRepoStore.getState().branchOpRequestId === owner) useRepoStore.getState().setRefreshing(false);
    }
  }, []);
  const handleRefreshClick = useCallback(() => {
    useNoticeStore.getState().clear();
    void handleRefresh({ refreshPRs: true, source: "user" });
  }, [handleRefresh]);

  // T9d：監聽 backend watcher 的 repo:external-change（外部 git 操作改動 .git/）。
  // 依 repo_id filter 當前 active repo（對齊 git-progress pattern），觸發既有全刷。
  // repoId 變（切 repo）時 cleanup 舊 listener 重掛新的。
  useEffect(() => {
    if (!repoId) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    listen<ExternalChangeEvent>("repo:external-change", (event) => {
      if (event.payload.repo_id !== repoId) return;
      // 已有 refresh 進行中 → 丟棄這次，避免並發 handleRefresh 造成 graph/status/repoInfo
      // out-of-order 覆蓋（這些 slice 無 epoch guard）。git status/graph 讀當下狀態，累積
      // 變更會在下次 event / focus 補刷時反映，不會永久 stale（並發審查發現）。
      if (useRepoStore.getState().refreshing) return;
      void handleRefresh();
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => {
        console.error("[kira] failed to listen repo:external-change:", err);
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [repoId, handleRefresh]);

  // T9d：視窗 regains focus 時補刷 working tree status — 補上「外部編輯器改檔但沒跑
  // git 命令」的盲點（.git/ watcher 偵測不到純 working tree 編輯）。500ms throttle
  // 防 alt-tab 連發；refreshStatus 自帶 repoId guard。背景重讀：讀不到就留著舊清單（Q-S）
  useEffect(() => {
    if (!repoId) return;
    let lastRefresh = 0;
    const onFocus = () => {
      const now = Date.now();
      if (now - lastRefresh < 500) return;
      lastRefresh = now;
      void useRepoStore.getState().refreshStatus({ source: "background" });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [repoId]);

  // 路線圖：站牌的「你在這裡」與強調色都從這一份來。算不出來只影響這兩處，不值得讓整個 App 掛掉
  const routes = useMemo(() => {
    if (!graphData) return null;
    try {
      return computeRoutes(graphData);
    } catch (err) {
      console.error("[kira] route map failed:", err);
      return null;
    }
  }, [graphData]);

  // v8 強調色跟著你所在的路線（路線規則 §6.1）：寫到 html[data-line]，v8.css 的 --line 系列跟著換。
  // 開 repo / checkout / refresh 都會換 graphData；換 repo 時 graphData 先清空再載入，載入空檔
  // 沿用前一條線，不閃回主幹。沒開 repo 是主幹（index.html 的初始值，首繪就對）；路線算不出來也是。
  const accent = !graphData ? null : (routes?.accent ?? "trunk");
  useEffect(() => {
    if (!repoId) document.documentElement.dataset.line = "trunk";
    else if (accent) document.documentElement.dataset.line = accent;
  }, [repoId, accent]);

  // macOS 全螢幕時紅綠燈消失，站牌把讓出的位置收回（html[data-chrome]：on / full）。非 macOS 沒有
  // 紅綠燈，index.html 首繪前就寫好 full，這裡完全不碰（失敗時退回 on 會把它蓋掉）
  useEffect(() => {
    if (!isMacOS()) return;
    return watchFullscreen((full) => {
      document.documentElement.dataset.chrome = full ? "full" : "on";
    });
  }, []);

  // Clone modal 在 App root render — landing / panel 兩 mode 共用同一 modal
  // 實例（root fragment 的同一個位置，切 mode 不會 remount），避免 mode 切換時
  // modal state 丟失 + 對齊 T13b panel mode Clone button 的後續 wire-up。
  //
  // onOpened wraps applyOpenResult to also flip cloneModalOpen=false. Without
  // this the modal stays open after success (Codex review finding #1): stuck in
  // `opening` with Close disabled, no escape path. Closing it is also what
  // resets useCloneFlow (its open=false effect), since the instance survives
  // the landing → panel switch.
  const handleCloneOpened = useCallback(
    async (result: RepoOpenResult) => {
      await applyOpenResult(result);
      setCloneModalOpen(false);
    },
    [applyOpenResult],
  );
  const cloneModalNode = (
    <CloneRepoModal
      open={cloneModalOpen}
      onClose={() => setCloneModalOpen(false)}
      onOpened={handleCloneOpened}
    />
  );

  // 立即 render landing — recent list 走後台 load，避免 stale network mount /
  // 外接碟 unmount 等讓 canonicalize 卡住整個 boot UI。
  // refresh 完成前 recent 為空，自然 fallback 到 "no recent" landing 樣式；
  // refresh 完成後 list 補上。Open / Clone 始終可用。
  const view = !repoId ? (
    <RepoSidebar
      mode="landing"
      onPickAndOpen={() => void handleOpenRepo()}
      onOpenRecent={(path) => void handleOpenRecent(path)}
      onClickClone={() => setCloneModalOpen(true)}
      busy={bootLoading}
      error={bootError}
    />
  ) : (
    // v8 殼層：雲母地上的 grid，四張 sheet 包住還沒移植的舊元件（各區移植時換掉內容）
    <div className="app">
      <Topbar routes={routes} head={graphData?.head ?? null}>
        <Toolbar
          repoId={repoId}
          unborn={graphData?.head.oid === null && graphData.head.branch !== null}
          onRefresh={handleRefreshClick}
          onTransportDone={handleTransportDone}
        />
        <span className="vr" aria-hidden="true" />
        <ThemeSwitcher />
        <Account />
        <button className="btn ghost" type="button" onClick={() => void handleOpenRepo()} disabled={bootLoading}>
          Switch repo
        </button>
      </Topbar>

      <aside className="sheet sidebar" aria-label="Repositories and branches">
        <RepoSidebar
          mode="panel"
          onPickAndOpen={() => void handleOpenRepo()}
          onOpenRecent={(path) => void handleOpenRecent(path)}
          onClickClone={() => setCloneModalOpen(true)}
          busy={bootLoading}
          routes={routes}
          head={graphData?.head ?? null}
        />
      </aside>

      <section className="sheet graph-pane" aria-label="Commit graph">
        <GraphPane graph={graphData} routes={routes} repoId={repoId} />
      </section>

      <section className="sheet side-pane">
        <PaneTabs
          changes={<StagingArea repoId={repoId} onCommitSuccess={handleCommitDone} />}
          prs={<PRPanel repoId={repoId} refreshToken={prRefreshToken} routes={routes} />}
        />
      </section>

      {/* 名字在裡面的 #diff 上：Retry 之後焦點停在那裡（Q-F） */}
      <section className="sheet diff-pane">
        <DiffViewer repoId={repoId} unborn={graphData?.head.oid === null && graphData.head.branch !== null} />
      </section>
    </div>
  );

  // 雲母地在 root：首頁與開 repo 後都坐在它上面（.ground 是 fixed、z-index 0，
  // 上面的內容要自己疊到 z-index 1）。圖示 sprite 也在 root 注入一次（同基準，在 .app
  // 前面；放進 .app 會佔掉 grid 的一格），各處用 <use href="#..."> 取用。原字串注入、
  // 不轉 JSX：kebab-case 屬性會讓 React 警告
  return (
    <>
      <div className="ground" aria-hidden="true">
        <div className="flecks" />
      </div>
      <div dangerouslySetInnerHTML={{ __html: v8Sprite }} />
      {view}
      {cloneModalNode}
      {/* device code 對話框在 root（同 clone）：放在站牌裡會落在整條拖曳區上，code 與網址選不了字。
          已登入就不畫（舊 LoginButton 的 gate，3b 安全 O1）：開 device flow 的途中開機查詢先回來說已登入時，
          對話框不該出現 */}
      {deviceFlow !== null && !isAuthenticated && <DeviceCodeModal flow={deviceFlow} />}
    </>
  );
}

export default App;
