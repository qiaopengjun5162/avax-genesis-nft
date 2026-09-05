import { JsonRpcProvider, Contract } from "ethers";
import { CONTRACT_ADDRESS, FUJI_RPC } from "./protocol.ts";

/** 读链上状态：已 mint 张数 / 总供给（判断配额与下一张图序号） */
const iface = new Contract(
  CONTRACT_ADDRESS,
  [
    "function numberMinted(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function usedHashes(bytes32) view returns (bool)",
    "function signer() view returns (address)",
  ],
  new JsonRpcProvider(FUJI_RPC),
);

export async function numberMintedOnChain(wallet: string): Promise<number> {
  try {
    return Number(await iface.numberMinted(wallet));
  } catch {
    return 0;
  }
}

/**
 * 链上当前 signer（null = 读不到：RPC 不通 / 合约地址错）
 * 启动自检用：私钥与链上 signer 对不上时，签出来的一律被拒。
 */
export async function signerOnChain(): Promise<string | null> {
  try {
    return (await iface.signer()) as string;
  } catch {
    return null;
  }
}

export async function totalSupplyOnChain(): Promise<number> {
  try {
    return Number(await iface.totalSupply());
  } catch {
    return 0;
  }
}
