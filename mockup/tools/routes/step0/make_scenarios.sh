#!/bin/bash
# v8 Phase 2 步驟 0：造出 git2 邊界情境的 throwaway repos。
# 唯讀驗證用，驗完整個 ~/Documents/phase2-step0-smoke/ 刪掉。
# 用法：bash make_scenarios.sh [repos 目錄]
#       cd probe && CARGO_TARGET_DIR=<mockup 以外的目錄> cargo run --offline -- <repos 目錄>
# 2026-10-05 的結果在 results.txt；契約據此修正見 kira/.claude/pi-plans/v8-phase2-route-rules.md §10
set -euo pipefail
# fixture 放 ~/Documents（Finder 看得到），不放進 mockup/
R="${1:-$HOME/Documents/phase2-step0-smoke/repos}"
command rm -rf "$R"
mkdir -p "$R"
cd "$R"
# 隔離使用者的 git 設定（預設分支名、簽章、hooks 都不吃）
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=probe GIT_AUTHOR_EMAIL=probe@example.com
export GIT_COMMITTER_NAME=probe GIT_COMMITTER_EMAIL=probe@example.com

git init -q -b main origin-src
(
  cd origin-src
  echo a > a && git add a && git commit -qm init
  git branch feat/x
  git checkout -q feat/x && echo b > b && git add b && git commit -qm "feat x" && git checkout -q main
  git branch gone-later
)
git clone -q --bare origin-src origin.git

clone() { git clone -q "$R/origin.git" "$1"; }

# s1 一般 clone：有 origin/HEAD、local main 追 origin/main、一條沒有 upstream 的 local
clone s1-clone
git -C s1-clone branch nolink

# s2 remote 名含 /
clone s2-slash-remote
git -C s2-slash-remote remote add team/origin "$R/origin.git"
git -C s2-slash-remote fetch -q team/origin

# s3 tracking ref 沒有對應的 remote 設定：手造一條，再造一個「remote 設定被刪、ref 還在」
clone s3-stale
git -C s3-stale update-ref refs/remotes/gone/feat "$(git -C s3-stale rev-parse origin/main)"
git -C s3-stale remote add old "$R/origin.git"
git -C s3-stale fetch -q old
git -C s3-stale config --remove-section remote.old

# s4 兩個 remote 的 fetch refspec 都寫進 refs/remotes/origin/*
clone s4-ambiguous
git -C s4-ambiguous remote add dup "$R/origin.git"
git -C s4-ambiguous config remote.dup.fetch '+refs/heads/*:refs/remotes/origin/*'

# s5 自訂 refspec：remote 叫 origin，tracking ref 卻在 refs/remotes/upstream/*
clone s5-custom-refspec
git -C s5-custom-refspec config remote.origin.fetch '+refs/heads/*:refs/remotes/upstream/*'
git -C s5-custom-refspec fetch -q origin

# s6 沒有 origin/HEAD：init + remote add + fetch（新版 git 會不會自動建立？），再刪掉
git init -q -b main s6-no-origin-head
git -C s6-no-origin-head remote add origin "$R/origin.git"
git -C s6-no-origin-head fetch -q origin
if git -C s6-no-origin-head symbolic-ref -q refs/remotes/origin/HEAD > /dev/null; then
  echo "note: git $(git --version | cut -d' ' -f3) fetch created refs/remotes/origin/HEAD by itself"
fi
git -C s6-no-origin-head remote set-head origin -d > /dev/null

# s7 origin/HEAD 指向不存在的分支（遠端預設分支改名、舊分支被 prune 後的樣子）
clone s7-dangling-head
git -C s7-dangling-head symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/renamed-away

# s8 upstream 被 prune：用自己的 bare origin，避免影響其他情境
git clone -q --bare origin-src origin-s8.git
git clone -q "$R/origin-s8.git" s8-upstream-pruned
git -C s8-upstream-pruned checkout -q -b gone-later --track origin/gone-later
git -C origin-s8.git branch -D gone-later > /dev/null
git -C s8-upstream-pruned fetch -q --prune

# s9 upstream 是本機分支（branch.<name>.remote = "."）
clone s9-upstream-local
git -C s9-upstream-local branch feat-local
git -C s9-upstream-local branch -q --set-upstream-to=main feat-local

# s10 detached HEAD / s11 unborn
clone s10-detached
git -C s10-detached checkout -q --detach origin/feat/x
git init -q -b main s11-unborn

echo "scenarios ready in $R"
