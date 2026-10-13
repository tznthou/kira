#!/bin/bash
# routeMap.ts 變異測試：19 個規則各改壞一處，每個都該讓 src/tests/routeMap.test.ts 至少一個測試失敗（killed）。
# 用法：bash mockup/tools/routes/mutate_routes.sh（改 routeMap.ts 或其測試後重跑；SURVIVED = 該規則沒有測試把關）
#       bash mockup/tools/routes/mutate_routes.sh compare：改用 compare_ts.mjs（真 repo 上 TS ↔ 原型）判定，
#       量「四個真 repo 用得到哪幾條規則」——SURVIVED 在這裡不是缺測試，是那條規則在真資料上沒被觸發
set -u
# 會原地改 src/lib/routeMap.ts：cd 失敗就停，不在別的目錄繼續
cd "$(dirname "$0")/../../.." || exit 1
MODE=${1:-vitest}
SRC=src/lib/routeMap.ts
BAK=$(mktemp)
command cp "$SRC" "$BAK"
trap 'command cp "$BAK" "$SRC"; command rm -f "$BAK"' EXIT

check() {  # 0 = 抓到（killed）；輸出一行摘要
  if [ "$MODE" = compare ]; then
    local out; out=$(node --experimental-strip-types mockup/tools/routes/compare_ts.mjs 2>&1)
    local rc=$?
    # 只列失敗的輸入：「名稱 (不一致數)」
    printf '%s\n' "$out" | grep -E "^FAIL" \
      | sed -E 's/^FAIL +(.*): [0-9]+ commits · [0-9]+ lines · ([0-9]+) mismatches.*/\1 (\2)/' | paste -sd ';' - | sed 's/;/; /g'
    [ "$rc" -ne 0 ]
  else
    local out; out=$(npx vitest run src/tests/routeMap.test.ts 2>&1)
    printf '%s\n' "$out" | grep -E "^\s+Tests\s" | tail -1 | sed -E 's/^\s+//'
    printf '%s\n' "$out" | grep -q -E "Tests\s+[0-9]+ failed"
  fi
}

run() {  # $1 = 名稱, 其餘 = perl 替換式（可多個，全部都要命中）
  local name=$1; shift
  command cp "$BAK" "$SRC"
  for expr in "$@"; do perl -0pi -e "$expr" "$SRC"; done
  if cmp -s "$BAK" "$SRC"; then echo "NO-OP   $name (pattern did not match)"; return; fi
  for expr in "$@"; do
    # 每個替換式都要真的改到東西：單獨套在原檔上比對
    local probe; probe=$(mktemp); command cp "$BAK" "$probe"; perl -0pi -e "$expr" "$probe"
    if cmp -s "$BAK" "$probe"; then echo "PARTIAL $name (one pattern did not match: $expr)"; command rm -f "$probe"; return; fi
    command rm -f "$probe"
  done
  local summary killed
  summary=$(check); killed=$?
  if [ "$killed" -eq 0 ]; then
    echo "killed  $name — $summary"
  else
    echo "SURVIVED $name — $summary"
  fi
}

run "trunk stops at other tips" 's/claim\(trunk, tier, tip\.oid, false\)/claim(trunk, tier, tip.oid, true)/'
run "full-row spans" 's/2 \* forkRow - 1/2 * forkRow/' 's/\.reduce\(\(a, b\) => Math\.min\(a, b\)\) \+ 1/.reduce((a, b) => Math.min(a, b))/'
run "no HEAD-first colours" 's/claim\(headBranch, "head", tip\.oid, true\)/claim(headBranch, "local", tip.oid, true)/' 's/\(id === headIdentity \? TIER\.head : minTier\(id\)\)/(minTier(id))/'
run "letters without word initials" 's/for \(const word of last\.split\(WORD_BREAK\)\) add\(word\[0\]\);//'
run "uppercase before ASCII check" 's/if \(!ch \|\| !ASCII_LETTER\.test\(ch\)\) return;\n    const upper = ch\.toUpperCase\(\);/if (!ch) return;\n    const upper = ch.toUpperCase();\n    if (!\/^[A-Z]+\$\/.test(upper)) return;/'
run "no head:detached rename" 's/headSeg\.identity = "head:detached";\n    headSeg\.id = "head:detached";//'
run "no parent cap" 's/const MAX_PARENTS_PER_COMMIT = 64;/const MAX_PARENTS_PER_COMMIT = 100000;/'
run "branches ignore other tips" 's/for \(const tip of tipsByRow\(r\.id\)\) claim\(r\.id, tier, tip\.oid, true\)/for (const tip of tipsByRow(r.id)) claim(r.id, tier, tip.oid, false)/'
run "no upstream join" 's/\(upstreamOwner\.get\(b\.name\) \?\? b\.name_on_remote \?\? b\.name\)/(b.name_on_remote ?? b.name)/'
run "no remote prefix strip" 's/git\[1\] \? stripRemote\(git\[2\]\) : git\[2\]/git[2]/'
run "colours never yield" 's/if \(!used\.has\(candidate\)\) \{/if (k === 0) {/'
run "shared tip reverse name order" 's/a\.top - b\.top \|\| byName\(a\.id, b\.id\)/a.top - b.top || byName(b.id, a.id)/'
# 步驟 3（2026-10-05）補：原型與 TS 對齊時才寫明的平手規則
run "upstream owner = first listed" 's/\.filter\(\(b\) => !b\.is_remote\)\.sort\(\(x, y\) => byName\(x\.name, y\.name\)\)/.filter((b) => !b.is_remote)/'
run "upstream owner = last listed" 's/if \(b\.upstream && !upstreamOwner\.has\(b\.upstream\)\)/if (b.upstream)/'
run "first listed tag names the line" 's/\[\.\.\.\(tagsAt\.get\(c\.full_oid\) \?\? \[\]\)\]\.sort\(byName\)\[0\]/(tagsAt.get(c.full_oid) ?? [])[0]/'
run "shortest remote prefix first" 's/\.sort\(\(a, b\) => b\.length - a\.length \|\| byName\(a, b\)\)/.sort((a, b) => a.length - b.length || byName(a, b))/'
run "HEAD-first colours only when attached" 's/const colorTier = \(id: string\) => \(id === headIdentity/const colorTier = (id: string) => (id === headBranch/'
# Phase 4（2026-10-08）：unborn 的 HEAD 分支在主幹候選裡當作有 ref
run "unborn HEAD never the trunk" 's/\(refIdentities\.has\(id\) \|\| id === unbornHead\)/refIdentities.has(id)/'
run "unborn HEAD outranks the other candidates" 's/\[graph\.default_branch, "main", "master", graph\.head\.branch\]\.find/[unbornHead, graph.default_branch, "main", "master", graph.head.branch].find/'

command cp "$BAK" "$SRC"
cmp -s "$BAK" "$SRC" && echo "restored: routeMap.ts identical to the original"
