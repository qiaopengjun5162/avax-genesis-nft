# GenesisMint — Avalanche Fuji 创世 NFT

> ECDSA 白名单 + 签名按次授权 的 ERC721A mint dApp。
> 前端 (Next.js) → 后端签名服务 (Node) → 合约 (Solidity)，三层全开源。

训练营第三课（Solidity 合约实战）项目。闭环：**钱包连前端 →
后端要 ECDSA 签名 → 合约验签 → NFT 上链**。目标链 Avalanche Fuji。

---

## 安全模型（v3，要点）

每个签名是 **一次性 + 强绑定 + 限时**：

```
inner = keccak256(abi.encodePacked(chainid, contract, wallet, imageURI, deadline))
final = EIP-191(inner)        // "\x19Ethereum Signed Message:\n32" 前缀
signature = backend.sign(final)
合约校验：recover == signer && usedHashes[hash] == false && block.timestamp <= deadline && msg.sender == wallet
```

绑定 5 维 → 复用/钓鱼/过期必被链上拒：

| 维度 | 攻击方式 | 后果 |
|---|---|---|
| `chainid` | 把 Fuji 签名拿到主网用 | revert |
| `contract` | 把演示实例签名用到自部署实例 | revert |
| `wallet` | 把 alice 的签名给 bob 调 mint | revert（recovered ≠ msg.sender） |
| `imageURI` | 把同一个签名上链两次 | revert（`usedHashes` 标记已用） |
| `deadline` | 白名单移除 / 私钥泄露后旧签名一直可用 | revert（`SignatureExpired`，后端默认给 ~1h 窗口） |

钱包**本身**没有"一张"的限制（v3 修正为"按配额"，每个白名单钱包可在限额内 mint 多张，每张图必须独立签名）。

> ⚠️ 一个容易看错的点：`usedHashes` 的键是
> `keccak(chainid, contract, msg.sender, imageURI, deadline)`，**含 `deadline`**。
> 所以链上保证的是「同一个签名不能上链两次」，而**不是**「同一个钱包不能铸两张相同的图」——
> 换一个新 `deadline` 重新签，同一张图还能再铸一次。这就是为什么后端必须保证自动分配的
> 创世图序号严格递增（含重启后，见下）。真要"一钱包一图"得改合约去掉去重键里的 `deadline`
> 并重新部署。

### 配额由后端把关，因此后端自己也得扛住

合约没有 per-wallet 硬上限，`limit` 全靠签名服务执行，所以这里有三道外部防线：

| 防线 | 挡什么 | 实现 |
|---|---|---|
| 限流 | 匿名脚本刷爆 RPC / CPU | `/sign` 30 次·IP⁻¹·min⁻¹、`/allowlist` 60 次；键默认取真实 TCP 对端（`X-Forwarded-For` 可伪造，需 `TRUST_PROXY=1` 才认） |
| fail-closed | RPC 抖动时按 `minted=0` 无限签发 | 读不到链上配额 → 503 拒签，不猜 |
| in-flight 占位 | 连点 / 并发两个请求读到同一个 `minted`，`limit=1` 签出 2 张 | 签发前同步占位（有效期 = 签名 deadline）+ 同钱包排队；`minted + pending > limit` 即拒 |

---

## 架构

```
frontend/             Next.js 16 + wagmi + RainbowKit + viem
  app/page.tsx        首页（统计 / mint / 画廊）
  components/         mint-panel / gallery / connect-button
  lib/abi.ts          viem 的 ABI 类型 + decodeTokenUri
  lib/config.ts       Fuji 链定义 / CONTRACT_ADDRESS / SIGNER_URL
  lib/genesisMintAbi.json  ← 脚本生成（勿手改）

backend/              Node 22 原生 TS，零运行时依赖（仅 ethers）
  src/server.ts       node:http 服务（GET / + /healthz + /allowlist/:w、POST /sign）
  src/inflight.ts     in-flight 占位 + 按钱包串行锁（防并发突破配额）
  src/ratelimit.ts    内存固定窗口限流 + 客户端 IP 取值（TRUST_PROXY）
  src/chain.ts        链上读取（numberMinted / totalSupply / signer）
  src/protocol.ts     signMint / recoverSigner（与合约逐字节对齐）
  src/art.ts          创世 SVG 生成器（确定性）
  src/env.ts          .env 手写解析（支持引号/注释/export 前缀）
  src/allowlist.ts    配额表加载 + expiresAt 到期判定（坏 key 跳过不清空）
  data/allowlist.json { "0xWallet": { "limit": N, "expiresAt"?: ISO } }（见 allowlist.example.json）

contracts/
  src/GenesisMint.sol ERC721A + ECDSA + 自定义错误
  test/GenesisMint.t.sol   35 个 forge 测试（src/GenesisMint.sol 行/语句/分支/函数均 100%；
                           部署脚本 DeployGenesisMint.s.sol 不在覆盖统计内）
  script/DeployGenesisMint.s.sol  Fuji 部署脚本
  script/gen-abi.sh    重新生成前端 ABI 的小工具

.github/workflows/ci.yml
  contracts: forge build + lint + test --force
  backend:   npm ci + npm test
  frontend:  npm ci + tsc --noEmit
```

---

## 链上接口（已部署：Fuji 0x48c9…a550）

外部查询走 ABI（viem 调用 `wagmi.useReadContract`）：

- `name()` / `symbol()` — 代币元信息
- `status() → enum(Waiting, Started, Paused)` — mint 状态
- `price()` `MAX_SUPPLY()` — 当前价 / 最大供给（前端不再硬编码 0 / 1000）
- `totalSupply()` / `numberMinted(wallet)` — 已铸 / 单钱包已铸
- `tokensOfOwner(wallet)` — 一次性拉回该地址全部 tokenId（继承 ERC721AQueryable）
- `signer()` — owner 设置的签名地址（启动期后端自检）

写接口：

- `mint(imageURI, deadline, signature) payable` — 标准 mint（deadline 防永久有效签名）
- `setStatus(Status)` onlyOwner — Waiting/Started/Paused 切换
- `setSigner(address)` onlyOwner — 注意：不能传零地址（合约层挡）
- `setPrice(uint256)` onlyOwner
- `withdraw(address payable)` onlyOwner — 注意：合约余额为 0 / 0 地址收款都会独立报错

错误（全部 custom，可解码）：

| Selector | 错误 | 触发 |
|---|---|---|
| `0x06290e4e` | MintNotStarted | 状态 Waiting |
| `0xd7d248ba` | MintPaused | 状态 Paused |
| `0x8a164f63` | MaxSupplyExceeded | 达到 MAX_SUPPLY |
| `0x8baa579f` | InvalidSignature | 签名不匹配 |
| `0x900bb2c9` | SignatureAlreadyUsed | usedHashes 命中 |
| `0x7248afc4` | SignatureExpired | deadline 已过（后端默认给 1h 窗口） |
| `0x9be4ff54` | EmptyImageURI | 提交空图 |
| `0xd92e233d` | ZeroAddress | owner 配置错误 |
| `0xc2caa2a6` | NoBalance | withdraw 时 0 余额 |

---

## 本地运行

### 1. 后端签名服务

```bash
cd backend
cp .env.example .env             # 填 SIGNER_PRIVATE_KEY（与链上 setSigner 一致）
npm ci
npm start                        # → http://127.0.0.1:8787
```

启动会自检：本服务私钥 vs 链上 `signer()`，不匹配 `console.warn`（RPC 不通也降级 warn 不阻塞）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 服务信息（合约 / chainId / signer / 白名单数） |
| GET | `/healthz` | 就绪探针：`{ok, status: ok\|degraded, rpc:{reachable, blockNumber}, uptimeSec}`；RPC 3s 超时 + 15s 缓存，可被容器探针高频打而不压 RPC |
| GET | `/allowlist/:wallet` | 查配额（allowlisted / limit / minted / remaining / pending / expired / expiresAt） |
| POST | `/sign` | `{wallet, imageURI?}` → `{imageURI, signature, minted, limit, remaining, deadline}` |

`remaining` 与 `pending`：已签发但还没上链的签名会**占用**名额（`remaining = limit - minted - pending`），
签名过期（`SIGN_DEADLINE_SECONDS`，默认 1h）或上链后自动释放。这样前端显示的剩余数与"再点一次会不会被拒"始终一致。

`expiresAt` 到期后：`/allowlist` 返回 `allowlisted:false` + `expired:true`（`limit` 仍回传，供前端显示"原可领 N 张"），
`/sign` 直接 403 且**不读链上配额**（省一次 RPC）。

缺 `SIGNER_PRIVATE_KEY` 时直接启动失败；若仅 RPC 不通，`/healthz` 返回 `degraded` 但服务照常运行。

### 2. 前端

```bash
cd frontend
npm ci
cp .env.local.example .env.local  # NEXT_PUBLIC_SIGNER_URL / WC_PROJECT_ID / CONTRACT_ADDRESS
npm run dev                      # → http://localhost:3000
```

注意：钱包需要先在浏览器里切到 Avalanche Fuji（wagmi 已限死 chainId = 43113）。

### 3. 白名单配额

```bash
cp backend/data/allowlist.example.json backend/data/allowlist.json
# 编辑 allowlist.json，把地址替换成真实钱包（key 是 checksum address）
kill -HUP <backend-pid>            # 热加载，不用重启（日志会打印重载后的钱包数）
```

格式：`{ "0xWallet": { "limit": N } }`，钱包可在限额内 mint N 张（每张图必须独立签名）。

可选的 `expiresAt`（资格到期时间，ISO 字符串或 unix 秒都收）：

```json
{ "0xWallet": { "limit": 2, "expiresAt": "2026-12-31T23:59:59Z" } }
```

- 到期那一刻**仍算有效**（"有效期至 10 月 1 日"按常识包含当天）
- 不填 / 填了认不出的值 → 永不过期：宁可让一条配错的白名单继续有效，
  也不要静默把整批人拒之门外
- 地址写错只跳过那一条并打 `⚠️` 日志，不会把整份白名单吞成空（曾导致全员 403 且日志无声）

优雅关闭：服务收到 `SIGTERM` / `SIGINT` 会先停收新连接、等在途请求结束再退出（10s 超时兜底强退）。

### 4. 运维要点

| 场景 | 做法 |
|---|---|
| 看请求情况 | 默认每个请求打一行 JSON：`{t, method, path, status, ms, ip, ua}`；`ACCESS_LOG=0` 可关 |
| 部署在 Nginx / LB 后 | 必须设 `TRUST_PROXY=1`，否则限流把所有用户算成代理那一个 IP（一人触发、全场 429） |
| 不用任何反向代理直连 | 保持 `TRUST_PROXY` 留空——`X-Forwarded-For` 是客户端可伪造的，认了它限流就形同虚设 |
| 上线 | `CORS_ORIGIN` 填前端域名（逗号分隔多源）；留空是对全世界回显 `*` |
| RPC 慢 / 挂 | `RPC_QUERY_TIMEOUT_MS`（默认 8s）兜底，超时按 fail-closed 走 503 拒签 |
| 活动结束 / 名额到期 | 给条目加 `expiresAt` 后 `kill -HUP` 热加载，到期自动 403；启动日志会打印「其中 N 个已过期」，一眼可查有没有漏配 |

---

## 测试

| 层 | 工具 | 用例数 | 跑法 |
|---|---|---|---|
| 合约 | forge | **35** 全过 | `forge test --force` |
| 合约 lint | forge lint | 0 警告 | `forge lint` |
| 合约覆盖率 | lcov | src/GenesisMint.sol 100% (L/S/B/F) | `forge coverage --report summary` |
| 后端 | node:test | **85** 全过 | `cd backend && npm test` |
| 后端冒烟 | curl（真实进程） | 13 项（默认）/ 15 项（`SMOKE_SIGN=1`） | `bash backend/script/smoke.sh`；换端口 `SMOKE_PORT=8792 bash backend/script/smoke.sh` |
| 前端 | tsc | 类型检查 | `cd frontend && npx tsc --noEmit` |
| 前端 | eslint | 0 error | `cd frontend && npm run lint` |

CI：`.github/workflows/ci.yml`，push / PR 到 `main` 触发三 job 并行。

### 关于前端类型检查 / 构建的耗时（别被本地体感误导）

前端这两个命令**慢在文件 I/O，不是类型复杂**。`npx tsc --noEmit --extendedDiagnostics`
实测：`Check time` 只有 **0.58s**，而 `I/O Read time` 高达 **318s**（要读 3051 个文件 /
38 万行 `.d.ts`，来自 wagmi / viem）。同一批 148MB 文件重复读两次分别要 64s / 97s
（约 2 MB/s，且页缓存命中不了），而 `dd` 写 200MB 只要 0.19s——是环境 I/O 吞吐问题，
**不是项目类型写坏了，别去改类型**。

- `npx tsc --noEmit`：冷启动约 **8 分钟**；命中 `tsconfig.tsbuildinfo` 增量缓存时可到几秒。
  所以「本地 3 秒」是缓存假象，CI 是全新 checkout，不能据此推断 CI 耗时。
- `next build`：约 **9 分钟**。
- 两者都必须**后台跑**，前台必撞工具超时。CI 机器（GitHub Actions）I/O 正常，快得多。

后端冒烟脚本与单测的分工：单测用 fixture 私钥、不打链、不占端口；冒烟跑的是
**真实进程 + 真实 `.env` + 真实 RPC**，专门验证「起得来、路由对、CORS/限流/413 这些
横切逻辑在真实 HTTP 栈上生效」。单测覆盖不到的正是这一层。

冒烟有一条容易踩的坑：**端口被占时必须报错，不能给假绿灯**。若 8791 上已经跑着
别的实例（比如开发时手动起的老进程），新进程会 `EADDRINUSE` 退出，而 13 项断言会
全部打在那个旧实例上——全绿，实际一行新代码都没验到。所以脚本启动前先探测端口，
被占就退出并提示换 `SMOKE_PORT`；就绪后再回查本进程日志里的监听行，确认应答的确实
是自己刚起的那个。端口由脚本 `export` 给服务进程，不依赖 `.env` 里碰巧写的值。

---

## 部署（Fuji）

> demo 实例已是 v4/deadline 部署（`0x48c9F7B4911Da705BD3285173B333b37CcB4a550`）。
> 重部署走脚本：

```bash
forge script script/DeployGenesisMint.s.sol \
  --rpc-url avalancheFuji \
  --broadcast --verify -vvv
```

部署后**必须**：

```bash
# 1) 设置 signer = 后端私钥对应地址
cast send 0x...  "setSigner(address)" 0xBackend  --rpc-url avalancheFuji --private-key $OWNER

# 2) 切到 Started
cast send 0x...  "setStatus(uint8)"    1          --rpc-url avalancheFuji --private-key $OWNER
```

更新前端：`frontend/lib/config.ts` → `CONTRACT_ADDRESS`，同步 `CONTRACT_ADDRESS` 到 `backend/.env`，重启后端。

---

## ABI 同步

合约改动 → 前端 ABI 必须同步。脚本一键搞定：

```bash
bash script/gen-abi.sh
# 输出：frontend/lib/genesisMintAbi.json（已 json.dumps compact）
```

CI 里 `contracts` job 跑 `forge build`，本地手动同步走脚本。

---

## 开发公约

- 每个小改动一个独立 commit（commit-by-commit，便于 review 与回滚）
- 合约改动 → 立即跑 `forge test --force` + `forge lint`
- 后端改动 → 立即跑 `npm test`（CI mirror）
- 前端改动 → `npx tsc --noEmit` + `npm run lint`，必要时本地 `npm run dev` 兜底
- ABI 改动后跑 `bash script/gen-abi.sh`，提交 diff

---

## 已知限制 / TODO

- ERC721AQueryable 暴露 `tokensOfOwner`，但合约字节码变大、部署 gas 略增（只读查询免 gas）
- ABI selector 列表写死在前端 `mint-panel.tsx`，合约定性调整时需同步（cast sig 验过）：
  `cast sig "GenesisMint.<Error>()"`
- 公共 RPC `api.avax-test.network` 偶有限流，必要时换 Ankr / 自己节点：
  - 后端改 `.env` 的 `FUJI_RPC`
  - 前端改 `.env.local` 的 `NEXT_PUBLIC_RPC_URL`（默认还会兜底 PublicNode，viem fallback 自动切）
- 白名单配额是"白名单钱包×整数 limit"模型（`expiresAt` 已支持到期），没有按 IP 维度
- 限流与 in-flight 占位都在**单进程内存**里：多副本部署时各自计数（限流会放宽约 N 倍，
  并发占位会失守），要跨副本一致得搬到 Redis
- 签名服务是单点的：进程重启会丢失 pending 记录（未上链签名仍在用户手里且有效，
  只是名额在那 1h 内不再被预留）——可接受，因为签名本身 1h 后就过期
- 图序号水位线落盘在 `backend/data/.art-index`：多副本部署各写一份，仍可能撞号
  （要彻底避免得用链上/Redis 统一发号）
- 内存有界但非精确：限流桶上限 5 万个 key，超限淘汰最老的（对它们临时放宽计数）；
  in-flight 槽位每 64 次 claim 全局清扫一次
- `genesisArt` 是单文件 SVG 内联（无链下资源依赖），未来如要加 PFP / 头像组件可直接后端替换
