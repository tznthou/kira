#!/bin/bash
# 建 v8 複刻的實機 fixture repo（可重現：每次砍掉重建）
#   Kira 開源前的真實歷史（至 dd9ba36）+ 三條合成分支（含視窗外的 feat/t9d-watcher）+ tag + 本機 bare origin + 工作區改動
#   → ~/Documents/kira-smoke/v8-fixture（origin: v8-fixture-origin.git）
# 對應基準 mockup/v8-kirazuri-lines-sys.html 與 src/dev/fidelity/fixture.ts 的 demo 資料。
# 來源要有開源前的歷史（公開 repo 從一個初始 commit 開始，沒有 dd9ba36）：KIRA_HISTORY 指向那份 clone，
# 預設 ~/Documents/kira-app。來源不對就在刪掉既有 fixture 之前停下。
set -euo pipefail

SRC="${KIRA_HISTORY:-$HOME/Documents/kira-app}"
BASE=dd9ba36
DEST="$HOME/Documents/kira-smoke/v8-fixture"
ORIGIN="$HOME/Documents/kira-smoke/v8-fixture-origin.git"

# 下面只 clone main 再退回 BASE，所以 BASE 必須在來源的 main 上；任何非 0（含來源不存在的 128）都拒絕
if ! git -C "$SRC" merge-base --is-ancestor "$BASE" main 2>/dev/null; then
  echo "$SRC has no $BASE on main: set KIRA_HISTORY to a clone with the pre-open-source history" >&2
  exit 1
fi

rm -rf "$DEST" "$ORIGIN"
git clone --quiet --no-local --single-branch --branch main --no-tags "$SRC" "$DEST"
cd "$DEST"
git reset --quiet --hard "$BASE"
git remote remove origin
git config user.name "tznthou"
git config user.email "tznthou@users.noreply.github.com"

# 基準顯示的是改寫過的訊息（歷史裡有兩筆 subject 帶著內部工具的名字）；用樣式比對、不寫出那個名字，
# dd9ba36 之前符合的正好就是那兩筆。改寫的 commit 與其後代 hash 都會變，D5 允許資料差異
export FILTER_BRANCH_SQUELCH_WARNING=1
git filter-branch -f --msg-filter \
  'sed -E "1s/^chore: [a-z]+ pipeline — ([0-9]+) findings applied\$/chore: apply review findings — \1 items/"' \
  -- main >/dev/null 2>&1
rm -rf .git/refs/original
git reflog expire --expire=now --all
# here-string 而非 pipe：pipefail 下 grep -q 提早結束會讓上游吃 SIGPIPE、判斷翻轉
if grep -qE "^chore: [a-z]+ pipeline — [0-9]+ findings applied$" <<< "$(git log --format=%s main)"; then
  echo "rewrite failed" >&2; exit 1
fi

# awk 讀完全部輸入（不提早 exit），上游 git log 才不會在 pipefail 下吃 SIGPIPE
by_subject() { git log --format='%H %s' main | awk -v s="$1" '!found {h=$1; $1=""; sub(/^ /,""); if ($0==s) {print h; found=1}}'; }
at() { GIT_AUTHOR_DATE="$1 +0800" GIT_COMMITTER_DATE="$1 +0800" git commit --quiet -m "$2"; }

MERGE36=$(by_subject "Merge pull request #36 from tznthou/feat/t15f-motion")
T15F_TIP=$(by_subject "docs: correct outdated stack and animation claims after t15f")
T15E_TIP=$(by_subject "chore: apply review findings — 10 items")
[ -n "$MERGE36" ] && [ -n "$T15F_TIP" ] && [ -n "$T15E_TIP" ] || { echo "anchor commits not found" >&2; exit 1; }

git tag v0.1.0-rc.1 main

# ---- feat/t15g-graph-density（3 筆，HEAD）----
git checkout --quiet -b feat/t15g-graph-density main
mkdir -p src/tests/fixtures
printf '{ "commits": [] }\n' > src/tests/fixtures/react-17-lanes.json
git add src/tests/fixtures/react-17-lanes.json
at "2026-10-02 21:10" "test(graph): add a 17-lane density fixture from react history"
T15G_FIRST=$(git rev-parse HEAD)
python3 - <<'PY'
from pathlib import Path
p = Path("src/lib/graphLayout.ts")
s = p.read_text()
p.write_text(s.replace('const MAX_PARENTS_PER_COMMIT = 64;',
                       'const MAX_PARENTS_PER_COMMIT = 64;\n/** lane 區寬度預算，見 constants.ts */\nexport const CELL_WIDTH = 24;', 1))
PY
git add src/lib/graphLayout.ts
at "2026-10-02 22:41" "refactor(graph): extract the lane-width budget into layout constants"
# 與基準 c9e41f2 的 diff 相同：在 SUBJECT_TEXT_WIDTH 之後插入四行
python3 - <<'PY'
from pathlib import Path
p = Path("src/components/CommitGraph/constants.ts")
s = p.read_text()
anchor = "export const SUBJECT_TEXT_WIDTH = 320;\n\n"
add = ("/** lane 區最多吃容器寬度的比例；超過就壓縮 lane 間距，\n"
       " *  訊息欄寬度維持 SUBJECT_TEXT_WIDTH 不被擠掉。 */\n"
       "export const LANE_GUTTER_MAX_RATIO = 0.38;\n\n")
assert s.count(anchor) == 1
p.write_text(s.replace(anchor, anchor + add, 1))
PY
git add src/components/CommitGraph/constants.ts
at "2026-10-03 14:22" "feat(t15g): scale lane gutter to container width before the subject column"

# ---- fix/toolbar-jump（1 筆，從 merge #36 分出）----
git checkout --quiet -b fix/toolbar-jump "$MERGE36"
python3 - <<'PY'
from pathlib import Path
p = Path("src/App.tsx")
s = p.read_text()
old = 'className="px-3 py-1 text-sm bg-surface-2 hover:bg-surface-3 disabled:bg-surface-1 disabled:cursor-not-allowed rounded"\n          >\n            {refreshing'
assert s.count(old) == 1, "App.tsx anchor"
p.write_text(s.replace(old, old.replace('className="px-3', 'className="min-w-[6.75rem] px-3'), 1))
PY
git add src/App.tsx
at "2026-10-03 11:05" "fix(toolbar): give Refresh a fixed min-width so the toolbar stops shifting"

# ---- feat/t9d-watcher（Phase 5 5a）：視窗外的分支，本機 ↑1、origin ↓2 ----
# 從 T9d 開工時的 main（#23 的 merge，05-29）分出；三筆都在 05-30 ~ 31，早於語意比對視窗的第 23 筆
# （06-08），revwalk 的前 23 筆因此不變。origin 那兩筆先放在暫存分支，推上去後刪掉
T9D_BASE=$(by_subject "Merge pull request #23 from tznthou/feat/t12c-pr-diff-ui")
[ -n "$T9D_BASE" ] || { echo "t9d base not found" >&2; exit 1; }
git checkout --quiet -b t9d-on-origin "$T9D_BASE"
mkdir -p src-tauri/src
printf '//! Watches .git for changes made outside Kira.\n' > src-tauri/src/watcher.rs
git add src-tauri/src/watcher.rs
at "2026-05-30 21:40" "feat(t9d): watch .git selectively, skipping objects"
printf '\n// debounce: 400ms\n' >> src-tauri/src/watcher.rs
git add src-tauri/src/watcher.rs
at "2026-05-31 14:05" "feat(t9d): debounce watcher events by 400ms"
git checkout --quiet -b feat/t9d-watcher "$T9D_BASE"
printf '# T9d notes\n' > docs/t9d-notes.md
git add docs/t9d-notes.md
at "2026-05-31 10:12" "docs(t9d): note the watcher's refresh paths"

# ---- origin：本機 bare repo；origin/feat/t15g 落後本機 2 筆 ----
git init --quiet --bare "$ORIGIN"
git remote add origin "$ORIGIN"
git push --quiet origin main fix/toolbar-jump
git push --quiet origin "$T15G_FIRST:refs/heads/feat/t15g-graph-density"
git push --quiet origin "$T15F_TIP:refs/heads/feat/t15f-motion"
git push --quiet origin "$T15E_TIP:refs/heads/feat/t15e-graph-layout"
git push --quiet origin "t9d-on-origin:refs/heads/feat/t9d-watcher"
git branch --quiet -D t9d-on-origin
git fetch --quiet origin
git branch --quiet --set-upstream-to=origin/main main
git branch --quiet --set-upstream-to=origin/feat/t15g-graph-density feat/t15g-graph-density
git branch --quiet --set-upstream-to=origin/fix/toolbar-jump fix/toolbar-jump
git branch --quiet --set-upstream-to=origin/feat/t9d-watcher feat/t9d-watcher
# 一般 clone 都有 origin/HEAD：語意比對要看真後端會不會把它列進分支清單
git remote set-head origin main

# ---- 工作區：staged 2、unstaged 2 + 新檔 1 ----
git checkout --quiet feat/t15g-graph-density
printf '\n// v8 fixture: staged edit\n' >> src/components/CommitGraph/GraphCanvas.tsx
printf '\n// v8 fixture: staged edit\n' >> src/lib/graphLayout.ts
git add src/components/CommitGraph/GraphCanvas.tsx src/lib/graphLayout.ts
printf '\n<!-- v8 fixture: unstaged edit -->\n' >> docs/PLAN.md
printf '\n// v8 fixture: unstaged edit\n' >> src/components/CommitGraph/CommitNode.tsx
printf 'import { describe, it } from "vitest";\n\ndescribe("lane gutter", () => { it.todo("fits 17 lanes"); });\n' > src/tests/laneGutter.test.ts

echo "fixture ready: $DEST"
git log --oneline --graph --all -8
git status --short
