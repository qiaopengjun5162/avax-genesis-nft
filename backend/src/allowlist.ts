import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";

/** 白名单配额：wallet → 可 mint 张数上限（链上 numberMinted < limit 才给签） */
export type Allowlist = Record<string, { limit: number }>;

export function loadAllowlist(
  path = resolve(import.meta.dirname, "../data/allowlist.json"),
): Allowlist {
  try {
    const raw: Allowlist = JSON.parse(readFileSync(path, "utf8"));
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [
        ethers.getAddress(k),
        { limit: Math.max(1, Number(v.limit ?? 1)) },
      ]),
    );
  } catch {
    return {};
  }
}

export function isAllowlisted(wallet: string, list: Allowlist): boolean {
  try {
    return ethers.getAddress(wallet) in list;
  } catch {
    return false;
  }
}

export function entryFor(wallet: string, list: Allowlist) {
  try {
    return list[ethers.getAddress(wallet)];
  } catch {
    return undefined;
  }
}
