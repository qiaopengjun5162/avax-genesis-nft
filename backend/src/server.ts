/**
 * GenesisMint v3 签名服务 HTTP API（node:http 零框架）
 *
 *  GET  /              服务信息
 *  GET  /healthz       就绪探针（容器/进程管理器用，无鉴权）
 *  GET  /allowlist/:w  查配额（allowlisted / limit / minted）
 *  POST /sign          {wallet, imageURI?} → {wallet, imageURI, signature, minted, limit}
 *                       imageURI 可选：留空=后端自动分配创世图；填=用户自选图 URL
 *
 * 配额逻辑：链上 numberMinted(wallet) < limit 才给签（钱包可 mint 多张，无需换账户）
 *
 * 运行：node src/server.ts   （Node ≥22，需 --experimental-strip-types，见 package.json start）
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { env } from "./env.ts";
import { CONTRACT_ADDRESS, FUJI_CHAIN_ID, FUJI_RPC, recoverSigner, signMint } from "./protocol.ts";
import { genesisArt } from "./art.ts";
import { entryFor, loadAllowlist, type Allowlist } from "./allowlist.ts";
import { numberMintedOnChain, signerOnChain, totalSupplyOnChain } from "./chain.ts";
import { RateLimiter, clientIp } from "./ratelimit.ts";

const PORT = Number(env.PORT ?? 8787);

/**
 * 仅当该文件被「直接执行」（而非被 import 进测试）时才启动监听与自检，
 * 避免单测一 import 就把端口绑了 / 因缺密钥退出进程。
 */
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

/**
 * /sign 只需要 {wallet, imageURI}，几 KB 绰绰有余。
 * 不设上限等于任何人都能拿超大 body 把进程内存吃满。
 */
const MAX_BODY_BYTES = 8 * 1024;

class BodyTooLarge extends Error {}

const signerPk = env.SIGNER_PRIVATE_KEY;
let signer: ethers.Wallet | null = null;
if (signerPk) {
  signer = new ethers.Wallet(signerPk);
} else if (isMain) {
  // 真实运行缺密钥：直接失败，比「起来了但签名全被拒」好排查
  console.error("缺少 SIGNER_PRIVATE_KEY（backend/.env）");
  process.exit(1);
}
let allowlist = loadAllowlist();

/**
 * 匿名端点限流（防 RPC/CPU DoS）。阈值走 .env，缺省：
 *  - /sign       每 IP 60s 内 30 次（签名要读链上 + 可能签名，重）
 *  - /allowlist  每 IP 60s 内 60 次（只读，轻一些）
 * 多副本部署需把这套迁到 Redis，否则各进程独立计数。
 */
const SIGN_WINDOW_MS = Number(env.SIGN_RATE_WINDOW_MS ?? 60_000);
const signLimiter = new RateLimiter(Number(env.SIGN_RATE_LIMIT ?? 30), SIGN_WINDOW_MS);
const allowlistLimiter = new RateLimiter(Number(env.ALLOWLIST_RATE_LIMIT ?? 60), SIGN_WINDOW_MS);

/** 签名有效窗口（秒）：防永久有效签名，用户须在此窗口内完成 mint */
const SIGN_DEADLINE_SECONDS = Number(env.SIGN_DEADLINE_SECONDS ?? 3600);

function tooMany(res: ServerResponse, limiter: RateLimiter, ip: string) {
  const r = limiter.hit(ip);
  if (r.allowed) return false;
  send(res, 429, { error: "请求过于频繁，请稍后再试" }, { "retry-after": String(r.retryAfterSec) });
  return true;
}

/** SIGHUP 热加载白名单：改配额不必重启服务 */
function reloadAllowlist() {
  allowlist = loadAllowlist();
  console.log(`🔄 白名单已重载：${Object.keys(allowlist).length} 个钱包`);
}

const CORS = {
  "access-control-allow-origin": env.CORS_ORIGIN ?? "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function send(res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...CORS, ...extra });
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

/**
 * 就绪探针用的 RPC 健康度：3s 超时 + 15s 缓存，避免被高频探针反复打 RPC。
 * RPC 不通返回 degraded，但服务仍存活（与启动自检的降级策略一致）。
 */
let rpcHealthCache: { at: number; reachable: boolean; blockNumber: number | null } | null = null;
async function rpcHealth(): Promise<{ reachable: boolean; blockNumber: number | null }> {
  const now = Date.now();
  if (rpcHealthCache && now - rpcHealthCache.at < 15_000) return rpcHealthCache;
  let reachable = false;
  let blockNumber: number | null = null;
  try {
    const provider = new ethers.JsonRpcProvider(FUJI_RPC);
    blockNumber = await Promise.race([
      provider.getBlockNumber(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("rpc timeout")), 3000)),
    ]);
    reachable = true;
  } catch {
    /* RPC 不通：服务仍存活，标记为 degraded */
  }
  rpcHealthCache = { at: now, reachable, blockNumber };
  return rpcHealthCache;
}

/** HTTP 请求处理（抽成可导出函数，便于不绑端口直接单测） */
export type HandlerDeps = {
  /** 注入链上配额读取（默认 = 真链读）；null 返回触发 fail-closed */
  numberMintedOnChain?: (wallet: string) => Promise<number | null>;
  /** 注入白名单（默认 = 模块级，支持 SIGHUP 热重载） */
  allowlist?: Allowlist;
  /** 注入签名钱包（默认 = 模块级 SIGNER_PRIVATE_KEY 派生） */
  signer?: ethers.Wallet | null;
};

export async function handler(req: IncomingMessage, res: ServerResponse, deps: HandlerDeps = {}) {
  const _numMinted = deps.numberMintedOnChain ?? numberMintedOnChain;
  const _allowlist = deps.allowlist ?? allowlist;
  // deps.signer 未传 → 用模块级；显式传 null → 视为未配置（便于测 503 分支）
  const _signer = deps.signer === undefined ? signer : deps.signer;
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
        signer: signer?.address ?? null,
        allowlistCount: Object.keys(allowlist).length,
        protocol: "EIP-191 over keccak(chainid, contract, wallet, imageURI, deadline)，每签名一次有效 + 1h 过期",
      });
    }

    // GET /healthz 就绪探针（无鉴权）
    if (req.method === "GET" && url.pathname === "/healthz") {
      const h = await rpcHealth();
      return send(res, 200, {
        ok: true,
        status: !signer ? "degraded" : h.reachable ? "ok" : "degraded",
        service: "genesis-mint-signer",
        contract: CONTRACT_ADDRESS,
        chainId: FUJI_CHAIN_ID,
        signer: signer?.address ?? null,
        rpc: { reachable: h.reachable, blockNumber: h.blockNumber },
        uptimeSec: Math.round(process.uptime()),
      });
    }

    // GET /allowlist/:wallet —— 前端预检配额
    const alMatch = url.pathname.match(/^\/allowlist\/(0x[0-9a-fA-F]{40})$/);
    if (req.method === "GET" && alMatch) {
      if (tooMany(res, allowlistLimiter, clientIp(req))) return;
      const wallet = ethers.getAddress(alMatch[1]);
      const entry = entryFor(wallet, _allowlist);
      // 不在白名单 → minted/remaining=0；有配额但 RPC 不可达 → null（前端按"未知"处理）
      let mintedOut: number | null;
      let remainingOut: number | null;
      if (!entry) {
        mintedOut = 0;
        remainingOut = 0;
      } else {
        const m = await _numMinted(wallet);
        if (m === null) {
          mintedOut = null;
          remainingOut = null;
        } else {
          mintedOut = m;
          remainingOut = Math.max(0, entry.limit - m);
        }
      }
      return send(res, 200, {
        wallet,
        allowlisted: Boolean(entry),
        limit: entry?.limit ?? 0,
        minted: mintedOut,
        remaining: remainingOut,
      });
    }

    // POST /sign
    if (req.method === "POST" && url.pathname === "/sign") {
      if (tooMany(res, signLimiter, clientIp(req))) return;
      if (!_signer) {
        return send(res, 503, { error: "signer 未配置（缺 SIGNER_PRIVATE_KEY）" });
      }
      const body = await readBody(req);
      const { wallet, imageURI } = JSON.parse(body || "{}");
      if (!wallet) return send(res, 400, { error: "missing wallet" });

      let addr: string;
      try {
        addr = ethers.getAddress(wallet);
      } catch {
        return send(res, 400, { error: "invalid wallet address" });
      }

      const entry = entryFor(addr, _allowlist);
      if (!entry) return send(res, 403, { error: "钱包不在白名单", wallet: addr });

      // fail-closed：RPC 不可达 → minted 未知，宁可拒签也不要越权签发
      // （合约 v3 没有 per-wallet 硬上限，配额全靠后端签名把关）
      const minted = await _numMinted(addr);
      if (minted === null) {
        return send(res, 503, { error: "链上配额核验失败（RPC 不可达），请稍后重试" });
      }
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

      const deadline = Math.floor(Date.now() / 1000) + SIGN_DEADLINE_SECONDS;
      const signature = await signMint(_signer, addr, finalUri, deadline);
      const recovered = recoverSigner(addr, finalUri, deadline, signature);
      if (recovered !== _signer.address) {
        return send(res, 500, { error: "self-check failed" });
      }
      console.log(`✍️  sign ${addr.slice(0, 8)}… (${minted + 1}/${entry.limit}) 图=${finalUri.slice(0, 30)}…`);
      return send(res, 200, {
        wallet: addr,
        minted,
        limit: entry.limit,
        remaining: entry.limit - minted - 1,
        imageURI: finalUri,
        deadline,
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
}

/** 启动自检：本服务私钥 ↔ 链上 signer，对不上当场告警（最隐蔽故障） */
async function selfCheck() {
  const onChain = await signerOnChain();
  if (!onChain) {
    console.warn("⚠️  读不到链上 signer（RPC 不通 / CONTRACT_ADDRESS 不对）");
    return;
  }
  if (onChain.toLowerCase() === signer!.address.toLowerCase()) {
    console.log(`   signer 自检: 与链上一致 ✅`);
    return;
  }
  console.warn("⚠️  signer 不一致：链上=" + onChain + "，本服务=" + signer!.address);
  console.warn("   这样签出的名会被合约拒绝。用 owner 调 setSigner(本服务地址)，或换 SIGNER_PRIVATE_KEY。");
}

if (isMain && signer) {
  console.log(`✅ GenesisMint v3 签名服务启动`);
  console.log(`   合约    : ${CONTRACT_ADDRESS} (chainId ${FUJI_CHAIN_ID})`);
  console.log(`   signer  : ${signer.address}`);
  console.log(`   白名单  : ${Object.keys(allowlist).length} 个钱包（配额制，可多次 mint）`);
  console.log(`   监听    : http://127.0.0.1:${PORT}`);
  if (Object.keys(allowlist).length === 0) {
    console.warn("⚠️  白名单为空：backend/data/allowlist.json 缺失或内容为空，所有 /sign 都会返回 403");
  }
  void selfCheck();

  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(PORT, "127.0.0.1");

  // SIGHUP：热加载白名单，改配额不用重启（kill -HUP <pid>）
  process.on("SIGHUP", reloadAllowlist);

  // 优雅关闭：容器滚动更新 / Ctrl-C 时先停收新连接，等在途请求处理完
  // 再退出——否则会掐断正在进行的 /sign。加超时兜底，避免有连接挂死
  // 导致进程永远退不掉。
  const SHUTDOWN_GRACE_MS = 10_000;
  let shuttingDown = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n收到 ${sig}：停止接收新请求，等待在途请求结束…`);
      server.close(() => {
        console.log("已优雅关闭");
        process.exit(0);
      });
      setTimeout(() => {
        console.warn(`等待超过 ${SHUTDOWN_GRACE_MS}ms，强制退出`);
        process.exit(1);
      }, SHUTDOWN_GRACE_MS).unref();
    });
  }
}
