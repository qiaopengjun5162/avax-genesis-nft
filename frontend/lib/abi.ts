import type { Abi } from "viem";
import rawAbi from "./genesisMintAbi.json";

export const genesisMintAbi = rawAbi as Abi;

/** tokenURI 解码在 `lib/token-uri.ts`（那边不 import JSON，node:test 能直接跑） */
export { decodeTokenUri, type TokenMeta } from "./token-uri";

export function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
