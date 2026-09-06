# GenesisMint — Avalanche Fuji 创世 NFT

> ECDSA 白名单 + 签名按次授权 的 ERC721A mint dApp。
> 前端 (Next.js) → 后端签名服务 (Node) → 合约 (Solidity)，三层全开源。

训练营第三课（Solidity 合约实战）项目。闭环：**钱包连前端 →
后端要 ECDSA 签名 → 合约验签 → NFT 上链**。目标链 Avalanche Fuji。

---

## 安全模型（v3，要点）

每个签名是 **一次性 + 强绑定**：

```
inner = keccak256(abi.encodePacked(chainid, contract, wallet, imageURI))
final = EIP-191(inner)        // "\x19Ethereum Signed Message:\n32" 前缀
signature = backend.sign(final)
合约校验：recover == signer && usedHashes[hash] == false && msg.sender == wallet
```

绑定 4 维 → 复用/钓鱼必被链上拒：

| 维度 | 攻击方式 | 后果 |
|---|---|---|
| `chainid` | 把 Fuji 签名拿到主网用 | revert |
| `contract` | 把演示实例签名用到自部署实例 | revert |
| `wallet` | 把 alice 的签名给 bob 调 mint | revert（recovered ≠ msg.sender） |
| `imageURI` | 同一钱包用旧图 reuse 签名 | revert（`usedHashes` 标记已用） |

钱包**本身**没有"一张"的限制（v3 修正为"按配额"，每个白名单钱包可在限额内 mint 多张，每张图必须独立签名）。

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
  src/server.ts       node:http 服务（GET / + /allowlist/:w、POST /sign）
  src/chain.ts        链上读取（numberMinted / totalSupply / signer）
  src/protocol.ts     signMint / recoverSigner（与合约逐字节对齐）
  src/art.ts          创世 SVG 生成器（确定性）
  src/env.ts          .env 手写解析（支持引号/注释/export 前缀）
  src/allowlist.ts    backend/data/allowlist.json → 配额表
  data/allowlist.json { "0xWallet": { "limit": N } }

contracts/
  src/GenesisMint.sol ERC721A + ECDSA + 自定义错误
  test/GenesisMint.t.sol   32 个 forge 测试（覆盖 100%）
  script/DeployGenesisMint.s.sol  Fuji 部署脚本
  script/gen-abi.sh    重新生成前端 ABI 的小工具

.github/workflows/ci.yml
  contracts: forge build + lint + test --force
  backend:   npm ci + npm test
  frontend:  npm ci + tsc --noEmit
```

---

## 链上接口（已部署：Fuji 0x7AD0…Cc2A）

外部查询走 ABI（viem 调用 `wagmi.useReadContract`）：

- `name()` / `symbol()` — 代币元信息
- `status() → enum(Waiting, Started, Paused)` — mint 状态
- `price()` `MAX_SUPPLY()` — 当前价 / 最大供给（前端不再硬编码 0 / 1000）
- `totalSupply()` / `numberMinted(wallet)` — 已铸 / 单钱包已铸
- `tokensOfOwner(wallet)` — 一次性拉回该地址全部 tokenId（继承 ERC721AQueryable）
- `signer()` — owner 设置的签名地址（启动期后端自检）

写接口：

- `mint(imageURI, signature)` payable — 标准 mint
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
| GET | `/allowlist/:wallet` | 查配额（allowlisted / limit / minted / remaining） |
| POST | `/sign` | `{wallet, imageURI?}` → `{imageURI, signature, minted, limit, remaining}` |

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
echo '{"0xYourWallet": {"limit": 3}}' > backend/data/allowlist.json
kill -HUP <backend-pid>            # 热加载，不用重启（日志会打印重载后的钱包数）
```

优雅关闭：服务收到 `SIGTERM` / `SIGINT` 会先停收新连接、等在途请求结束再退出（10s 超时兜底强退）。

---

## 测试

| 层 | 工具 | 用例数 | 跑法 |
|---|---|---|---|
| 合约 | forge | **32** 全过 | `forge test --force` |
| 合约 lint | forge lint | 0 警告 | `forge lint` |
| 合约覆盖率 | lcov | 100% (L/S/B/F) | `forge coverage` |
| 后端 | node:test | **30** 全过 | `cd backend && npm test` |
| 前端 | tsc | 类型检查 | `cd frontend && npx tsc --noEmit` |
| 前端 | eslint | 0 error | `cd frontend && npm run lint` |

CI：`.github/workflows/ci.yml`，push / PR 到 `main` 触发三 job 并行。

---

## 部署（Fuji）

> demo 实例已是 v3 部署（`0x7AD0921D80CeFC98889a84B960c74866A452Cc2A`）。
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
- 公共 RPC `api.avax-test.network` 偶有限流，必要时换 Ankr / 自己节点（改 `.env` 的 `FUJI_RPC`）
- 白名单配额是"白名单钱包×整数 limit"模型，没有到期/按 IP 维度
- `genesisArt` 是单文件 SVG 内联（无链下资源依赖），未来如要加 PFP / 头像组件可直接后端替换
