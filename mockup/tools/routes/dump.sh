#!/bin/bash
# v8 Phase 2 規則原型的輸入：用真後端 (build_graph + list_branches) 傾印各 repo 的 IPC 輸出
# 用法：bash mockup/tools/routes/dump.sh   → mockup/fidelity-out/route-dumps/dump-<name>.json
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(cd "$HERE/../.." && pwd)/fidelity-out/route-dumps"
mkdir -p "$OUT"
cd "$HERE/../../../src-tauri"
# kira 那組要開源前的完整歷史：公開 repo 只有一個初始 commit，拿它傾印語料會悄悄變短。
# 來源同 make_v8_fixture.sh 的 KIRA_HISTORY（預設 ~/Documents/kira-app）
for pair in "kira:${KIRA_HISTORY:-$HOME/Documents/kira-app}" \
            "work:$HOME/Documents/kira-smoke/work" \
            "react:$HOME/Documents/kira-smoke/react" \
            "v8fixture:$HOME/Documents/kira-smoke/v8-fixture"; do
  name=${pair%%:*}
  repo=${pair#*:}
  if [ "$name" = kira ] && ! git -C "$repo" merge-base --is-ancestor dd9ba36 HEAD 2>/dev/null; then
    echo "kira: $repo has no pre-open-source history (dd9ba36): set KIRA_HISTORY" >&2
    exit 1
  fi
  start=$(date +%s)
  KIRA_FIXTURE_REPO="$repo" KIRA_FIXTURE_DUMP="$OUT/dump-$name.json" \
    cargo test --lib fidelity_dump -- --ignored --nocapture --quiet > "$OUT/dump-$name.log" 2>&1 \
    || { echo "$name FAILED (see $OUT/dump-$name.log)"; tail -5 "$OUT/dump-$name.log"; continue; }
  echo "$name ok in $(( $(date +%s) - start ))s -> $(wc -c < "$OUT/dump-$name.json" | tr -d ' ') bytes"
done
