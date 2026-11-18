/**
 * tokenURI 解码的测试。
 *
 * 为什么值得测：这个函数坏掉时**什么都不会报**——画廊只是不出图、名字
 * 退回 `#id`。历史上它还有两个更隐蔽的问题：
 *  - 非 data URI 也硬走 atob，catch 后一律返回 null，把「格式不对」和
 *    「内容坏了」混成同一种结果；
 *  - JSON.parse 的结果没校验类型，`JSON.parse("123")` 被当成对象返回，
 *    调用方拿到的 `meta.image` 永远是 undefined。
 *
 * 跑法：cd frontend && npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeTokenUri } from "../lib/token-uri.ts";

/** 按合约真实形状（data:application/json;base64,）编码；用 Buffer 保证 UTF-8 正确 */
function encode(json: string): string {
  return "data:application/json;base64," + Buffer.from(json, "utf8").toString("base64");
}

test("token-uri: 正常解析 name/image", () => {
  const meta = decodeTokenUri(encode(JSON.stringify({ name: "Genesis #7", image: "ipfs://bafy/x.png" })));
  assert.deepEqual(meta, { name: "Genesis #7", image: "ipfs://bafy/x.png" });
});

test("token-uri: 非 ASCII 名字按 UTF-8 解码（atob 直接当文本会变乱码）", () => {
  const meta = decodeTokenUri(encode(JSON.stringify({ name: "创世 #7 🎨", image: "https://e.x/a.png" })));
  assert.equal(meta?.name, "创世 #7 🎨");
});

test("token-uri: 前缀大小写不敏感（合约可能换实现，不该因此不出图）", () => {
  const b64 = Buffer.from(JSON.stringify({ name: "x" }), "utf8").toString("base64");
  assert.equal(decodeTokenUri("DATA:APPLICATION/JSON;BASE64," + b64)?.name, "x");
});

test("token-uri: 不是 data:application/json → null（不猜、不硬解）", () => {
  // ipfs:// / https:// 是常见的外部 tokenURI，直接返回 null 让调用方降级，
  // 而不是把整个 URL 丢给 atob 抛一个看不懂的异常
  assert.equal(decodeTokenUri("ipfs://bafybeig/metadata.json"), null);
  assert.equal(decodeTokenUri("https://example.com/1.json"), null);
  assert.equal(decodeTokenUri(""), null);
});

test("token-uri: 内容坏掉 → null（非法 base64 / 非法 JSON）", () => {
  assert.equal(decodeTokenUri("data:application/json;base64,%%%not-base64%%%"), null);
  assert.equal(decodeTokenUri(encode("{oops")), null);
});

test("token-uri: JSON 不是对象 → null（数组/null/数字都算）", () => {
  // 关键用例：这些值曾经被 JSON.parse 原样返回，调用方以为拿到了元数据
  assert.equal(decodeTokenUri(encode("null")), null);
  assert.equal(decodeTokenUri(encode("123")), null);
  assert.equal(decodeTokenUri(encode('"just a string"')), null);
  assert.equal(decodeTokenUri(encode("[1,2]")), null);
});

test("token-uri: 字段类型不符或为空 → 丢弃该字段（不把坏值塞进 <img src>）", () => {
  assert.deepEqual(decodeTokenUri(encode(JSON.stringify({ name: 42, image: "" }))), {});
  // 纯空白也不行：`<img src="  ">` 会被解析成当前页面地址
  assert.deepEqual(decodeTokenUri(encode(JSON.stringify({ name: "", image: "  " }))), {});
  assert.deepEqual(decodeTokenUri(encode(JSON.stringify({}))), {});
});
