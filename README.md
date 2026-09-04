# GenesisMint — Avalanche Fuji 创世 NFT（ECDSA 白名单 mint）

训练营第三课（Solidity 合约实战）预习项目。参考本地半成品
`~/code/Solidity/YuanqiGenesis`（MFNFT.sol），裁剪重写为一条干净的
**前端 → 后端(签名服务) → 合约** 闭环，目标链 Avalanche Fuji。

## 为什么选这个参考

YuanqiGenesis 是本地唯一"合约 + Next.js 前端 + IPFS 工具链"三层齐全的项目，
但处于半成品状态（前端 merge 冲突未解决、五个实验合约并存、链指向 Hoodi）。
取其 **MFNFT（ERC721A + ECDSA 白名单）** 思路——白名单签名天然需要一个
后端签名服务，让"后端"不是硬凑的。

## 相对 MFNFT 修复的安全问题

| 原 MFNFT 问题 | 修复 |
|---|---|
| 签名只覆盖 imageURI，**任何人可重放别人签名铸图** | 签名绑定 `(chainid, 合约地址, msg.sender, imageURI)` |
| 签名可跨链/跨合约复用 | 同上，绑定 chainid + address(this) |
| `transfer()` 退款（2300 gas 上限，可能永久失败） | 低层 `call` + `RefundFailed` 显式错误 |
| require 字符串（费 gas、前端解析难） | 全部 custom errors |
| EOA 检查 `tx.origin==msg.sender` | 去掉——msg.sender 绑定已足够，给 ERC-1271 智能钱包留路 |

## 合约设计（src/GenesisMint.sol）

- ERC721A（批量 mint 省 gas）+ Ownable + ReentrancyGuard
- `mint(imageURI, signature)`：一人一图一签名，`_numberMinted` 链上强制每钱包 1 张
- MAX_SUPPLY = 1000；价格可配（默认 0，owner 可 setPrice）
- tokenURI 链上 Base64 JSON（不依赖中心化服务器）
- 管理员：setStatus / setPrice / setSigner / withdraw

## 签名协议（后端服务照此实现）

```
inner = keccak256(abi.encodePacked(chainid, address(this), minter, imageURI))
final = ECDSA.toEthSignedMessageHash(inner)   // EIP-191
signature = backend.sign(final)               // 用 signer 私钥签
```

## 测试（27 个，全过）

覆盖：mint 主流程 / 免费与付费 / 超付退款 / 重放防护（伪造签名、
跨钱包、错图、跨合约、跨链）/ 供给上限 1000 / 管理员权限 /
拒收 ETH 合约的退款与提现失败回滚 / tokenURI Base64 JSON /
fuzz（金额记账 256 轮、垃圾签名必拒 256 轮）。

```bash
forge test                 # 27 passed
forge coverage --report summary   # 合约自身 Lines/Funcs 100%, Branches 92.3%
```

## 部署（Fuji）

```bash
cp .env.example .env        # 填 DEPLOYER_PRIVATE_KEY（测试网账户）
forge script script/DeployGenesisMint.s.sol --rpc-url avalancheFuji --broadcast --verify -vvv
```

验证：`forge verify-contract <addr> src/GenesisMint.sol:GenesisMint --chain 43113
--constructor-args <encoded> --etherscan-api-key "" --watch`

## 路线

- [x] 合约 + 测试（本次）
- [ ] Fuji 部署（等确认）
- [ ] 后端签名服务（Node/TS）
- [ ] Next.js 前端（参考 yuanqi-mint 组件结构）
