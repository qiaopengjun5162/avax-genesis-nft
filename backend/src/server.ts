/**
 * 签名服务 HTTP API（node:http 零框架）
 *
 *  GET  /              服务信息
 *  GET  /allowlist/:w  查白名单状态
 *  POST /sign          {wallet} → {wallet, imageURI, signature}
 *
 * 运行：node src/server.ts   （Node ≥23 原生跑 TS，无需构建）
 */
import { createServer } from "node:http";
import { ethers } from "ethers";
import { env } from "./env.ts";
import { CONTRACT_ADDRESS, FUJI_CHAIN_ID, FUJI_RPC, recoverSigner, signMint } from "./protocol.ts";
import { genesisArt } from "./art.ts";
import { entryFor, isAllowlisted, loadAllowlist } from "./allowlist.ts";

const PORT = Number(env.PORT ?? 8787);
const signerPk = env.SIGNER_PRIVATE_KEY;
if (!signerPk) {
  console.error("缺少 SIGNER_PRIVATE_KEY（backend/.env）");
  process.exit(1);
}
const signer = new ethers.Wallet(signerPk);
const allowlist = loadAllowlist();

console.log(`✅ GenesisMint 签名服务启动`);
console.log(`   合约    : ${CONTRACT_ADDRESS} (chainId ${FUJI_CHAIN_ID})`);
console.log(`   signer  : ${signer.address}`);
console.log(`   白名单  : ${Object.keys(allowlist).length} 个钱包`);
console.log(`   监听    : http://127.0.0.1:${PORT}`);

function send(res, code: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  // 开发期允许跨源（生产应配 CORS_ORIGIN 白名单）
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": env.CORS_ORIGIN ?? "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(data);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  // CORS 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": env.CORS_ORIGIN ?? "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  try {
    // GET / 服务信息
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, {
        service: "genesis-mint-signer",
        contract: CONTRACT_ADDRESS,
        chainId: FUJI_CHAIN_ID,
        rpc: FUJI_RPC,
        signer: signer.address,
        allowlistCount: Object.keys(allowlist).length,
        protocol: "EIP-191 over keccak(chainid, contract, wallet, imageURI)",
      });
    }

    // GET /allowlist/:wallet
    const alMatch = url.pathname.match(/^\/allowlist\/(0x[0-9a-fA-F]{40})$/);
    if (req.method === "GET" && alMatch) {
      const wallet = ethers.getAddress(alMatch[1]);
      const entry = entryFor(wallet, allowlist);
      return send(res, 200, {
        wallet,
        allowlisted: Boolean(entry),
        index: entry?.index ?? null,
      });
    }

    // POST /sign
    if (req.method === "POST" && url.pathname === "/sign") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { wallet } = JSON.parse(body || "{}");
      if (!wallet) return send(res, 400, { error: "missing wallet" });

      let addr: string;
      try {
        addr = ethers.getAddress(wallet);
      } catch {
        return send(res, 400, { error: "invalid wallet address" });
      }
      const entry = entryFor(addr, allowlist);
      if (!entry) return send(res, 403, { error: "wallet not allowlisted", wallet: addr });

      const imageURI = genesisArt(addr, entry.index);
      const signature = await signMint(signer, addr, imageURI);

      // 自检：恢复出的地址必须等于 signer
      const recovered = recoverSigner(addr, imageURI, signature);
      if (recovered !== signer.address) {
        return send(res, 500, { error: "self-check failed", recovered });
      }
      console.log(`✍️  sign ${addr} → #${entry.index} (${signature.slice(0, 18)}…)`);
      return send(res, 200, { wallet: addr, index: entry.index, imageURI, signature });
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: String(e) });
  }
});

server.listen(PORT, "127.0.0.1");
