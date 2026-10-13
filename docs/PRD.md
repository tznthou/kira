# PRD.md — Kira

> 版本：v1.0 MVP｜更新日期：2026-05

---

## 目標使用者

| 角色 | 需求 | 痛點 | 期望效益 |
|------|------|------|---------|
| **終端機開發者**（主力） | 從 IDE extension 切換到終端機工作流後，失去視覺化 Git 狀態的工具 | VS Code GitLens 好用但不夠美，Sourcetree 功能多但 UI 過時 | 一個美觀、開在旁邊就賞心悅目的 Git 狀態觀測工具 |
| **視覺型學習者** | 需要「看到」branch 關係才能理解 Git 操作的邏輯 | CLI 輸出太抽象，GUI 工具的 graph 難以解讀 | 一眼就懂自己在哪個 branch、history 怎麼走 |
| **設計師 / PM** | 需要查看 PR 狀態和 commit history，但不熟悉 Git 操作 | GitHub 網頁功能夠但開啟成本高，IDE 工具對非開發者不友善 | 低門檻進入，直接看到想看的資訊 |

---

## 使用者故事

### US-01：開啟 Repo

```
作為終端機開發者，
我想要快速開啟本地 repo 或 clone 遠端 repo，
以便立刻進入工作狀態。

驗收條件：
- Given 使用者開啟 Kira
- When 點擊「Open Repo」選取本地目錄
- Then Commit Graph 在 2 秒內載入並顯示

- Given 使用者貼上 GitHub URL
- When 點擊「Clone」
- Then 顯示進度動畫，clone 完成後自動開啟 Graph 視圖
```

### US-02：理解 Repo 狀態（核心）

```
作為視覺型學習者，
我想要透過動態 Commit Graph 一眼看懂 branch 結構，
以便知道現在在哪、誰改了什麼、history 怎麼走。

驗收條件：
- Given 開啟一個有多個 branch 的 repo
- When Graph 渲染完成
- Then 每個 branch 有獨立顏色，commit 節點沿時間軸由上到下排列，
        branch 分叉和 merge 以流線清晰呈現

- Given 使用者 hover 一個 commit 節點
- When 停留超過 300ms
- Then 展開顯示 commit message、作者、時間、changed files 數量

- Given 使用者點擊一個 commit 節點
- When 點擊
- Then Diff Viewer 面板開啟，顯示該 commit 的差異
```

### US-03：Stage 與 Commit

```
作為終端機開發者，
我想要視覺化地 stage 檔案並 commit，
以便不需要記憶 git add / git commit 語法。

驗收條件：
- Given 工作目錄有未追蹤或已修改的檔案
- When 使用者開啟 Staging Area 面板
- Then 清楚區分「Unstaged」與「Staged」兩個區塊，
        並列出檔案名稱與變更類型（Modified / New / Deleted）

- Given 使用者點擊檔案旁的「+」
- When 操作完成
- Then 檔案移入 Staged 區塊，Graph 即時更新 working tree 狀態

- Given Staged 區塊有檔案
- When 使用者輸入 commit message 並點擊「Commit」
- Then 建立 commit，Graph 新增節點，Staging Area 清空
```

### US-04：Push / Pull

```
作為終端機開發者，
我想要一鍵 push / pull，
以便保持本地與遠端同步。

驗收條件：
- Given 當前 branch 有 unpushed commits
- When 點擊 Push 按鈕
- Then 顯示進度動畫，成功後 Graph 更新 remote branch 指示器位置

- Given 遠端有新 commits
- When 點擊 Pull 按鈕
- Then fetch + merge，Graph 動態呈現新節點加入
```

### US-05：查看 GitHub PR

```
作為設計師 / PM，
我想要在 Kira 裡直接查看 PR 狀態，
以便不需要切換到瀏覽器。

驗收條件：
- Given 使用者完成 GitHub OAuth 登入
- When 切換到 PR 面板
- Then 列出當前 repo 的 open PR，含標題、作者、review 狀態、CI 狀態

- Given 使用者點擊一個 PR
- When 展開
- Then 顯示 PR diff 和 commits 列表，可直接在 Kira 內閱讀變更
```

### US-06：查看 Diff

```
作為終端機開發者，
我想要在清晰的介面中閱讀程式碼差異，
以便快速理解變更內容。

驗收條件：
- Given 使用者點擊 commit 節點或 staged 檔案
- When Diff Viewer 開啟
- Then 以 side-by-side 或 unified 格式顯示，語法高亮，
        新增行綠色、刪除行紅色，符合視覺直覺
```

---

## 功能需求表

| 功能 | 描述 | 優先級 |
|------|------|--------|
| Open / Clone Repo | 開啟本地 repo 或 clone 遠端 | P0 |
| Commit Graph 視覺化 | 動態 branch 流線圖，顏色系統 | P0 |
| Staging Area | Stage / Unstage / Commit 操作 | P0 |
| Push / Pull | 遠端同步基礎操作 | P0 |
| Diff Viewer | Commit 差異顯示，語法高亮 | P0 |
| GitHub PR 列表 | 列出 open PR，顯示狀態 | P1 |
| GitHub OAuth | 登入 / 登出 | P1 |
| PR Diff 閱讀 | 在 Kira 內閱讀 PR 差異 | P1 |
| Branch 建立 / 切換 / 刪除 | 基礎 branch 操作 | P1 |
| Recent Repos | 最近開啟的 repo 清單 | P2 |
| Merge / Rebase UI | 進階合併操作 | 超出 MVP |
| Conflict Resolver | 衝突解決介面 | 超出 MVP |

---

## 非功能需求

| 類別 | 指標 |
|------|------|
| **效能** | Commit Graph 載入 10,000 commits ≤ 2 秒 |
| **效能** | UI 動畫維持 60fps |
| **記憶體** | 正常使用 ≤ 150MB RAM |
| **啟動時間** | 冷啟動 ≤ 1 秒 |
| **相容性** | macOS 12+、Windows 10+、Ubuntu 20.04+ |
| **安全性** | GitHub token 存入系統 keychain，不寫入磁碟明文 |
| **可用性** | 所有核心操作可在不閱讀文件的情況下完成（視覺自說明） |

---

## 驗收標準（MVP）

| 功能 | 通過條件 |
|------|---------|
| Commit Graph | 5,000 commits 的 repo 在 2 秒內渲染完成，branch 顏色不重複 |
| Stage & Commit | 從 Unstaged → Staged → Commit 完整流程無需任何 CLI 指令 |
| Push / Pull | 操作後 Graph 即時更新，無需重新整理 |
| Diff Viewer | 顯示正確的新增 / 刪除行，語法高亮至少支援 10 種語言 |
| PR 列表 | OAuth 登入後 30 秒內列出 open PR |
| 視覺設計 | 在 1080p 螢幕上，非開發者使用者能在 1 分鐘內找到所有 P0 功能入口 |
