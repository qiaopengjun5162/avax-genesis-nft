import { JsonRpcProvider, Contract } from "ethers";
import { CONTRACT_ADDRESS, FUJI_RPC } from "./protocol.ts";

/** 链上只读视图聚合：numberMinted / totalSupply / usedHashes / signer */
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

/**
 * 返回 number | null：
 *  - number：链上精确值（可信任）
 *  - null  ：RPC 不可达 / 合约地址错 / 网络超时 —— **配额核验视为未知**
 * 之所以不能再 swallow 成 0：合约 v3 不再有"每钱包 1 张"硬上限，
 * 配额由后端签名控制；若 minted=0 误以为还有名额继续签发，
 * 钱包可在 RPC 抖动期间无限越界。fail-closed 在 server.ts /sign 体现：null → 503。
 */
export async function numberMintedOnChain(wallet: string): Promise<number | null> {
  try {
    return Number(await iface.numberMinted(wallet));
  } catch {
    return null;
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

/**
 * 总供给（用于自动分配创世图的序号 #N）。
 * 仅在用户没填 imageURI 时读取；签名接口对未知序号 fail-closed 太重，
 * 这里仍 swallow 成 0：图序号只是 SVG 文案，错了只是显示丑，不影响安全。
 */
export async function totalSupplyOnChain(): Promise<number> {
  try {
    return Number(await iface.totalSupply());
  } catch {
    return 0;
  }
}
