/**
 * 首页统计卡片的展示值（纯逻辑，不碰 React / wagmi，可被 node:test 直接跑）。
 *
 * 为什么单独成文件：page.tsx 的 val() 已经正确地把「读失败 / 未加载」变成
 * undefined，但展示层一度用 `status ?? 0`、`totalSupply ?? 0n` 又把 undefined
 * 渲染成 status 0 的「⏳ Waiting（未开始）」和「已铸 0」。这与项目里反复修的
 * 静默误导同源——画廊把错误说成「你还没有 NFT」、429 被说成「服务挂了」：
 * 不崩不红，用户只看到一个看似真实的事实。
 *
 * 规则：读不到就写「…」，绝不填一个合法业务值（0 / Waiting）代替。
 */

/** 合约状态码 → 人话。与 config 的旧导出共用这一份，避免两处文案漂移。 */
export const STATUS_TEXT = [
  "⏳ Waiting（未开始）",
  "🟢 Started（进行中）",
  "⏸ Paused（已暂停）",
] as const;

/**
 * 链上 uint256 在 viem 里是 bigint，但 useReadContract 的 data 类型是
 * unknown（泛型推不出来）。旧代码 `Number(data ?? 0n)` 把它糊过去了——
 * 类型没报错，可一旦运行时真返回了非 bigint，就会被当成 0 展示。
 * 这里做真正的运行时收窄：只认 bigint，其余一律当「读不到」。
 */
export function asSupply(value: unknown): bigint | undefined {
  return typeof value === "bigint" ? value : undefined;
}

/** 状态读不到 → "…"；合约新增了未知状态码 → "?"（都不冒充 Waiting） */
export function statusLabel(status: number | undefined): string {
  if (status === undefined) return "…";
  return STATUS_TEXT[status] ?? "?";
}

/**
 * 已铸 / 总量：任一项读不到就标「…」，不伪造成 0。
 * 用 bigint.toString() 而非 Number()：大额 supply 转 Number 会丢精度，
 * 极端情况直接变 Infinity，展示成 "Infinity / Infinity"。
 */
export function supplyLabel(total: bigint | undefined, max: bigint | undefined): string {
  const t = total === undefined ? "…" : total.toString();
  const m = max === undefined ? "…" : max.toString();
  return `${t} / ${m}`;
}

/**
 * 画廊空列表文案：只有明确读到全网 0 个时才能断言「还没有任何人 mint」。
 *
 * 总量读不到时退回「你还没有 NFT」——tokensOfOwner 读成功返回空已经足以
 * 支撑这个说法，不需要顺带对全网总量下结论。旧实现 `totalSupply ?? 0n`
 * 会把「没读到」当成「全网 0 个」， RPC 抖动时用户看到一句确定的假事实。
 */
export function emptyGalleryHint(totalSupply: bigint | undefined): string {
  if (totalSupply === undefined) return "你还没有 NFT——点上面按钮领一张。";
  if (totalSupply === 0n) return "还没有任何人 mint。";
  return "你还没有 NFT——点上面按钮领一张。";
}
