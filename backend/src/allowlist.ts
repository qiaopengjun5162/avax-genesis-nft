import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";

/** 白名单：wallet → 分配的创世序号。data/allowlist.json 维护 */
export type Allowlist = Record<string, { index: number }>;

export function loadAllowlist(
  path = resolve(import.meta.dirname, "../data/allowlist.json"),
): Allowlist {
  try {
    const raw: Allowlist = JSON.parse(readFileSync(path, "utf8"));
    // 归一化地址大小写，防查表漏配
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [ethers.getAddress(k), v]),
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
