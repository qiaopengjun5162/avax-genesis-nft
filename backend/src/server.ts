/**
 * GenesisMint v3 签名服务 HTTP API（node:http 零框架）
 *
 *  GET  /              服务信息
 *  GET  /allowlist/:w  查配额（allowlisted / limit / minted）
 *  POST /sign          {wallet, imageURI?} → {wallet, imageURI, signature, minted, limit}
 *                       imageURI 可选：留空=后端自动分配创世图；填=用户自选图 URL
 *
 * 配额逻辑：链上 numberMinted(wallet) < limit 才给签（钱包可 mint 多张，无需换账户）
 *
 * 运行：node src/server.ts   （Node ≥23 原生跑 TS，无需构建）
 */
import { createServer, type IncomingMessage } from "node:http";
import { ethers } from "ethers";
import { env } from "./env.ts";
import { CONTRACT_ADDRESS, FUJI_CHAIN_ID, FUJI_RPC, recoverSigner, signMint } from "./protocol.ts";
import { genesisArt } from "./art.ts";
import { entryFor, isAllowlisted, loadAllowlist } from "./allowlist.ts";
import { numberMintedOnChain, totalSupplyOnChain } from "./chain.ts";

const PORT = Number(env.PORT ?? 8787);

/**
 * /sign 只需要 {wallet, imageURI}，几 KB 绰绰有余。
 * 不设上限等于任何人都能拿超大 body 把进程内存吃满。
 */
const MAX_BODY_BYTES = 8 * 1024;

class BodyTooLarge extends Error {}
const signerPk = env.SIGNER_PRIVATE_KEY;
if (!signerPk) {
  console.error("缺少 SIGNER_PRIVATE_KEY（backend/.env）");
  process.exit(1);
}
const signer = new ethers.Wallet(signerPk);
const allowlist = loadAllowlist();

console.log(`✅ GenesisMint v3 签名服务启动`);
console.log(`   合约    : ${CONTRACT_ADDRESS} (chainId ${FUJI_CHAIN_ID})`);
console.log(`   signer  : ${signer.address}`);
console.log(`   白名单  : ${Object.keys(allowlist).length} 个钱包（配额制，可多次 mint）`);
console.log(`   监听    : http://127.0.0.1:${PORT}`);

const CORS = {
  "access-control-allow-origin": env.CORS_ORIGIN ?? "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function send(res, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...CORS });
  res.end(JSON.stringify(body, null, 2));
}

/** 读请求体并卡死上限：超限立刻断开，不继续收完剩下的字节 */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw new BodyTooLarge();
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 用户自选图校验：http(s)/ipfs/data 开头 + 长度上限 */
function validUserImage(uri: string): boolean {
  return (
    uri.length >= 8 &&
    uri.length <= 500 &&
    /^(https?:\/\/|ipfs:\/\/|data:image\/)/i.test(uri)
  );
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  try {
    // GET / 服务信息
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, {
        service: "genesis-mint-signer",
        contract: CONTRACT_ADDRESS,
        chainId: FUJI_CHAIN_ID,
        signer: signer.address,
        allowlistCount: Object.keys(allowlist).length,
        protocol: "EIP-191 over keccak(chainid, contract, wallet, imageURI)，每签名一次有效",
      });
    }

    // GET /allowlist/:wallet —— 前端预检配额
    const alMatch = url.pathname.match(/^\/allowlist\/(0x[0-9a-fA-F]{40})$/);
    if (req.method === "GET" && alMatch) {
      const wallet = ethers.getAddress(alMatch[1]);
      const entry = entryFor(wallet, allowlist);
      const minted = entry ? await numberMintedOnChain(wallet) : 0;
      return send(res, 200, {
        wallet,
        allowlisted: Boolean(entry),
        limit: entry?.limit ?? 0,
        minted,
        remaining: entry ? Math.max(0, entry.limit - minted) : 0,
      });
    }

    // POST /sign
    if (req.method === "POST" && url.pathname === "/sign") {
      const body = await readBody(req);
      const { wallet, imageURI } = JSON.parse(body || "{}");
      if (!wallet) return send(res, 400, { error: "missing wallet" });

      let addr: string;
      try {
        addr = ethers.getAddress(wallet);
      } catch {
        return send(res, 400, { error: "invalid wallet address" });
      }

      const entry = entryFor(addr, allowlist);
      if (!entry) return send(res, 403, { error: "钱包不在白名单", wallet: addr });

      const minted = await numberMintedOnChain(addr);
      if (minted >= entry.limit) {
        return send(res, 403, {
          error: `配额已用完（${minted}/${entry.limit}）`,
          wallet: addr,
          minted,
          limit: entry.limit,
        });
      }

      // 图：用户自选 or 后端按下一 tokenId 分配创世图（全局唯一序号）
      let finalUri = imageURI;
      if (imageURI !== undefined) {
        if (typeof imageURI !== "string" || !validUserImage(imageURI)) {
          return send(res, 400, { error: "imageURI 非法：需 http(s)/ipfs/data:image 开头且 ≤500 字符" });
        }
      } else {
        const next = await totalSupplyOnChain();
        finalUri = genesisArt(addr, next);
      }

      const signature = await signMint(signer, addr, finalUri);
      const recovered = recoverSigner(addr, finalUri, signature);
      if (recovered !== signer.address) {
        return send(res, 500, { error: "self-check failed" });
      }
      console.log(`✍️  sign ${addr.slice(0, 8)}… (${minted + 1}/${entry.limit}) 图=${finalUri.slice(0, 30)}…`);
      return send(res, 200, {
        wallet: addr,
        minted,
        limit: entry.limit,
        remaining: entry.limit - minted - 1,
        imageURI: finalUri,
        signature,
      });
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof BodyTooLarge) {
      return send(res, 413, { error: `body 超过 ${MAX_BODY_BYTES} 字节` });
    }
    // 前端传了坏 JSON → 客户端错误，不该记成 500
    if (e instanceof SyntaxError) {
      return send(res, 400, { error: "body 不是合法 JSON" });
    }
    return send(res, 500, { error: String(e) });
  }
});

server.listen(PORT, "127.0.0.1");
