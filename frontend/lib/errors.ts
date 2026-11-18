/**
 * 错误人话化：合约 custom error → 用户看得懂的一句解释。
 *
 * 单独成文件（而不是留在 mint-panel.tsx）有两个原因：
 * 1. 它是**纯函数**，不碰 React / JSX，可以脱离浏览器用 node:test 直接测。
 * 2. 匹配不上是静默故障——提示永不出现，用户只看到一串原始错误，
 *    没人会报 bug（见 test/errors.test.ts 里用真实 viem 错误对象
 *    构造的回归用例）。
 *
 * 每个条目同时记 selector 与 error 名字，**两者都要能匹配**：
 *  - 已解码（ABI 里有这个 error）：viem 的 message 里只有名字
 *    `Error: SignatureExpired()`，十六进制 selector 只存在于 `raw`/`data`；
 *  - 未解码（ABI 缺这个 error，或只拿到裸 RPC 报错）：只有 `0x0819bdcd`。
 * 之前只按 selector 匹配，而 viem 在正常情况下一定会解码 —— 于是 12 条
 * 提示全部是死代码，用户永远只看到 `The contract function "mint" reverted.`。
 *
 * selector 与名字的对应关系由测试用 ABI 逐条核对（不许只改一处）。
 */

export type RevertHint = {
  /** 4 字节 selector（来自 ABI，测试会反查） */
  sel: string;
  /** 函数签名，如 `SignatureExpired()` —— 已解码时唯一的线索 */
  name: string;
  hint: string;
};

export const REVERT_HINTS: RevertHint[] = [
  { sel: "0x8baa579f", name: "InvalidSignature()", hint: "签名无效：钱包不在白名单 / 签名被篡改，请重试" },
  { sel: "0x0819bdcd", name: "SignatureExpired()", hint: "签名已过期：领取窗口约 1 小时，请重新点 Mint 要一个新签名" },
  { sel: "0x900bb2c9", name: "SignatureAlreadyUsed()", hint: "这个签名已经上链过了（同一签名只能用一次），请重新点 Mint 要一个新签名" },
  { sel: "0x06290e4e", name: "MintNotStarted()", hint: "mint 还没开始（合约 Waiting 状态）" },
  { sel: "0x8a164f63", name: "MaxSupplyExceeded()", hint: "供给已满（1000/1000）" },
  { sel: "0x552ea2c6", name: "EtherAmountMismatch(uint256,uint256)", hint: "付款不足：合约 price() 要求付 AVAX，请给钱包充值测试币后重试" },
  { sel: "0xd7d248ba", name: "MintPaused()", hint: "mint 已被 owner 暂停（合约 Paused 状态），等恢复" },
  { sel: "0x9be4ff54", name: "EmptyImageURI()", hint: "图 URL 是空的——请选一张图或留空让后端分配" },
  { sel: "0xf0c49d44", name: "RefundFailed()", hint: "多付的 AVAX 退不回来，交易已回滚（合约层问题，联系 owner）" },
  { sel: "0xb1d04f08", name: "NonexistentToken()", hint: "这个 tokenId 还不存在（可能刚铸出还没同步，刷新重试）" },
  { sel: "0xd92e233d", name: "ZeroAddress()", hint: "owner 配置错：setSigner 不能传 0 地址（合约层问题，联系 owner）" },
  { sel: "0xc2caa2a6", name: "NoBalance()", hint: "合约余额为 0 或 owner 提现失败（合约层问题，联系 owner）" },
];

/**
 * 把整条错误链的文字拼起来（viem 的错误最多嵌套 4–5 层：
 * ContractFunctionExecutionError → ContractFunctionRevertedError → RpcError）。
 *
 * 只取 `e.message` 是不够的：内层原因、`details`（viem 把它定义成
 * 「内层 message」）、还有未解码时的 `raw` hex 都在别处。
 * 有深度上限，避免某些库造出的循环 cause 把这里变成死循环。
 */
function collectText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && cur != null; depth++) {
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    if (cur instanceof Error) {
      parts.push(cur.message);
      const extra = cur as { details?: unknown; raw?: unknown };
      if (typeof extra.details === "string") parts.push(extra.details);
      if (typeof extra.raw === "string") parts.push(extra.raw);
      cur = (cur as { cause?: unknown }).cause;
      continue;
    }
    parts.push(String(cur));
    break;
  }
  return parts.join("\n");
}

/** viem 的固定套话：这些行对用户零信息量，不该当成错误原因显示 */
const NOISE = /^(The contract function .* reverted\.?|Contract Call:|function:|args:|sender:|Version: |Docs: )/;

/** 从错误链里挑出**最像原因**的一行，而不是无脑取首行 */
function bestReason(text: string): string | null {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // ① viem 把可读原因放在 "reverted with the following reason:" 的下一行
  const idx = lines.findIndex((l) => /reverted with the following (reason|signature)/i.test(l));
  if (idx >= 0 && lines[idx + 1]) return lines[idx + 1];

  // ② 已解码的 custom error：`Error: InvalidSignature()`（参数可能跨行，取到 ')' 为止）
  const custom = text.match(/Error:\s*([A-Za-z_][A-Za-z0-9_]*\([^)]*\))/);
  if (custom) return custom[1];

  // ③ 其余：跳过 viem 套话与空行
  const first = lines.find((l) => !NOISE.test(l));
  return first ?? lines[0] ?? null;
}

export function humanizeError(e: unknown): string {
  const text = collectText(e);
  for (const { sel, name, hint } of REVERT_HINTS) {
    // 已解码走名字，未解码走 hex —— 两条路都要通
    if (text.includes(sel) || text.includes(`${name.split("(")[0]}(`)) return hint;
  }

  const reason = bestReason(text);
  if (!reason) return "未知错误";

  // 未收录的 custom error：至少把名字带出来（`Xxx(uint256)` 比
  // 「The contract function "mint" reverted.」有用得多）
  const shown = /^[A-Za-z_][A-Za-z0-9_]*\([^)]*\)$/.test(reason) ? `合约拒绝了这笔交易：${reason}` : reason;
  return shown.length > 160 ? `${shown.slice(0, 160)}…` : shown;
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
