/**
 * 合约 tokenURI 解码。
 *
 * 单独成文件是为了能被 node:test 直接跑：`abi.ts` 顶层 import 了 JSON
 * （Node 的 ESM 要求 import attributes），把这个纯函数留在那里就只能靠
 * 浏览器手动验证，而它恰恰是「静默失败」的典型——解析不出来只是不出图。
 *
 * 合约侧固定返回 `data:application/json;base64,<base64>`（见 GenesisMint.tokenURI），
 * 但前端不能假设「一定拿到这个形状」：换过部署 / 接了市场合约 / RPC 返回了
 * 别的东西时，这里必须能干净地返回 null，而不是让画廊渲染出一堆破图。
 */

export type TokenMeta = { name?: string; image?: string };

const DATA_JSON_PREFIX = /^data:application\/json;base64,/i;

/**
 * 解析失败 / 形状不符 → null（调用方按「无元数据」降级渲染）。
 *
 * 三个曾经的静默坑：
 * 1. 非 data URI（如 ipfs://）也硬走 atob —— 抛错被 catch 吞成 null 看似无害，
 *    但「解析失败」和「根本不是这种格式」混在一起，排查时分不清。
 * 2. `JSON.parse` 的结果没校验类型：`"null"` / `123` 会被当成对象返回，
 *    调用方 `meta?.image` 拿到的其实是 number 上的属性，永远是 undefined。
 * 3. 用 `atob()` 直接当文本：非 ASCII 名字（中文/emoji）是多字节 UTF-8，
 *    atob 给出的是字节串，拼成字符串就是乱码。必须按字节再 TextDecoder 解。
 */
export function decodeTokenUri(uri: string): TokenMeta | null {
  if (typeof uri !== "string" || !DATA_JSON_PREFIX.test(uri)) return null;
  try {
    const b64 = uri.replace(DATA_JSON_PREFIX, "");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    const meta: TokenMeta = {};
    // trim 后再判空：`<img src="  ">` 会被浏览器解析成当前页面地址，
    // 显示出来跟破图没区别，还白打一次请求
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (name) meta.name = name;
    const image = typeof o.image === "string" ? o.image.trim() : "";
    if (image) meta.image = image;
    return meta;
  } catch {
    return null;
  }
}
