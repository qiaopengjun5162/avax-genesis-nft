import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";

/**
 * 白名单条目：wallet → 可 mint 张数上限 + 可选资格到期时间。
 * expiresAt 统一存 **unix 秒**（null/缺省 = 永不过期）。
 */
export type AllowlistEntry = { limit: number; expiresAt?: number | null };
export type Allowlist = Record<string, AllowlistEntry>;

/**
 * 解析到期时间，三种写法都收：ISO 字符串（推荐，人会读）、unix 秒、
 * unix 毫秒（1e12 以上按毫秒处理）。认不出来 → null（当作永不过期），
 * 宁可让一条配错的白名单继续有效，也不要静默把整批人拒之门外。
 */
function parseExpiresAt(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
  }
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

/**
 * 解析配额数。
 *
 * 为什么不能直接 `Math.max(1, Number(v?.limit ?? 1))`：`Number("三张")` 是
 * NaN，而 `Math.max(1, NaN)` 还是 **NaN**（Math.max 遇 NaN 一律返回 NaN）。
 * 于是 `entry.limit` 变成 NaN，`/sign` 里的配额判断 `minted + pending > limit`
 * 恒为 false —— 明明是「配置写错了一个字」，结果变成**无限签发**。
 * 这是 fail-open：不报错、不告警，只有翻链上记录才看得出来。
 *
 * 所以非有限数一律回落到 1（宁可少给，绝不多给），非整数向下取整。
 */
function parseLimit(raw: unknown): number {
  const n = Number(raw ?? 1);
  if (!Number.isFinite(n)) {
    console.warn(`⚠️  白名单 limit=${JSON.stringify(raw)} 不是有限数，按 1 处理（否则配额判断会失效）`);
    return 1;
  }
  return Math.max(1, Math.floor(n));
}

export function loadAllowlist(
  path = resolve(import.meta.dirname, "../data/allowlist.json"),
): Allowlist {
  try {
    const raw: Allowlist = JSON.parse(readFileSync(path, "utf8"));
    const out: Allowlist = {};
    for (const [k, v] of Object.entries(raw)) {
      let addr: string;
      try {
        addr = ethers.getAddress(k);
      } catch {
        // 原来一个地址写错 → getAddress 抛错 → 整个 catch 吞掉 → 白名单变空
        // → 所有人 403 且日志一片安静，极难排查。改成跳过这一条并大声告警。
        console.warn(`⚠️  白名单跳过非法地址：${k}`);
        continue;
      }
      out[addr] = {
        limit: parseLimit(v?.limit),
        expiresAt: parseExpiresAt(v?.expiresAt),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 资格是否已过期。到期那一刻（nowSec === expiresAt）**还算有效**——
 * 「有效期至 10 月 1 日」按常识应当包含当天，卡在边界上拒人最难排查。
 */
export function isExpired(
  entry: AllowlistEntry | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  return Boolean(entry?.expiresAt && nowSec > entry.expiresAt);
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
