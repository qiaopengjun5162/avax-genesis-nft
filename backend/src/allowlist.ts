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
  /** 读/解析失败时的回退值。启动传空（干净部署），SIGHUP 热重载传上一版。 */
  fallback: Allowlist = {},
): Allowlist {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    // 「文件不存在」= 干净部署还没配，可接受；「存在但读/解析失败」通常是
    // 运维正在编辑（截断→写入的中间态）或 SIGHUP 恰好撞上原子替换。
    // 两种都必须喊出来——原来这里直接 return {}，热重载一次就把整份好名单
    // 清空、所有人 403，而日志一片安静，只能靠用户投诉才发现。
    const missing = (e as NodeJS.ErrnoException)?.code === "ENOENT";
    console.error(
      `⚠️  白名单${missing ? "文件不存在" : "读取/解析失败"}（${path}）：` +
        `${missing ? "" : (e as Error).message}；` +
        `${Object.keys(fallback).length ? "保留上一版名单" : "按空名单处理（所有人将被拒签）"}`,
    );
    return fallback;
  }
  // JSON.parse("null") / "[]" / '"text"' 都是合法 JSON 但不是名单结构，
  // 直接 Object.entries 会把字符串拆成字符、null 抛错——都归到同一条回退路径。
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.error(`⚠️  白名单顶层不是对象（${path}），` +
      `${Object.keys(fallback).length ? "保留上一版名单" : "按空名单处理（所有人将被拒签）"}`);
    return fallback;
  }
  const out: Allowlist = {};
  for (const [k, v] of Object.entries(raw as Record<string, AllowlistEntry>)) {
    let addr: string;
    try {
      addr = ethers.getAddress(k);
    } catch {
      // 一个地址写错只跳过它，不让整份名单陪葬。
      console.warn(`⚠️  白名单跳过非法地址：${k}`);
      continue;
    }
    out[addr] = {
      limit: parseLimit(v?.limit),
      expiresAt: parseExpiresAt(v?.expiresAt),
    };
  }
  return out;
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
