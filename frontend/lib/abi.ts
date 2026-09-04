import type { Abi } from "viem";
import rawAbi from "./genesisMintAbi.json";

export const genesisMintAbi = rawAbi as Abi;

/** 把合约 tokenURI 的 data:application/json;base64 解码成元数据对象 */
export function decodeTokenUri(uri: string): { name?: string; image?: string } | null {
  try {
    const b64 = uri.replace(/^data:application\/json;base64,/, "");
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

export function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
