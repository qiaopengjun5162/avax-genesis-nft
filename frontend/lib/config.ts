import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coreWallet,
  metaMaskWallet,
  injectedWallet,
  trustWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig } from "wagmi";
import { defineChain, fallback, http } from "viem";

/**
 * Fuji RPC 链：
 *  - 主节点：NEXT_PUBLIC_RPC_URL 覆盖优先，否则走 Avalanche 官方公共节点
 *  - fallback：再多挂一个 PublicNode，限流时 viem 自动尝试下一个
 * 嫌公共节点不稳的：自己跑节点 / 用 Ankr-paid，把 URL 塞 NEXT_PUBLIC_RPC_URL 即可
 * （fallback 会保留作第二跳，不是彻底替换）
 */
const FUJI_RPC_DEFAULT = "https://api.avax-test.network/ext/bc/C/rpc";
const FUJI_RPC_FALLBACK = "https://avalanche-fuji-rpc.publicnode.com";
const fujiRpcPrimary = process.env.NEXT_PUBLIC_RPC_URL?.trim() || FUJI_RPC_DEFAULT;

/** Avalanche Fuji C-Chain（chainId 43113）——唯一配置的链，杜绝连到主网 */
export const fuji = defineChain({
  id: 43113,
  name: "Avalanche Fuji",
  nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
  rpcUrls: {
    // 主 + fallback 都放进 default：RainbowKit 内部切网/读操作只取
    // rpcUrls.default.http，主节点限流时也能打到 fallback，不只在 transport 层
    default: { http: [fujiRpcPrimary, FUJI_RPC_FALLBACK] },
  },
  blockExplorers: {
    default: { name: "Avascan (Fuji)", url: "https://testnet.avascan.info/blockchain/c" },
  },
  testnet: true,
});

/**
 * 钱包列表（弹出卡片里供选择）：
 * Core(官方/内置 Fuji) + MetaMask + Trust + 通用注入 —— 故意不含 coinbase
 * （coinbase 的 cdp-sdk 有 @x402 module-not-found 已知依赖坑，绕开）
 *
 * chains 只有 fuji → 连接即强制切到测试网（链上只有 43113 这一条路）
 */
const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID ?? "genesis-mint-local-demo";

const connectors = connectorsForWallets(
  [
    {
      groupName: "推荐",
      wallets: [coreWallet, metaMaskWallet],
    },
    {
      groupName: "其他",
      wallets: [trustWallet, injectedWallet],
    },
  ],
  { appName: "GenesisMint", projectId },
);

export const wagmiConfig = createConfig({
  chains: [fuji],
  connectors,
  transports: {
    // rank:false → 按列表顺序逐个试（不按延迟动态排序，避免抖动时频繁切）
    [fuji.id]: fallback([http(fujiRpcPrimary), http(FUJI_RPC_FALLBACK)], { rank: false }),
  },
  ssr: true, // Next.js App Router 必需
});

/**
 * GenesisMint v4 合约（签名按次授权，钱包可 mint 多张；0x48c9… 为 deadline 版）
 * 部署新实例时通过 NEXT_PUBLIC_CONTRACT_ADDRESS 覆盖，避免改源码；
 * 缺省仍是已验证的 Fuji 演示实例。
 */
export const CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as
  | `0x${string}`
  | undefined) ?? "0x48c9F7B4911Da705BD3285173B333b37CcB4a550";

/** 签名后端（Node 服务，见 backend/） */
export const SIGNER_URL =
  process.env.NEXT_PUBLIC_SIGNER_URL ?? "http://127.0.0.1:8787";

export const STATUS_TEXT = [
  "⏳ Waiting（未开始）",
  "🟢 Started（进行中）",
  "⏸ Paused（已暂停）",
];

export const explorerTx = (hash: string) =>
  `https://testnet.avascan.info/blockchain/c/tx/${hash}`;

/** 水龙头（测试 AVAX，24h 冷却） */
export const FAUCET_URL = "https://core.app/tools/testnet-faucet/?chainId=43113";
