/**
 * 图片 URL 归一化。
 *
 * 为什么需要：后端**明确允许**用户用 `ipfs://` 作为 imageURI（见
 * `validUserImage`），合约也照原样存进 tokenURI。但浏览器不认识 `ipfs://`，
 * 直接把 `<img src="ipfs://Qm…">` 渲染出来就是一个破图——用户会以为
 * 「我的 NFT 图丢了」，实际上只是少了一次网关转换。
 *
 * 不依赖 `lib/env.ts` 的原因：那边要能保持无依赖，而这里如果写
 * `import { normalizeBaseUrl } from "./env"`，node:test 会因为缺少扩展名
 * 解析失败（Node ESM 要求显式扩展名）。三行去斜杠不值得引入这条依赖链。
 */

const IPFS_GATEWAY_DEFAULT = "https://ipfs.io/ipfs";

/** 去空白 / 去尾部斜杠；空串回退默认网关 */
function normalizeGateway(raw: string | undefined): string {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  return v || IPFS_GATEWAY_DEFAULT;
}

/**
 * - `ipfs://<cid>/<path>`  → `<gateway>/<cid>/<path>`
 * - `ipfs://ipfs/<cid>`    → `<gateway>/<cid>`（两种前缀写法都有人用）
 * - http(s) / data URI     → 原样返回
 * - 空值                   → undefined（调用方负责渲染占位）
 *
 * 网关可用 `NEXT_PUBLIC_IPFS_GATEWAY` 覆盖：公共 ipfs.io 慢且会限流，
 * 生产环境一般换成自己的或 Pinata/Cloudflare。
 */
export function resolveImageUrl(
  uri: string | undefined,
  gateway: string | undefined = process.env.NEXT_PUBLIC_IPFS_GATEWAY,
): string | undefined {
  const v = (uri ?? "").trim();
  if (!v) return undefined;
  if (!v.toLowerCase().startsWith("ipfs://")) return v;
  const base = normalizeGateway(gateway);
  const path = v.slice("ipfs://".length).replace(/^ipfs\//i, "");
  if (!path) return undefined; // 只有前缀、没有 CID：交给占位图，别拼出网关首页
  return `${base}/${path}`;
}
