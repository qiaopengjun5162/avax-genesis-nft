/**
 * 链上 uint256 → 可安全用于配额判断的 number。
 *
 * 单独成纯模块是为了能被 node:test 直接跑（chain.ts 一 import 就会连真 RPC）。
 *
 * 为什么要校验而不是裸 Number(await iface.xxx())：
 *  - RPC 异常返回（节点返回畸形数据、ethers 解码出意外类型）时 Number() 可能
 *    得到 NaN，而 NaN 既不等于 null 也通不过 `minted === null` 的 fail-closed
 *    检查；接下来 `NaN + pending > limit` 恒为 false —— 配额判断失效变无限签发。
 *  - totalSupply 若为 NaN，nextArtIndex 里 Math.max(NaN, …) 还是 NaN，
 *    所有自动分配的图都变成 GENESIS #NaN → 同钱包铸出多张一模一样的 NFT。
 * 与 parseLimit 同向：读不到 / 读不懂一律 null（未知），绝不猜一个合法值。
 */

/** uint256 安全上界：超过 Number.MAX_SAFE_INTEGER 的计数无法精确表示，按未知处理 */
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function toOnChainCount(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "bigint") {
    if (raw < 0n || raw > MAX_SAFE) return null;
    n = Number(raw);
  } else if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0 || raw > Number.MAX_SAFE_INTEGER) {
      return null;
    }
    n = raw;
  } else {
    return null;
  }
  return Number.isFinite(n) ? n : null;
}
