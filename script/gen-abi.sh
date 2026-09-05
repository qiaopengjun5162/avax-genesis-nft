#!/usr/bin/env bash
# 合约改动后重跑本脚本：把 GenesisMint 的 ABI 同步给前端
#   用法：bash script/gen-abi.sh
# 背景：前端 lib/genesisMintAbi.json 是编译产物快照，不同步的话
#       新增的 error / function 前端读不到（曾出现 ABI 停留在 v1、
#       缺失 SignatureAlreadyUsed 的情况）
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

forge build >/dev/null

# forge inspect 不带 --json 会输出表格，且 build 的 lint 提示走 stderr，需分开处理
forge inspect GenesisMint abi --json 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s))))' \
    >frontend/lib/genesisMintAbi.json

echo "✅ 已同步 frontend/lib/genesisMintAbi.json"
