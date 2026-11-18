/**
 * `NEXT_PUBLIC_*` 环境变量的归一化。
 *
 * 单独成文件是为了能被 node:test 直接跑（纯函数，不碰 React / wagmi）。
 *
 * 为什么需要：这几个变量有**两种常见的空值陷阱**，而且都只在部署时才暴露：
 *  - `NEXT_PUBLIC_SIGNER_URL=`（CI 里定义为空、或 `.env` 留了空行）→ 值变成
 *    空字符串，`fetch("" + "/sign")` 变成相对路径，打到 Next 自己的路由上，
 *    用户看到的是 404 而不是「后端没配」。
 *  - 尾部斜杠 `https://api.example.com/` → 拼出 `https://api.example.com//sign`，
 *    有些反向代理/框架把 `//sign` 当成不同路径直接 404。
 * 这两种都属于「配置写错但报错指向别处」，很难排查。
 */

/** 基址 URL：去空白、去尾部斜杠；空串回退默认值 */
export function normalizeBaseUrl(raw: string | undefined, fallback: string): string {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  return v || fallback;
}

/**
 * 合约地址：去空白；空串回退默认值。
 *
 * 刻意**不校验格式**：非空但写错的地址应当原样透传，让 viem 在调用时明确报
 * 「invalid address」。若这里静默回退到演示合约，用户会以为自己在铸自己的合约，
 * 实际铸到别人的实例上——比直接报错糟得多。
 */
export function pickAddress<T extends string>(raw: string | undefined, fallback: T): T {
  const v = (raw ?? "").trim();
  return (v || fallback) as T;
}
