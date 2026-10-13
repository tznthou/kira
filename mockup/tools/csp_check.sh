#!/bin/bash
# CSP 檢查。CSP 只在打包版套用：tauri dev 直接載 Vite 的 devUrl，dev、fidelity、D1 都看不到違規，所以這支建出打包版來驗。
# 以 `tauri build --debug --no-bundle --config <疊加>` 在 tauri.conf.json 的 CSP 上加 report-uri，WebKit 把每筆違規 POST 到本機收集器。
# 三輪，每輪用假的 HOME 啟動 app（不碰真的近期清單），開機後等 --secs 秒：
#   verify       照設定，違規必須 0 筆
#   control-img  img-src 拿掉 data:，必須收到 img-src（v8.css 的雲母斑點）——證明回報管道會響，verify 的 0 才算數
#   control-ipc  connect-src 拿掉 ipc:，必須收到 connect-src（開機時的 IPC）——證明 IPC 有經過 CSP 檢查
# 用法：bash mockup/tools/csp_check.sh [--secs 12] [--out DIR] [--port 8765]
#       bash mockup/tools/csp_check.sh --manual [--seed-recent <repo 路徑>]
#           只建 verify，開 app 給人操作（開 repo、看 diff、切主題⋯），關掉 app 後列出這段期間的違規
# 會跳出 app 視窗。跑完 src-tauri/target/debug/kira 是打包版，下次 npm run dev 會自己重建
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CONF=$ROOT/src-tauri/tauri.conf.json
SECS=12; PORT=8765; MANUAL=0; SEED=""; OUT=""
while [ $# -gt 0 ]; do
  case $1 in
    --secs) SECS=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --manual) MANUAL=1; shift ;;
    --seed-recent) SEED=$2; shift 2 ;;
    *) echo "未知參數：$1"; exit 2 ;;
  esac
done
[ -f "$CONF" ] || { echo "找不到 $CONF"; exit 2; }
# 疊加是 JSON merge patch：CSP 寫成字串時，疊上去的物件會整個取代它
python3 -c 'import json,sys; c=json.load(open(sys.argv[1]))["app"]["security"]["csp"]; sys.exit(0 if isinstance(c, dict) else 1)' "$CONF" \
  || { echo "tauri.conf.json 的 csp 不是物件，這支的疊加方式不適用"; exit 2; }
IDENT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["identifier"])' "$CONF")
[ -n "$OUT" ] || OUT=$ROOT/mockup/fidelity-out/csp-check/$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
BIN=$ROOT/src-tauri/target/debug/kira
REPORT_URI=http://127.0.0.1:$PORT/csp

cat > "$OUT/collector.py" <<'PY'
import http.server, sys
LOG, PORT = sys.argv[1], int(sys.argv[2])
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n).decode("utf-8", "replace").replace("\n", " ")
        with open(LOG, "a") as f:
            f.write(body + "\n")
        self.send_response(204)
        self.end_headers()
    def log_message(self, *a):
        pass
http.server.HTTPServer(("127.0.0.1", PORT), H).serve_forever()
PY

overlay() {  # $1 = 輪名, $2 = 額外覆寫的 JSON 物件（指令 → 值）
  python3 -c 'import json,sys; o=json.loads(sys.argv[2]); o["report-uri"]=sys.argv[3]; json.dump({"app":{"security":{"csp":o}}}, open(sys.argv[1],"w"))' \
    "$OUT/$1.json" "$2" "$REPORT_URI"
}

run_round() {  # $1 = 輪名；回傳 0 = app 有跑起來
  local v=$1 cpid apid
  echo "== $v: build"
  (cd "$ROOT" && npx tauri build --debug --no-bundle --config "$OUT/$v.json") > "$OUT/build-$v.log" 2>&1 \
    || { echo "   build 失敗，見 $OUT/build-$v.log"; return 1; }
  : > "$OUT/reports-$v.log"
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null && { echo "   port $PORT 已被佔用（舊收集器沒關？）"; return 1; }
  python3 "$OUT/collector.py" "$OUT/reports-$v.log" "$PORT" & cpid=$!
  sleep 1
  if ! lsof -nP -a -p "$cpid" -iTCP:"$PORT" -sTCP:LISTEN >/dev/null; then
    echo "   收集器沒在聽 $PORT"; kill "$cpid" 2>/dev/null; return 1
  fi
  local home=$OUT/home-$v
  mkdir -p "$home/Library/Application Support/$IDENT"
  if [ -n "$SEED" ]; then
    python3 -c 'import json,os,sys,time; json.dump([{"path":os.path.realpath(sys.argv[2]),"last_opened":int(time.time())}], open(sys.argv[1],"w"))' \
      "$home/Library/Application Support/$IDENT/recent_repos.json" "$SEED"
  fi
  HOME=$home "$BIN" > "$OUT/app-$v.log" 2>&1 & apid=$!
  sleep 2
  if ! kill -0 "$apid" 2>/dev/null; then
    echo "   app 沒跑起來，見 $OUT/app-$v.log"; kill "$cpid" 2>/dev/null; return 1
  fi
  if [ "$MANUAL" = 1 ]; then
    echo "   app 已開（pid $apid），操作完關掉 app 就會列出違規"
    wait "$apid"
  else
    sleep "$SECS"
    kill "$apid" 2>/dev/null; sleep 1; kill -9 "$apid" 2>/dev/null
  fi
  sleep 1
  kill "$cpid" 2>/dev/null; wait "$cpid" 2>/dev/null
  return 0
}

count() {  # $1 = 輪名, $2 = 指令（空字串 = 全部）；印出筆數
  python3 -c '
import json,sys
n=0
for line in open(sys.argv[1]):
    r=json.loads(line)["csp-report"]
    if not sys.argv[2] or r.get("violated-directive")==sys.argv[2]: n+=1
print(n)' "$OUT/reports-$1.log" "$2"
}

show() {  # 列出違規（指令 + 被擋的來源）
  python3 -c '
import json,sys
seen={}
for line in open(sys.argv[1]):
    r=json.loads(line)["csp-report"]; k=(r.get("violated-directive"), r.get("blocked-uri"))
    seen[k]=seen.get(k,0)+1
for (d,u),n in sorted(seen.items()): print("   %d x %s  %s" % (n,d,u))' "$OUT/reports-$1.log"
}

FAIL=0
overlay verify '{}'
if [ "$MANUAL" = 1 ]; then
  run_round verify || exit 1
  echo "== verify: $(count verify '') 筆違規"; show verify
  exit 0
fi
overlay control-img '{"img-src":"'"'self'"'"}'
overlay control-ipc '{"connect-src":"'"'self'"'"}'

if run_round verify; then
  n=$(count verify ''); show verify
  if [ "$n" = 0 ]; then echo "   PASS verify：0 筆"; else echo "   FAIL verify：$n 筆"; FAIL=1; fi
else FAIL=1; fi
if run_round control-img; then
  n=$(count control-img img-src); show control-img
  if [ "$n" -gt 0 ]; then echo "   PASS control-img：$n 筆 img-src"; else echo "   FAIL control-img：沒收到 img-src（回報管道沒響，verify 的 0 不算數）"; FAIL=1; fi
else FAIL=1; fi
if run_round control-ipc; then
  n=$(count control-ipc connect-src); show control-ipc
  if [ "$n" -gt 0 ]; then echo "   PASS control-ipc：$n 筆 connect-src"; else echo "   FAIL control-ipc：沒收到 connect-src（IPC 沒經過 CSP，或開機沒有 IPC）"; FAIL=1; fi
else FAIL=1; fi
echo "輸出：$OUT"
[ "$FAIL" = 0 ] && echo "PASS" || { echo "FAIL"; exit 1; }
