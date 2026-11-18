/**
 * 图片 URL 归一化的测试。
 *
 * 背景：后端允许用户用 `ipfs://` 作为 imageURI，合约原样存。浏览器不认这个
 * scheme，直接渲染就是破图——用户会以为 NFT 的图丢了。这类问题不会报错，
 * 只会「看起来没图」，所以用测试把三种前缀都钉住。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveImageUrl } from "../lib/media.ts";

test("media: http(s) 与 data URI 原样返回", () => {
  assert.equal(resolveImageUrl("https://example.com/a.png"), "https://example.com/a.png");
  assert.equal(resolveImageUrl("data:image/svg+xml;base64,AAAA"), "data:image/svg+xml;base64,AAAA");
});

test("media: ipfs:// 走网关（浏览器不认 ipfs://）", () => {
  assert.equal(
    resolveImageUrl("ipfs://bafybeigdyrzt/1.png"),
    "https://ipfs.io/ipfs/bafybeigdyrzt/1.png",
  );
});

test("media: ipfs://ipfs/<cid> 的双重前缀不会重复", () => {
  // 两种写法在 NFT 元数据里都常见
  assert.equal(resolveImageUrl("ipfs://ipfs/QmAbc/2.png"), "https://ipfs.io/ipfs/QmAbc/2.png");
});

test("media: 自定义网关（含尾斜杠也不会拼出 //）", () => {
  const gw = "https://gw.example.com/ipfs/";
  assert.equal(resolveImageUrl("ipfs://QmX/3.png", gw), "https://gw.example.com/ipfs/QmX/3.png");
  // 空串网关 → 回落默认，而不是拼出 "/QmX"
  assert.equal(resolveImageUrl("ipfs://QmX", ""), "https://ipfs.io/ipfs/QmX");
});

test("media: 大小写不敏感", () => {
  assert.equal(resolveImageUrl("IPFS://QmX"), "https://ipfs.io/ipfs/QmX");
});

test("media: 空值 / 只有前缀 → undefined（渲染占位，不请求网关首页）", () => {
  assert.equal(resolveImageUrl(undefined), undefined);
  assert.equal(resolveImageUrl(""), undefined);
  assert.equal(resolveImageUrl("   "), undefined);
  assert.equal(resolveImageUrl("ipfs://"), undefined);
  assert.equal(resolveImageUrl("ipfs://ipfs/"), undefined);
});

test("media: 前后空白被去掉（元数据里手写空格很常见）", () => {
  assert.equal(resolveImageUrl("  https://e.x/a.png  "), "https://e.x/a.png");
});
