import { JsonRpcProvider, Contract } from "ethers";
import { CONTRACT_ADDRESS, FUJI_RPC } from "./protocol.ts";

/** 读链上状态：已 mint 张数 / 总供给（判断配额与下一张图序号） */
const iface = new Contract(
  CONTRACT_ADDRESS,
  [
    "function numberMinted(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function usedHashes(bytes32) view returns (bool)",
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

export async function totalSupplyOnChain(): Promise<number> {
  try {
    return Number(await iface.totalSupply());
  } catch {
    return 0;
  }
}
