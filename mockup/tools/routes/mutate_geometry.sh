#!/bin/bash
# routeGeometry.ts / rowRefs.ts 變異測試：每條規則改壞一處，每個都該讓 src/tests/routeGeometry.test.ts 或 rowRefs.test.ts
# 至少一個測試失敗（killed）。最後幾個 equiv 是等價變異：改了也畫出同一張圖，必須存活——被抓到代表註解裡的理由不成立。
# 用法：bash mockup/tools/routes/mutate_geometry.sh（改 routeGeometry.ts / rowRefs.ts 或其測試後重跑；SURVIVED = 該規則沒有測試把關）
#       bash mockup/tools/routes/mutate_geometry.sh compare：改用 compare_geometry.mjs（真 repo + 截斷視窗 + 基準原始碼）判定，
#       量「真資料用得到哪幾條規則」——SURVIVED 在這裡不是缺測試，是那條規則在真資料上沒被觸發；rowRefs 不在它的範圍（skip）
set -u
# 會原地改 src/lib/*.ts：cd 失敗就停，不在別的目錄繼續
cd "$(dirname "$0")/../../.." || exit 1
MODE=${1:-vitest}
GEO=src/lib/routeGeometry.ts
REFS=src/lib/rowRefs.ts
GEO_BAK=$(mktemp)
REFS_BAK=$(mktemp)
command cp "$GEO" "$GEO_BAK"
command cp "$REFS" "$REFS_BAK"
trap 'command cp "$GEO_BAK" "$GEO"; command cp "$REFS_BAK" "$REFS"; command rm -f "$GEO_BAK" "$REFS_BAK"' EXIT

check() {  # 0 = 抓到（killed）；輸出一行摘要
  if [ "$MODE" = compare ]; then
    local out; out=$(npx vite-node mockup/tools/routes/compare_geometry.mjs 2>&1)
    local rc=$?
    # 比較器自己跑不起來（例如 import 解析失敗）也是 exit 1：不能算成「抓到」，回 2 讓呼叫端整個停下
    if ! printf '%s\n' "$out" | command grep -q -E "^(PASS|FAIL) "; then
      echo "ERROR   compare_geometry.mjs did not run — $(printf '%s\n' "$out" | command grep -m1 -E "Error|error|not found" || printf '%s\n' "$out" | command head -1)"
      return 2
    fi
    # 只列失敗的項目（冒號前的名稱）
    printf '%s\n' "$out" | command grep -E "^FAIL" | command sed -E 's/^FAIL +([^:(]*).*/\1/' | command paste -sd ';' - | command sed 's/;/; /g'
    [ "$rc" -ne 0 ]
  else
    local out; out=$(npx vitest run src/tests/routeGeometry.test.ts src/tests/rowRefs.test.ts 2>&1)
    printf '%s\n' "$out" | command grep -E "^\s+Tests\s" | command tail -1 | command sed -E 's/^\s+//'
    printf '%s\n' "$out" | command grep -q -E "Tests\s+[0-9]+ failed"
  fi
}

mutate() {  # $1 = 檔案, 其餘 = perl 替換式（全部都要命中）；回傳 0 = 已套用
  local src=$1; shift
  local bak; [ "$src" = "$GEO" ] && bak=$GEO_BAK || bak=$REFS_BAK
  command cp "$GEO_BAK" "$GEO"
  command cp "$REFS_BAK" "$REFS"
  for expr in "$@"; do perl -0pi -e "$expr" "$src"; done
  if cmp -s "$bak" "$src"; then echo "NO-OP   $NAME (pattern did not match)"; return 1; fi
  for expr in "$@"; do
    # 每個替換式都要真的改到東西：單獨套在原檔上比對
    local probe; probe=$(mktemp); command cp "$bak" "$probe"; perl -0pi -e "$expr" "$probe"
    if cmp -s "$bak" "$probe"; then echo "PARTIAL $NAME (one pattern did not match: $expr)"; command rm -f "$probe"; return 1; fi
    command rm -f "$probe"
  done
}

run() {  # $1 = 名稱, $2 = 檔案, 其餘 = perl 替換式
  NAME=$1; local src=$2; shift 2
  if [ "$MODE" = compare ] && [ "$src" = "$REFS" ]; then echo "skip    $NAME (rowRefs: compare_geometry does not cover it)"; return; fi
  mutate "$src" "$@" || return
  local summary killed
  summary=$(check); killed=$?
  if [ "$killed" -eq 2 ]; then echo "$summary"; exit 2; fi
  if [ "$killed" -eq 0 ]; then echo "killed  $NAME — $summary"; else echo "SURVIVED $NAME — $summary"; fi
}

equiv() {  # 等價變異：必須存活
  NAME=$1; local src=$2; shift 2
  if [ "$MODE" = compare ] && [ "$src" = "$REFS" ]; then echo "skip    $NAME (rowRefs: compare_geometry does not cover it)"; return; fi
  mutate "$src" "$@" || return
  local summary killed
  summary=$(check); killed=$?
  if [ "$killed" -eq 2 ]; then echo "$summary"; exit 2; fi
  if [ "$killed" -eq 0 ]; then echo "NOT-EQUIV $NAME — caught, so the reason given for it is wrong — $summary"; else echo "equiv   $NAME — survives as expected — $summary"; fi
}

# ---- 走線（基準 edges()）----
run "rule 1: a fork turns at its own end" "$GEO" 's/else push\(\[\[x1, y1\], \[x1, y2 - dx\], \[x2, y2\]\], true, "fork"\);/else push([[x1, y1], [x2, y1 + dx], [x2, y2]], true, "fork");/'
run "rule 2: a Z only from four columns" "$GEO" 's/const z = dx >= 3 \* LANE \|\| dx > dy;/const z = dx >= 4 * LANE || dx > dy;/'
run "rule 2: wider than tall still turns once" "$GEO" 's/const z = dx >= 3 \* LANE \|\| dx > dy;/const z = dx >= 3 * LANE;/'
run "rule 3: reverse merges ignored" "$GEO" 's/\} else if \(j !== undefined && fed\.has\(t\.parent\)\) \{/} else if (false) {/'
run "rule 3: the gap even without room" "$GEO" 's/run <= dy - LANE \/ 2 \?/run <= dy ?/'
run "rule 4: holes only in lines drawn later" "$GEO" 's/if \(v\.n === idx \|\|/if (v.n <= idx ||/'
run "rule 5: nothing joins a boundary into a station" "$GEO" 's/e\.once === "fork" && into\.has\(/e.once === "fork" \&\& false \&\& into.has(/'
run "rule 5: nothing joins a boundary out of a station" "$GEO" 's/e\.once === "merge" && outOf\.has\(/e.once === "merge" \&\& false \&\& outOf.has(/'
run "rule 5: two columns take the mini Z too" "$GEO" 's/const wide = Math\.abs\(b\[0\] - a\[0\]\) > LANE;/const wide = false;/'
run "rule 5: a boundary run joins either side" "$GEO" \
  's/into\.add\(`\$\{b\[0\]\},\$\{b\[1\]\} \$\{Math\.sign\(a\[0\] - b\[0\]\)\}`\)/into.add(`\${b[0]},\${b[1]}`)/' \
  's/into\.has\(`\$\{b\[0\]\},\$\{b\[1\]\} \$\{-dir\}`\)/into.has(`\${b[0]},\${b[1]}`)/'
run "a merge beyond the window goes right of its child (the reference's c.lane + 1)" "$GEO" 's/: X\(line\?\.slot \?\? 0\);/: X((slotOf.get(t.child) ?? 0) + 1);/'
# ---- 繪製（基準 drawMap()）----
run "drawing order: links nearest first" "$GEO" 's/reach\(b\) - reach\(a\)/reach(a) - reach(b)/'
run "holes reach 7px along the upper line" "$GEO" 's/const HOLE_REACH = 6;/const HOLE_REACH = 7;/'
run "holes not clipped to the upper segment" "$GEO" 's/const x0 = Math\.max\(lo, v\.x - HOLE_REACH\);\n        const x1 = Math\.min\(hi, v\.x \+ HOLE_REACH\);/const x0 = v.x - HOLE_REACH;\n        const x1 = v.x + HOLE_REACH;/'
# 橋的預算（基準沒有）：真 repo 都在預算內，compare 模式下存活是正常的
run "bridge budget: no search-work cap" "$GEO" 's/  if \(slanted \* straight\.length > BRIDGE_WORK\) return holes;\n//'
run "bridge budget: no hole cap" "$GEO" 's/        if \(\+\+found > BRIDGE_CAP\) return new Map\(\);\n//'
run "bridge budget: over the cap keeps the first holes" "$GEO" 's/if \(\+\+found > BRIDGE_CAP\) return new Map\(\);/if (++found > BRIDGE_CAP) return holes;/'
run "stations: a root with a child is a tick" "$GEO" 's/s\.role === "terminus" \|\| root/s.role === "terminus"/'
run "stations: a root is a terminus before an interchange" "$GEO" 's/      : s\.role === "interchange"\n/      : s.role === "interchange" \&\& !root\n/'
run "stations: a root is a terminus before HEAD" "$GEO" 's/const kind: StationKind = s\.isHead\n/const kind: StationKind = root ? "terminus" : s.isHead\n/'
run "width and --gutter from the stations' widest column" "$GEO" 's/const slots = Math\.max\(1, routes\.slotCount\);/const slots = Math.max(1, ...routes.stations.map((s) => (routes.lines.find((l) => l.id === s.line)?.slot ?? 0) + 1));/'
run "truncated and untruncated heights swapped" "$GEO" 's/graph\.truncated \? TAIL : END_PAD/graph.truncated ? END_PAD : TAIL/'
run "the fade starts 12px under the last row" "$GEO" 's/Y\(n - 1\) \+ 11/Y(n - 1) + 12/'
# ---- rowRefs ----
run "refs in listing order" "$REFS" 's/\n      \.sort\(\(a, b\) => byName\(a\.name, b\.name\)\)//'
run "own remote by name alone" "$REFS" 's/const b = r\.identity === null \? undefined : branchOf\.get\(r\.identity\);/const b = branchesHere.find((l) => l.identity !== null && r.name.endsWith(`\/\${l.name}`));/'
run "the budget is full at 40" "$REFS" 's/used \+ label\.length > REF_BUDGET/used + label.length >= REF_BUDGET/'
run "names cut after 33 characters" "$REFS" 's/export const REF_CAP = 32;/export const REF_CAP = 33;/'
run "a HEAD pill on an attached HEAD too" "$REFS" 's/head\.branch === null && head\.oid === oid/head.oid === oid/'
run "a new branch's roundel lodges" "$REFS" 's/    if \(r\.kind === "head"\) return \{ color: routes\.accent, letter: routes\.head\.letter \?\? "\?", hollow, lodge: false \};\n//'
run "a new branch's own origin lodges (Q7)" "$REFS" 's/\.\.\.\(owner \? \{ \.\.\.roundel\(owner\), hollow: true \} : roundel\(r\)\)/...roundel(r)/'

# ---- 等價變異（必須存活）----
# dx 是 20 的倍數；dy 是 34 的倍數，或視窗外 merge 的「SVG 底 − 站心」= 34k + 13 / 34k − 5（奇數）→ dx 與 dy 永不相等
equiv "rule 2: dx >= dy instead of dx > dy" "$GEO" 's/\|\| dx > dy;/|| dx >= dy;/'
# 不連鎖：改走的線另一端直進直出（fork 的 2 欄 Z 有直下段、迷你 Z 先直下；merge 的 2 欄 Z 最後直下、迷你 Z 最後直下），
# 不會產生新的「沿列界進出」→ 依改過的線重算一次再併，結果相同
equiv "rule 5: join again after recomputing from the joined lines (a cascade)" "$GEO" \
  's/  for \(const \{ pts \} of out\) \{\n/  for (let pass = 0; pass < 2; pass++) {\n  into.clear();\n  outOf.clear();\n  for (const { pts } of out) {\n/' \
  's/    if \(!e\.once\) continue;\n/    if (!e.once) continue;\n    const was = e.pts;\n/' \
  's/    \}\n  \}\n  return out;\n\}/    }\n    if (e.pts !== was) e.once = null;\n  }\n  }\n  return out;\n}/'
# 第一個一定顯示：每個標籤最多 REF_CAP（32）字，第一個不可能是有 owner 的 remote（owner 排在它前面）→ 32 < REF_BUDGET（40）永遠放得下
equiv "rowRefs: no guard for the first ref" "$REFS" 's/\(shown\.length > 0 && used \+ label\.length > REF_BUDGET\)/(used + label.length > REF_BUDGET)/'

command cp "$GEO_BAK" "$GEO"
command cp "$REFS_BAK" "$REFS"
cmp -s "$GEO_BAK" "$GEO" && cmp -s "$REFS_BAK" "$REFS" && echo "restored: routeGeometry.ts and rowRefs.ts identical to the originals"
