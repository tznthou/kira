#!/bin/bash
# v8 Phase 2 前置：真實 repo 的分支 / merge 形態（與 build_graph 同序：--all + date-order，前 1000 筆）
set -u
for repo in "$@"; do
  echo "=== $repo"
  if [ ! -d "$repo/.git" ] && [ ! -f "$repo/HEAD" ]; then echo "  (missing)"; continue; fi
  g() { git -C "$repo" "$@"; }
  echo "  HEAD: $(g symbolic-ref -q --short HEAD || echo DETACHED) default-remote-HEAD: $(g symbolic-ref -q --short refs/remotes/origin/HEAD || echo none)"
  echo "  local branches: $(g for-each-ref refs/heads --format=x | wc -l | tr -d ' ')  remote: $(g for-each-ref refs/remotes --format=x | wc -l | tr -d ' ')  tags: $(g for-each-ref refs/tags --format=x | wc -l | tr -d ' ')"
  log=$(g log --all --date-order -n 1000 --format='%H%x09%P%x09%s')
  total=$(printf '%s\n' "$log" | wc -l | tr -d ' ')
  merges=$(printf '%s\n' "$log" | awk -F'\t' '{ n = split($2, p, " "); if (n > 1) c++ } END { print c + 0 }')
  octo=$(printf '%s\n' "$log" | awk -F'\t' '{ n = split($2, p, " "); if (n > 2) c++ } END { print c + 0 }')
  echo "  window: $total commits, merges: $merges, octopus: $octo"
  printf '%s\n' "$log" | awk -F'\t' '{ n = split($2, p, " "); if (n > 1) print $3 }' |
    sed -E 's/^Merge pull request #[0-9]+ from .*/[PR] Merge pull request #N from <owner>\/<branch>/;
            s/^Merge remote-tracking branch .*/[RT] Merge remote-tracking branch <x>/;
            s/^Merge branch .*/[MB] Merge branch <x>/;
            s/^Merge tag .*/[TAG] Merge tag <x>/' |
    sort | uniq -c | sort -rn | head -8
  echo "  sample merge subjects:"
  printf '%s\n' "$log" | awk -F'\t' '{ n = split($2, p, " "); if (n > 1) print "    " $3 }' | head -4
done
