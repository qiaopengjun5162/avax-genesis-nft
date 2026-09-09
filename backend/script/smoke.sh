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

PORT="${SMOKE_PORT:-8791}"
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

info "启动签名服务（端口 ${PORT}）"
node --experimental-strip-types src/server.ts >"$LOG" 2>&1 &
SRV_PID=$!

for _ in $(seq 1 40); do
  code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${BASE}/healthz" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] && break
  sleep 0.5
done
if [ "$code" != "200" ]; then
  echo "❌ 服务没起来（/healthz 返回 ${code}）。日志：" >&2
  sed -n '1,30p' "$LOG" >&2
  exit 2
fi
ok "服务就绪"

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
  echo "$body" | grep -q '"signature"' \
    && ok "POST /sign 拿到签名（图=$(echo "$body" | grep -o 'GENESIS #[0-9]*' | head -1)）" \
    || bad "POST /sign 拿到签名" "含 signature" "$(echo "$body" | tr -d '\n' | head -c 160)"
fi

printf '\n────────────────────────\n通过 %d，失败 %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
