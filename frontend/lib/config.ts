import { defineChain, http } from "viem";
import { createConfig } from "wagmi";
import { injected } from "wagmi/connectors";

/** Avalanche Fuji C-Chain（chainId 43113）——与合约部署网络一致 */
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
});

export const wagmiConfig = createConfig({
  chains: [fuji],
  connectors: [injected()], // MetaMask / Core 扩展都暴露 window.ethereum
  transports: {
    [fuji.id]: http(),
  },
});

/** GenesisMint 主合约（2026-09-04 部署 + 源码验证） */
export const CONTRACT_ADDRESS = "0x55Ab36d5Ba138478445D31D4d1A316E5D3662F17";

/** 签名后端（Node 服务，见 backend/） */
export const SIGNER_URL =
  process.env.NEXT_PUBLIC_SIGNER_URL ?? "http://127.0.0.1:8787";

export const STATUS_TEXT = ["⏳ Waiting（未开始）", "🟢 Started（进行中）"];

export const explorerTx = (hash: string) =>
  `https://testnet.avascan.info/blockchain/c/tx/${hash}`;
