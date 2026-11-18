/**
 * 错误人话化：合约 custom error selector → 用户看得懂的一句解释。
 *
 * 单独成文件（而不是留在 mint-panel.tsx）有两个原因：
 * 1. 它是**纯函数**，不碰 React / JSX，可以脱离浏览器用 node:test 直接测。
 * 2. selector 写错是静默故障——提示永不匹配，用户只看到一串原始错误，
 *    没人会报 bug。抽出来才能被测试盯住（见 test/errors.test.ts）。
 *
 * selector 的来源是 `keccak256("ErrorName(argTypes)")`，与合约 ABI 里的
 * error 条目一一对应。改动这里前先跑 `npm test`，它会拿 ABI 校对。
 */

/** 合约 custom error selector → 人话。selector 全部由 ABI 校对过（npm test 会验） */
export const REVERT_HINTS: Array<{ sel: string; hint: string }> = [
  { sel: "0x8baa579f", hint: "签名无效：钱包不在白名单 / 签名被篡改，请重试" }, // InvalidSignature()
  { sel: "0x0819bdcd", hint: "签名已过期：领取窗口约 1 小时，请重新点 Mint 要一个新签名" }, // SignatureExpired()
  { sel: "0x900bb2c9", hint: "这个签名已经上链过了（同一签名只能用一次），请重新点 Mint 要一个新签名" }, // SignatureAlreadyUsed()
  { sel: "0x06290e4e", hint: "mint 还没开始（合约 Waiting 状态）" }, // MintNotStarted()
  { sel: "0x8a164f63", hint: "供给已满（1000/1000）" }, // MaxSupplyExceeded()
  { sel: "0x552ea2c6", hint: "付款不足：合约 price() 要求付 AVAX，请给钱包充值测试币后重试" }, // EtherAmountMismatch(uint256,uint256)
  { sel: "0xd7d248ba", hint: "mint 已被 owner 暂停（合约 Paused 状态），等恢复" }, // MintPaused()
  { sel: "0x9be4ff54", hint: "图 URL 是空的——请选一张图或留空让后端分配" }, // EmptyImageURI()
  { sel: "0xf0c49d44", hint: "多付的 AVAX 退不回来，交易已回滚（合约层问题，联系 owner）" }, // RefundFailed()
  { sel: "0xb1d04f08", hint: "这个 tokenId 还不存在（可能刚铸出还没同步，刷新重试）" }, // NonexistentToken()
  { sel: "0xd92e233d", hint: "owner 配置错：setSigner 不能传 0 地址（合约层问题，联系 owner）" }, // ZeroAddress()
  { sel: "0xc2caa2a6", hint: "合约余额为 0 或 owner 提现失败（合约层问题，联系 owner）" }, // NoBalance()
];

export function humanizeError(e: unknown): string {
  const text = e instanceof Error ? `${e.message} ${(e as { cause?: unknown }).cause ?? ""}` : String(e);
  for (const { sel, hint } of REVERT_HINTS) {
    if (text.includes(sel)) return hint;
  }
  const first = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "未知错误";
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
}

/**
 * HTTP 失败的人话描述。
 *
 * 为什么需要：`res.json()` 碰到 HTML 错误页会抛 `Unexpected token '<'`，
 * 这个报错完全指向不了真因（用户以为前端坏了）。签名服务前面若挂了
 * Nginx / 网关，5xx 页是 HTML；配错 SIGNER_URL 时也可能是别的服务在应答。
 * 按响应体特征分开说，能直接把人指向「代理还是后端」。
 */
export function describeHttpFailure(status: number, bodyText: string): string {
  const t = bodyText.trim();
  if (!t) return `HTTP ${status}（响应体为空：可能是网关拦截，或后端进程已退出）`;
  if (/^</.test(t)) {
    return `HTTP ${status}（返回的是网页不是 JSON：多半是反向代理/网关错误，检查 SIGNER_URL 是否指向后端）`;
  }
  return `HTTP ${status}：${t.length > 120 ? `${t.slice(0, 120)}…` : t}`;
}

/** 钱包里点了「拒绝」（code 4001 / UserRejectedRequestError）—— 不算链上失败 */
export function isUserRejection(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // EIP-1193 规定 4001 = 用户拒绝。别只认 message：部分钱包（尤其走
  // WalletConnect 的）只带 code，message 是别的措辞，漏掉就会把「用户自己
  // 取消」显示成「交易失败」，让人以为链上出问题了。
  const code = (e as { code?: unknown }).code;
  if (code === 4001 || code === "4001") return true;
  const blob = `${e.name} ${e.message} ${(e as { shortMessage?: string }).shortMessage ?? ""}`;
  return /user rejected|userrejectedrequesterror|4001/i.test(blob);
}
