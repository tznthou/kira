#!/bin/bash
# 基準在每個 ?on= / ?state= 下的「你在這裡」→ src/tests/fidelityStates.test.ts 的 REFERENCE 期望值。
# 基準改了路線、字母或狀態就重跑，把結果抄回測試（期望值不手推：手推與 states.ts 同一人寫會一致地錯）。
# 用法：mockup/tools/youare_probe.sh
set -euo pipefail
TOOLS="$(cd "$(dirname "$0")" && pwd)"
REF="file://$(dirname "$TOOLS")/v8-kirazuri-lines-sys.html"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
echo "reference: v8-kirazuri-lines-sys.html @ $(git -C "$TOOLS/.." log -1 --format=%h -- v8-kirazuri-lines-sys.html)"
for q in "" "on=main" "state=behind" "state=diverged" "state=no-upstream" "state=no-remote" "state=detached" \
         "state=signed-out" "state=connecting" "state=account-menu" "state=error-push" "state=error-pull" \
         "state=error-refresh" "state=error-open" "state=error-auth" "state=error-signout" \
         "state=loading" "state=empty" "state=young" "state=routes" "state=new-branch" "state=head-beyond" \
         "state=lodger" "state=long-refs"; do
  url="$REF?chrome=0${q:+&$q}"
  res=$("$TOOLS/wk-shot" "$url" 1400 900 "$OUT/shot.png" "$TOOLS/youare-probe.js" ready 2>&1 | grep -v '^saved ' || true)
  printf '%-22s %s\n' "${q:-default}" "$res"
done
