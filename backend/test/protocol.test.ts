/**
 * protocol.ts 单测：signMint ↔ recoverSigner 端到端 + buildInnerHash 格式
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";

test("protocol: buildInnerHash 跨 (chainId, contract, wallet, imageURI) 不同必不同", async () => {
  const { buildInnerHash } = await import("../src/protocol.ts?v=" + Date.now());
  const wallet = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const base = buildInnerHash(wallet, "ipfs://x");
  assert.notEqual(
    ethers.hexlify(base),
    ethers.hexlify(buildInnerHash(wallet, "ipfs://y")),
    "图不同必不同",
  );
  assert.notEqual(
    ethers.hexlify(base),
    ethers.hexlify(buildInnerHash("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "ipfs://x")),
    "钱包不同必不同",
  );
  // 默认参数 chainId=FUJI、contract=DEMO，可显式换
  assert.notEqual(
    ethers.hexlify(base),
    ethers.hexlify(buildInnerHash(wallet, "ipfs://x", undefined, 1)),
    "换 chainId 必不同",
  );
});

test("protocol: signMint + recoverSigner roundtrip（同钱包同图同一 signer）", async () => {
  const { signMint, recoverSigner } = await import("../src/protocol.ts?v=" + (Date.now() + 1));
  const wallet = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const signer = new ethers.Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  const sig = await signMint(signer, wallet, "ipfs://bafy...");
  assert.equal(recoverSigner(wallet, "ipfs://bafy...", sig), signer.address);
});

test("protocol: 改一个字节就恢复失败（签名绑定性强）", async () => {
  const { signMint, recoverSigner } = await import("../src/protocol.ts?v=" + (Date.now() + 2));
  const wallet = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const signer = new ethers.Wallet(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  const sig = await signMint(signer, wallet, "ipfs://bafy...");
  // 改图后恢复出来的应不再是 signer
  assert.notEqual(
    recoverSigner(wallet, "ipfs://DIFFERENT", sig),
    signer.address,
  );
  // 改钱包也应失败
  assert.notEqual(
    recoverSigner("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "ipfs://bafy...", sig),
    signer.address,
  );
});
