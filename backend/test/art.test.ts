/**
 * art.ts 单测：genertArt 确定性 + data URI 格式约束
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

test("art: 同 (wallet, index) 必返回相同 data URI", async () => {
  const { genesisArt } = await import("../src/art.ts?v=" + Date.now());
  assert.equal(genesisArt(WALLET, 0), genesisArt(WALLET, 0));
});

test("art: 不同 index 输出必不同（GENESIS #N 文案不同）", async () => {
  const { genesisArt } = await import("../src/art.ts?v=" + (Date.now() + 1));
  assert.notEqual(genesisArt(WALLET, 0), genesisArt(WALLET, 1));
});

test("art: 地址大小写不敏感（统一小写输入必同输出）", async () => {
  const { genesisArt } = await import("../src/art.ts?v=" + (Date.now() + 2));
  const u = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const l = u.toLowerCase();
  assert.equal(genesisArt(u, 5), genesisArt(l, 5));
});

test("art: 返回必是 data:image/svg+xml;base64,… 格式", async () => {
  const { genesisArt } = await import("../src/art.ts?v=" + (Date.now() + 3));
  const uri = genesisArt(WALLET, 0);
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  // 解码回去应是合法 SVG
  const b64 = uri.replace(/^data:image\/svg\+xml;base64,/, "");
  const svg = Buffer.from(b64, "base64").toString("utf8");
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
});

test("art: SVG 内含 GENESIS 编号与钱包短地址", async () => {
  const { genesisArt } = await import("../src/art.ts?v=" + (Date.now() + 4));
  const svg = Buffer.from(
    genesisArt(WALLET, 42).replace(/^data:image\/svg\+xml;base64,/, ""),
    "base64",
  ).toString("utf8");
  assert.match(svg, /GENESIS #42/);
  // SVG 内嵌地址部分统一小写
  assert.match(svg, /0x7099\.\.\.79c8/);
});
