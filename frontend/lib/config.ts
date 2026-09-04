import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coreWallet,
  metaMaskWallet,
  injectedWallet,
  trustWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig } from "wagmi";
import { defineChain, http } from "viem";

/** Avalanche Fuji C-Chain（chainId 43113）——唯一配置的链，杜绝连到主网 */
export const fuji = defineChain({
  id: 43113,
  name: "Avalanche Fuji",
  nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://api.avax-test.network/ext/bc/C/rpc"] },
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
    [fuji.id]: http("https://api.avax-test.network/ext/bc/C/rpc"),
  },
  ssr: true, // Next.js App Router 必需
});

/** GenesisMint 主合约（2026-09-04 部署 + 源码验证，Fuji） */
export const CONTRACT_ADDRESS = "0x55Ab36d5Ba138478445D31D4d1A316E5D3662F17";

/** 签名后端（Node 服务，见 backend/） */
export const SIGNER_URL =
  process.env.NEXT_PUBLIC_SIGNER_URL ?? "http://127.0.0.1:8787";

export const STATUS_TEXT = ["⏳ Waiting（未开始）", "🟢 Started（进行中）"];

export const explorerTx = (hash: string) =>
  `https://testnet.avascan.info/blockchain/c/tx/${hash}`;

/** 水龙头（测试 AVAX，24h 冷却） */
export const FAUCET_URL = "https://core.app/tools/testnet-faucet/?chainId=43113";
