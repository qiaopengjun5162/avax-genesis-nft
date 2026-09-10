#!/usr/bin/env bash
#
# 后端一键冒烟：起服务 → 打各端点 → 断言状态码与关键字段 → 收尾。
#
#   bash backend/script/smoke.sh          # 默认：只读端点 + 拒绝路径
#   SMOKE_SIGN=1 bash backend/script/smoke.sh   # 额外真签一次（要 RPC，会占一个名额）
#
# 与单测的分工：单测用 fixture 私钥、不打链、不占端口；这个脚本跑的是
# **真实进程 + 真实 .env + 真实 RPC**，专门验证「起得来、路由对、CORS/限流/413
# 这些横切逻辑在真实 HTTP 栈上生效」。单测覆盖不到的正是这一层。
#
# 退出码：全过 0，任何一条断言失败 1，服务起不来 2。
set -uo pipefail

cd "$(dirname "$0")/.."

# 必须 export：服务进程要监听的正是这个端口。之前只拿它拼 BASE 却不 export，
# 于是服务实际听的是 .env 里的 PORT（或默认 8787），BASE 却是 8791——两者
# 对不上时要么全部超时，要么（更糟）撞上 8791 上的旧实例，断言全绿但测的
# 是别人的进程。export 之后 process.env 优先级高于 .env，端口必然一致。
PORT="${SMOKE_PORT:-8791}"
export PORT
BASE="http://127.0.0.1:${PORT}"
LOG="$(mktemp -t genesis-smoke)"
# 环境里有 HTTP 代理会把 127.0.0.1 的请求也送走（表现为 502），必须绕开
CURL=(curl -s --noproxy '*')

pass=0
fail=0

ok()   { pass=$((pass + 1)); printf '  ✅ %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  ❌ %s（期望 %s，实际 %s）\n' "$1" "$2" "$3"; }
info() { printf '\n▶ %s\n' "$1"; }

expect_code() { # 名称 期望码 实际码
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi
}

cleanup() {
  if [ -n "${SRV_PID:-}" ]; then kill "$SRV_PID" 2>/dev/null || true; wait "$SRV_PID" 2>/dev/null || true; fi
  # 冒烟产生的图序号水位线是运行时状态，别留在仓库里
  rm -f data/.art-index
  rm -f "$LOG"
}
trap cleanup EXIT

# 起服务前先确认端口是空的。不检查的话，端口上若跑着**别的实例**（比如开发
# 时手动起的旧进程），本脚本起的新进程会 listen 失败退出，而 13 项断言全部
# 打在那个旧实例上——全绿，实际一行新代码都没验到。假绿灯比失败危险得多。
# 注意别写 `|| echo 000`：curl 连不上时 -w 本身就会输出 000，再 echo 一次
# 变成 000000，于是「端口是空的」被误判成「已被占用」（表现为 HTTP 000000）。
# 正确做法是让 curl 的空输出/失败都收敛成单个 000。
pre="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 2 "${BASE}/healthz" 2>/dev/null)"
[ -z "$pre" ] && pre=000
if [ "$pre" != "000" ]; then
  echo "❌ 端口 ${PORT} 上已经有服务在响应（HTTP ${pre}）——冒烟必须测自己起的进程。" >&2
  echo "   停掉它，或换个端口重跑：SMOKE_PORT=8792 bash backend/script/smoke.sh" >&2
  exit 2
fi

info "启动签名服务（端口 ${PORT}）"
node --experimental-strip-types src/server.ts >"$LOG" 2>&1 &
SRV_PID=$!

for _ in $(seq 1 40); do
  # 进程已经死了就别再空等满 20 秒：端口冲突（EADDRINUSE）/ 配置错误都是
  # 启动瞬间就退出，日志里已经有明确原因，直接打出来最快
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    echo "❌ 服务进程启动后立刻退出（多半是端口被占或配置错误）。日志：" >&2
    sed -n '1,30p' "$LOG" >&2
    exit 2
  fi
  # 同上：不要 `|| echo 000`，否则连不上时拿到 000000（数字比较不会出错，
  # 但打进日志/报错里会让人以为端口真有东西在响应）
  code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${BASE}/healthz" 2>/dev/null)"
  [ -z "$code" ] && code=000
  [ "$code" = "200" ] && break
  sleep 0.5
done
if [ "$code" != "200" ]; then
  echo "❌ 服务没起来（/healthz 返回 ${code}）。日志：" >&2
  sed -n '1,30p' "$LOG" >&2
  exit 2
fi
# 双保险：确认响应 200 的确实是**本脚本刚起的**那个进程。预检之后仍有竞态
# （比如两个冒烟同时跑）：此时新进程 EADDRINUSE 退出、日志里不会有监听行，
# 而端口上还有别人在应答——只靠 curl 200 抓不到，得看日志。
if grep -q "127.0.0.1:${PORT}" "$LOG"; then
  ok "服务就绪（且确认是本进程在听 ${PORT}）"
else
  echo "❌ 端口 ${PORT} 有响应，但本进程日志里没有监听记录——测到的可能是别人的进程。日志：" >&2
  sed -n '1,30p' "$LOG" >&2
  exit 2
fi

info "只读端点"
code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${BASE}/")"
expect_code "GET / → 200" 200 "$code"
body="$("${CURL[@]}" "${BASE}/")"
echo "$body" | grep -q '"service"' && ok "GET / 含 service 字段" || bad "GET / 含 service 字段" "含" "不含"

code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${BASE}/healthz")"
expect_code "GET /healthz → 200" 200 "$code"

code="$("${CURL[@]}" -X OPTIONS -o /dev/null -w '%{http_code}' "${BASE}/sign")"
expect_code "OPTIONS /sign → 204" 204 "$code"

code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${BASE}/nope")"
expect_code "GET /nope → 404" 404 "$code"

info "白名单查询"
NOBODY="0x1111111111111111111111111111111111111111"
body="$("${CURL[@]}" "${BASE}/allowlist/${NOBODY}")"
echo "$body" | grep -q '"allowlisted": false' \
  && ok "非白名单钱包 allowlisted=false" || bad "非白名单钱包 allowlisted=false" false "$(echo "$body" | tr -d '\n' | head -c 120)"

# 取白名单里的第一个地址做正向验证（data/allowlist.json 是本地配置，必然存在）
WL="$(node -e 'try{const l=require("./data/allowlist.json");console.log(Object.keys(l)[0]??"")}catch{console.log("")}')"
if [ -n "$WL" ]; then
  body="$("${CURL[@]}" "${BASE}/allowlist/${WL}")"
  echo "$body" | grep -q '"allowlisted": true' \
    && ok "白名单钱包 ${WL:0:10}… allowlisted=true" || bad "白名单钱包 allowlisted=true" true "$(echo "$body" | tr -d '\n' | head -c 120)"
else
  echo "  ⚠️  data/allowlist.json 为空，跳过正向白名单校验"
fi

info "拒绝路径（这些单测都覆盖过，这里确认真实 HTTP 栈上同样生效）"
code="$("${CURL[@]}" -X POST -H 'content-type: application/json' -d '{}' -o /dev/null -w '%{http_code}' "${BASE}/sign")"
expect_code "POST /sign 缺 wallet → 400" 400 "$code"

code="$("${CURL[@]}" -X POST -H 'content-type: application/json' -d '{"wallet":"not-an-address"}' -o /dev/null -w '%{http_code}' "${BASE}/sign")"
expect_code "POST /sign 非法地址 → 400" 400 "$code"

code="$("${CURL[@]}" -X POST -H 'content-type: application/json' -d "{\"wallet\":\"${NOBODY}\"}" -o /dev/null -w '%{http_code}' "${BASE}/sign")"
expect_code "POST /sign 非白名单 → 403" 403 "$code"

# 别用 /dev/zero 直接喂：那是无限流，curl 会卡到 --max-time 才被掐断，
# 拿不到任何状态码。要一个有界且明确超过 MAX_BODY_BYTES(8KB) 的 body。
BIGBODY="$(mktemp -t genesis-bigbody)"
head -c 65536 /dev/zero | tr '\0' 'a' >"$BIGBODY"
code="$("${CURL[@]}" -X POST -H 'content-type: application/json' --data-binary @"$BIGBODY" -o /dev/null -w '%{http_code}' --max-time 10 "${BASE}/sign" 2>/dev/null)"
rm -f "$BIGBODY"
case "$code" in
  413) ok "超大 body → 413（且响应能送回客户端，不是被掐连接）" ;;
  400) bad "超大 body 应 413" 413 "$code" ;;
  *)   bad "超大 body 被挡下" 413 "${code:-<空，连接被掐断>}" ;;
esac

info "CORS（未配置白名单时对任意源回显 *，配了则只回显命中源）"
hdr="$("${CURL[@]}" -D- -o /dev/null -H 'Origin: https://example.com' "${BASE}/healthz")"
echo "$hdr" | grep -qi '^vary:.*origin' && ok "响应带 Vary: Origin" || bad "响应带 Vary: Origin" "带" "不带"

if [ "${SMOKE_SIGN:-0}" = "1" ] && [ -n "$WL" ]; then
  info "真签名（要 RPC，会占一个名额）"
  body="$("${CURL[@]}" -X POST -H 'content-type: application/json' -d "{\"wallet\":\"${WL}\"}" "${BASE}/sign")"
  # 用 node 解析 JSON，别用 sed 抓正则：
  # - 原先 `grep -o 'GENESIS #[0-9]*'` 匹配不到（imageURI 是 data URI，不是明文
  #   标题），每次都输出「图=」，成功信息等于没告诉你发了什么；
  # - 换 sed 抓 `"imageURI":"([^"]*)"` 也不行：data URI 里的引号被 JSON 转义成
  #   \"，sed 抓到一半就断（表现为「imageURI=<解析不出>」）。JSON 转义是正则的盲区。
  # 一次调用同时取「图前缀」和「deadline 是否未来」，第 1 行=imageURI，第 2 行=1/0。
  SIGN_INFO="$(
    printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.imageURI||"").slice(0,44));console.log(Number(j.deadline)>Math.floor(Date.now()/1000)?"1":"0")}catch{console.log("");console.log("0")}})'
  )"
  FIG="$(printf '%s\n' "$SIGN_INFO" | sed -n '1p')"
  FUTURE="$(printf '%s\n' "$SIGN_INFO" | sed -n '2p')"

  echo "$body" | grep -q '"signature"' \
    && ok "POST /sign 拿到签名（imageURI=${FIG:-<空>}…）" \
    || bad "POST /sign 拿到签名" "含 signature" "$(echo "$body" | tr -d '\n' | head -c 160)"

  # 只验「有没有 signature」不够：deadline 若已是过去时间，这就是一张废签名，
  # 而失败会一路拖到用户点 Mint 上链时才炸（链上 revert，用户只看到交易失败）。
  # 在这里挡下，能立刻发现 SIGN_DEADLINE_SECONDS 配错之类的启动期问题。
  if [ "$FUTURE" = "1" ]; then
    ok "签名 deadline 是未来时间（不是废签名）"
  else
    bad "签名 deadline 是未来时间" "未来" "已过期或缺失"
  fi
fi

printf '\n────────────────────────\n通过 %d，失败 %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
