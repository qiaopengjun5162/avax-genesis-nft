/**
 * protocol.ts 单测：signMint ↔ recoverSigner 端到端 + buildInnerHash 格式
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";

const WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const OTHER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

test("protocol: buildInnerHash 跨 (chainId, contract, wallet, imageURI, deadline) 不同必不同", async () => {
  const { buildInnerHash } = await import("../src/protocol.ts?v=" + Date.now());
  const base = buildInnerHash(WALLET, "ipfs://x", 1000);
  assert.notEqual(ethers.hexlify(base), ethers.hexlify(buildInnerHash(WALLET, "ipfs://y", 1000)), "图不同必不同");
  assert.notEqual(ethers.hexlify(base), ethers.hexlify(buildInnerHash(OTHER, "ipfs://x", 1000)), "钱包不同必不同");
  assert.notEqual(ethers.hexlify(base), ethers.hexlify(buildInnerHash(WALLET, "ipfs://x", 1001)), "deadline 不同必不同");
  // 默认参数 chainId=FUJI、contract=DEMO，可显式换
  assert.notEqual(ethers.hexlify(base), ethers.hexlify(buildInnerHash(WALLET, "ipfs://x", 1000, undefined, 1)), "换 chainId 必不同");
});

test("protocol: signMint + recoverSigner roundtrip（含 deadline）", async () => {
  const { signMint, recoverSigner } = await import("../src/protocol.ts?v=" + (Date.now() + 1));
  const signer = new ethers.Wallet(PK);
  const sig = await signMint(signer, WALLET, "ipfs://bafy...", 1700000000);
  assert.equal(recoverSigner(WALLET, "ipfs://bafy...", 1700000000, sig), signer.address);
});

test("protocol: 改一个维度就恢复失败（签名绑定性强）", async () => {
  const { signMint, recoverSigner } = await import("../src/protocol.ts?v=" + (Date.now() + 2));
  const signer = new ethers.Wallet(PK);
  const sig = await signMint(signer, WALLET, "ipfs://bafy...", 1700000000);
  assert.notEqual(recoverSigner(WALLET, "ipfs://DIFFERENT", 1700000000, sig), signer.address, "改图应失败");
  assert.notEqual(recoverSigner(OTHER, "ipfs://bafy...", 1700000000, sig), signer.address, "改钱包应失败");
  assert.notEqual(recoverSigner(WALLET, "ipfs://bafy...", 1700000001, sig), signer.address, "改 deadline 应失败");
});
