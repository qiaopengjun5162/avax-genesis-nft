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
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { env } from "./env.ts";
import { CONTRACT_ADDRESS, FUJI_CHAIN_ID, FUJI_RPC, recoverSigner, signMint } from "./protocol.ts";
import { genesisArt } from "./art.ts";
import { entryFor, isExpired, loadAllowlist, type Allowlist } from "./allowlist.ts";
import { numberMintedOnChain, signerOnChain, totalSupplyOnChain } from "./chain.ts";
import { RateLimiter, clientIp } from "./ratelimit.ts";
import { InflightSlots, KeyedLock } from "./inflight.ts";

const PORT = numEnv("PORT", 8787, { min: 1, max: 65535 });

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
const SIGN_WINDOW_MS = numEnv("SIGN_RATE_WINDOW_MS", 60_000, { min: 1000 });
const signLimiter = new RateLimiter(numEnv("SIGN_RATE_LIMIT", 30, { min: 1 }), SIGN_WINDOW_MS);
const allowlistLimiter = new RateLimiter(numEnv("ALLOWLIST_RATE_LIMIT", 60, { min: 1 }), SIGN_WINDOW_MS);

/**
 * 读整数环境变量并卡住合法范围。
 *
 * 为什么要自检：env 直接喂给 Number() 的话，配成 0 / 负数 / 非数字会被
 * 转成 0 / NaN——这俩对 SIGN_DEADLINE_SECONDS 是灾难：
 *  - 0 → deadline = now → 用户提交就吃 SignatureExpired
 *  - 负数 → deadline = 1970 → 永远过期
 *  - NaN → 上面两种之一
 *  限流阈值同理：配 0 = 所有人立刻 429。
 *
 * 策略：非法回默认 + warn。宁可让「配错」的服务用上安全值，**也不**让服务
 * 用「看起来在跑但所有请求都被拒」的状态——后者没报错却没服务，最难排查。
 */
/**
 * export 仅供单测：source 参数让它能脱离真实 env 跑断言。
 * 业务调用走默认（=模块级 env）。
 */
export function numEnv(
  key: string,
  fallback: number,
  opts: { min?: number; max?: number } = {},
  source: Record<string, string> = env,
): number {
  const raw = source[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < (opts.min ?? -Infinity) || n > (opts.max ?? Infinity)) {
    if (isMain) {
      console.warn(
        `⚠️  ${key}=${JSON.stringify(raw)} 非法（需 ${opts.min ?? "-∞"}..${opts.max ?? "+∞"} 有限数）` +
          `，回退为 ${fallback}`,
      );
    }
    return fallback;
  }
  return n;
}

/** 签名有效窗口（秒）：防永久有效签名，用户须在此窗口内完成 mint */
const SIGN_DEADLINE_SECONDS = numEnv("SIGN_DEADLINE_SECONDS", 3600, { min: 1, max: 365 * 24 * 3600 });

function tooMany(req: IncomingMessage, res: ServerResponse, limiter: RateLimiter, ip: string) {
  const r = limiter.hit(ip);
  if (r.allowed) return false;
  send(req, res, 429, { error: "请求过于频繁，请稍后再试" }, { "retry-after": String(r.retryAfterSec) });
  return true;
}

/** SIGHUP 热加载白名单：改配额不必重启服务 */
function reloadAllowlist() {
  allowlist = loadAllowlist();
  console.log(`🔄 白名单已重载：${Object.keys(allowlist).length} 个钱包`);
}

const CORS_METHODS = {
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

/**
 * 允许的前端来源（逗号分隔）。留空 = 不限制（回显 *），本地开发方便。
 * 一旦配置，就**只**对命中的 origin 回显 ACAO，其余一律不发这个头
 * ——浏览器因此会拦掉响应，第三方站点读不到白名单/签名结果。
 */
const CORS_ALLOWED: string[] = (env.CORS_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

/**
 * 按请求 origin 计算 CORS 响应头。
 * Vary: Origin 必须带——否则 CDN/浏览器缓存会把给 A 站的响应（含它的
 * ACAO）发给 B 站，要么串味要么直接被拦。
 */
export function corsHeaders(
  req: IncomingMessage,
  allowed: string[] = CORS_ALLOWED,
): Record<string, string> {
  if (allowed.length === 0) {
    return { ...CORS_METHODS, "access-control-allow-origin": "*", vary: "Origin" };
  }
  const origin = String(req.headers.origin ?? "").replace(/\/$/, "");
  if (origin && allowed.includes(origin)) {
    return { ...CORS_METHODS, "access-control-allow-origin": origin, vary: "Origin" };
  }
  // 来源不在白名单：不发 ACAO，浏览器侧自行拦截
  return { ...CORS_METHODS, vary: "Origin" };
}

/** 请求开始时间（WeakMap：请求对象回收即释放，不会随请求数膨胀） */
const reqStart = new WeakMap<IncomingMessage, number>();

/** 访问日志开关（默认开；设 ACCESS_LOG=0 关） */
const ACCESS_LOG = !/^(0|false|no|off)$/i.test(env.ACCESS_LOG ?? "1");

/**
 * 一行 JSON 一条请求：排障时最想要的四件套 method/path/status/ms，
 * 加上 ip 与裁剪过的 UA（看得出是脚本在刷还是真人在点）。
 * 4xx/5xx 不额外打堆栈——那是 error 日志的活，这里只留可聚合的结构。
 */
export function formatAccessLog(req: IncomingMessage, code: number, ms: number) {
  return {
    t: new Date().toISOString(),
    method: req.method ?? "-",
    // 去掉 query：里面可能带签名/图片参数，日志里没必要留
    path: (req.url ?? "/").split("?")[0],
    status: code,
    ms,
    ip: clientIp(req, { trustProxy: TRUST_PROXY }),
    ua: String(req.headers["user-agent"] ?? "").slice(0, 120),
  };
}

function accessLog(req: IncomingMessage, code: number) {
  // 只在真实服务进程里打：单测 import 进来不该刷屏
  if (!ACCESS_LOG || !isMain) return;
  console.log(JSON.stringify(formatAccessLog(req, code, Date.now() - (reqStart.get(req) ?? Date.now()))));
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  code: number,
  body: unknown,
  extra: Record<string, string> = {},
) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(req),
    ...extra,
  });
  res.end(JSON.stringify(body, null, 2));
  accessLog(req, code);
}

/**
 * 读请求体并卡死上限：超限立刻停收。
 * 注意不能在这里 destroy —— 一销毁 socket，后面写的 413 就发不出去了，
 * 客户端只看到连接被掐断（curl: empty reply）。改成抛错由 catch 统一处理：
 * 先把 413 写完，再排空剩余字节。
 */
export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLarge();
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
 *
 * provider 用**单例**：每调一次 new 一个 JsonRpcProvider 等于开一条连接池，
 * 15s 缓存未命中就泄漏一条——长跑之后 fd / 连接慢慢堆积，最终拖垮进程。
 * 复用同一个实例，连接池归它管、能被复用与复用后回收。
 */
let rpcHealthCache: { provider: unknown; at: number; reachable: boolean; blockNumber: number | null } | null = null;
const rpcHealthProvider = new ethers.JsonRpcProvider(FUJI_RPC);

/** 注入 provider 仅用于单测：默认 = 模块级单例（真链） */
export async function rpcHealth(
  provider: { getBlockNumber: () => Promise<number> } = rpcHealthProvider,
): Promise<{ reachable: boolean; blockNumber: number | null }> {
  const now = Date.now();
  // 同 provider 且在窗口内才命中缓存——注入测试 provider 时不会被真链结果串味
  if (rpcHealthCache && rpcHealthCache.provider === provider && now - rpcHealthCache.at < 15_000) {
    return rpcHealthCache;
  }
  let reachable = false;
  let blockNumber: number | null = null;
  try {
    blockNumber = await Promise.race([
      provider.getBlockNumber(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("rpc timeout")), 3000)),
    ]);
    reachable = true;
  } catch {
    /* RPC 不通：服务仍存活，标记为 degraded */
  }
  rpcHealthCache = { provider, at: now, reachable, blockNumber };
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
  /** 注入总供给读取（默认 = 真链读；null = RPC 不可达，测试用它隔离链上状态） */
  totalSupplyOnChain?: () => Promise<number | null>;
  /** 注入 in-flight 槽位（默认 = 模块级；测试用它隔离并发状态） */
  inflight?: InflightSlots;
  /** 注入按钱包串行的锁（默认 = 模块级） */
  locks?: KeyedLock;
};

/** 已签发未上链的签名槽位：防并发突破配额（见 inflight.ts） */
const inflight = new InflightSlots();
/** 同钱包 /sign 排队执行，避免并发请求同时占位后互相误判 */
const locks = new KeyedLock();

/**
 * 图序号水位线的落盘位置。为什么要落盘：水位线只活在内存里的话，重启就
 * 归零，而此时链上 totalSupply 可能还没变（上一张还没上链）→ 又算出同一
 * 个序号 → 同一张图。合约 usedHashes 的键含 deadline，新签名 deadline
 * 不同，去重挡不住 → 同一个钱包真能铸出两张一模一样的 NFT。
 */
const ART_INDEX_FILE = resolve(import.meta.dirname, "../data/.art-index");

/** 读回水位线；文件缺失 / 内容不可信 → -1（当作从没发过，与首次启动等价） */
export function loadArtIndex(path: string = ART_INDEX_FILE): number {
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : -1;
  } catch {
    return -1;
  }
}

/**
 * 落盘水位线。写失败只 warn：图序号重复是「铸出重复图」，服务不该因此挂掉。
 *
 * 用「临时文件 + rename」原子替换：rename 在同一文件系统上是原子操作，
 * 不会出现「写到一半被 kill → 文件里是半截数字 → 重启读回 -1 → 重发旧图」
 * 的情况。先落盘到 .tmp，再 rename 覆盖正式文件。
 */
export function persistArtIndex(n: number, path: string = ART_INDEX_FILE): void {
  try {
    writeFileSync(`${path}.tmp`, String(n));
    renameSync(`${path}.tmp`, path);
  } catch (e) {
    console.warn(`⚠️  图序号水位线落盘失败，重启后可能重复发图：${(e as Error).message}`);
  }
}

/** 已分配过的最大图序号（水位线，只增不减）。测试里恒定从 -1 开始，不碰磁盘 */
let lastArtIndex = isMain ? loadArtIndex() : -1;

/**
 * 下一个创世图序号。
 *
 * 不能直接用 totalSupply：同一钱包在第一张上链之前再签一次，链上
 * totalSupply 还没变，两次会算出同一个序号 → genesisArt(钱包, 序号)
 * 完全相同 → 同一张 data URI，铸出来就是两张一模一样的 NFT。
 *
 * 取 max(链上总量, 水位线+1)：既跟得上链上进度，又保证本进程内严格递增；
 * 水位线落盘，重启后也不会退回去。
 */
export function nextArtIndex(totalSupply: number): number {
  const next = Math.max(totalSupply, lastArtIndex + 1);
  if (next !== lastArtIndex) {
    lastArtIndex = next;
    if (isMain) persistArtIndex(next);
  }
  return next;
}

/** 测试用：把水位线归零 */
export function resetArtIndex(): void {
  lastArtIndex = -1;
}

/**
 * 链上读取的兜底超时。没有它，RPC 挂起会把请求吊住——
 * 现在还多了一层影响：同钱包的锁会被一直占着，后续 /sign 全排队等死。
 * 超时 → null → 走既有的 fail-closed 分支（503）。
 */
const RPC_QUERY_TIMEOUT_MS = numEnv("RPC_QUERY_TIMEOUT_MS", 8000, { min: 100 });

/**
 * 是否信任反向代理带来的 X-Forwarded-For。默认 false：限流键只认真实
 * TCP 对端（伪造不了）。部署在 Nginx / LB 后面必须设 TRUST_PROXY=1，
 * 否则所有请求会被算成同一个 IP（一人触发限流，全场 429）。
 */
const TRUST_PROXY = /^(1|true|yes|on)$/i.test(env.TRUST_PROXY ?? "");

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), ms);
        // 别让定时器把进程拖住不退出
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function handler(req: IncomingMessage, res: ServerResponse, deps: HandlerDeps = {}) {
  const _numMinted = deps.numberMintedOnChain ?? numberMintedOnChain;
  const _allowlist = deps.allowlist ?? allowlist;
  // deps.signer 未传 → 用模块级；显式传 null → 视为未配置（便于测 503 分支）
  const _signer = deps.signer === undefined ? signer : deps.signer;
  const _inflight = deps.inflight ?? inflight;
  const _locks = deps.locks ?? locks;
  const _totalSupply = deps.totalSupplyOnChain ?? totalSupplyOnChain;
  reqStart.set(req, Date.now());

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    res.end();
    accessLog(req, 204);
    return;
  }

  // 畸形 / 伪造的 Host（如 "a b"）会让 new URL 抛 TypeError。它原本在 try
  // 之外，一抛错 handler 就 reject → 未处理的 promise rejection + 请求挂死
  // 到客户端超时。Host 是客户端可控输入，属客户端错误（400），不该拖垮请求。
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    return send(req, res, 400, { error: "invalid request URL" });
  }

  try {
    // GET / 服务信息
    if (req.method === "GET" && url.pathname === "/") {
      return send(req, res, 200, {
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
      return send(req, res, 200, {
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
      if (tooMany(req, res, allowlistLimiter, clientIp(req, { trustProxy: TRUST_PROXY }))) return;
      // 与 /sign 同一套校验：混合大小写且 checksum 对不上时 getAddress 会抛，
      // 不接住就成了 500——客户端错误被报成服务端错误，还白扣一次限流额度。
      let wallet: string;
      try {
        wallet = ethers.getAddress(alMatch[1]);
      } catch {
        return send(req, res, 400, { error: "invalid wallet address" });
      }
      const entry = entryFor(wallet, _allowlist);
      const expired = isExpired(entry);
      // 不在白名单 → minted/remaining=0；有配额但 RPC 不可达 → null（前端按"未知"处理）
      let mintedOut: number | null = 0;
      let remainingOut: number | null = 0;
      let pendingOut = 0;
      if (entry && !expired) {
        // 与 /sign 同一套口径：已铸 + 已签未上链 都算占用。
        // 否则前端会显示 remaining=3，用户点下去却吃 403（有签名在飞）。
        pendingOut = _inflight.count(wallet);
        const m = await _numMinted(wallet);
        if (m === null) {
          mintedOut = null;
          remainingOut = null;
        } else {
          mintedOut = m;
          remainingOut = Math.max(0, entry.limit - m - pendingOut);
        }
      }
      return send(req, res, 200, {
        wallet,
        allowlisted: Boolean(entry) && !expired,
        expired,
        expiresAt: entry?.expiresAt ?? null,
        limit: entry?.limit ?? 0,
        minted: mintedOut,
        remaining: remainingOut,
        // 已签发但还没上链的张数：前端可提示"有 N 张签名待上链"
        pending: pendingOut,
      });
    }

    // POST /sign
    if (req.method === "POST" && url.pathname === "/sign") {
      if (tooMany(req, res, signLimiter, clientIp(req, { trustProxy: TRUST_PROXY }))) return;
      if (!_signer) {
        return send(req, res, 503, { error: "signer 未配置（缺 SIGNER_PRIVATE_KEY）" });
      }
      const body = await readBody(req);
      // JSON.parse("null") → null，解构 null 会抛 TypeError 落进 catch 的 500
      // 分支——客户端发来合法 JSON 但非对象，属客户端错误（400）而非服务端错误。
      const { wallet, imageURI } = JSON.parse(body || "{}") ?? {};
      if (!wallet) return send(req, res, 400, { error: "missing wallet" });

      let addr: string;
      try {
        addr = ethers.getAddress(wallet);
      } catch {
        return send(req, res, 400, { error: "invalid wallet address" });
      }

      const entry = entryFor(addr, _allowlist);
      if (!entry) return send(req, res, 403, { error: "钱包不在白名单", wallet: addr });
      if (isExpired(entry)) {
        return send(req, res, 403, {
          error: `白名单资格已于 ${new Date((entry.expiresAt ?? 0) * 1000).toISOString()} 过期`,
          wallet: addr,
          expired: true,
        });
      }

      // 同钱包排队 + 占位：两者缺一不可。只排队不占位 → 第 2 个请求
      // 读到同一个 minted（此刻还没上链）照样签出去；只占位不排队 →
      // 两个请求同时占位、各自数到 pending=2，双双被拒。
      const deadline = Math.floor(Date.now() / 1000) + SIGN_DEADLINE_SECONDS;
      return await _locks.run(addr, async () => {
        const slot = _inflight.claim(addr, deadline);
        let issued = false;
        try {
          // fail-closed：RPC 不可达 / 查询超时 → minted 未知，宁可拒签也不要越权签发
          // （合约 v3 没有 per-wallet 硬上限，配额全靠后端签名把关）
          const minted = await withTimeout(_numMinted(addr), RPC_QUERY_TIMEOUT_MS);
          if (minted === null) {
            return send(req, res, 503, { error: "链上配额核验失败（RPC 不可达），请稍后重试" });
          }
          // pending 含本次占位：已铸 + 已签未上链 > limit 就拒
          const pending = _inflight.count(addr);
          if (minted + pending > entry.limit) {
            return send(req, res, 403, {
              error:
                `配额已用完（已铸 ${minted}/${entry.limit}` +
                (pending > 1 ? `，另有 ${pending - 1} 张签名待上链` : "") +
                "）",
              wallet: addr,
              minted,
              limit: entry.limit,
              pending: pending - 1,
              remaining: 0,
            });
          }

          // 图：用户自选 or 后端按下一 tokenId 分配创世图（全局唯一序号）
          let finalUri = imageURI;
          if (imageURI !== undefined) {
            if (typeof imageURI !== "string" || !validUserImage(imageURI)) {
              return send(req, res, 400, { error: "imageURI 非法：需 http(s)/ipfs/data:image 开头且 ≤500 字符" });
            }
        } else {
          // fail-closed：与 numberMinted 同一套口径——读不到 null → 503。
          // 旧的 (?? 0) 会让序号退回到水位线之下，进而撞到之前发过的图：
          // usedHashes 键含 deadline，新签名去重挡不住 → 同一钱包铸两张同图。
          const supply = await withTimeout(_totalSupply(), RPC_QUERY_TIMEOUT_MS);
          if (supply === null) {
            return send(req, res, 503, { error: "链上总量核验失败（RPC 不可达），请稍后重试" });
          }
          finalUri = genesisArt(addr, nextArtIndex(supply));
        }

          const signature = await signMint(_signer, addr, finalUri, deadline);
          const recovered = recoverSigner(addr, finalUri, deadline, signature);
          if (recovered !== _signer.address) {
            return send(req, res, 500, { error: "self-check failed" });
          }
          issued = true;
          console.log(`✍️  sign ${addr.slice(0, 8)}… (${minted + pending}/${entry.limit}) 图=${finalUri.slice(0, 30)}…`);
          return send(req, res, 200, {
            wallet: addr,
            minted,
            limit: entry.limit,
            remaining: Math.max(0, entry.limit - minted - pending),
            imageURI: finalUri,
            deadline,
            signature,
          });
        } finally {
          // 被拒 / 报错 / RPC 不可达都归还占位，不误伤正常重试；
          // 签发成功则保留到 deadline（签名过期自动释放）
          if (!issued) slot.release();
        }
      });
    }

    return send(req, res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof BodyTooLarge) {
      // 顺序要紧：先回 413，再排空剩余 body（不排空连接会挂着不回收）
      send(req, res, 413, { error: `body 超过 ${MAX_BODY_BYTES} 字节` });
      req.resume();
      return;
    }
    // 前端传了坏 JSON → 客户端错误，不该记成 500
    if (e instanceof SyntaxError) {
      return send(req, res, 400, { error: "body 不是合法 JSON" });
    }
    // 500 只回通用文案：String(e) 里可能有文件路径、RPC URL、堆栈片段——
    // 那是日志该记的，不是响应该给的。详情留在服务端，靠访问日志里的
    // 时间/路径去对。
    console.error(`💥 未捕获异常 ${req.method} ${(req.url ?? "").split("?")[0]}`, e);
    return send(req, res, 500, { error: "内部错误" });
  }
}

/**
 * 优雅关闭需要的最小 server 接口（node:http.Server 天然符合，
 * 测试里用同形状的假对象即可，不必真绑端口）。
 */
export type ClosableServer = {
  close: (cb?: (err?: Error) => void) => void;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

/**
 * 优雅关闭：停收新连接 → 等fulfil在途请求 → 退出。
 *
 * 关键在于**必须显式断开空闲的 keep-alive 连接**。server.close() 只表示
 * 「不再 accept 新连接」，已经建立且当前空闲的连接不会被自动关闭——而前端
 * 恰恰每 4s 轮询一次 /allowlist，长期占着一条 keep-alive。结果 close 的
 * 回调要等到 keepAliveTimeout（默认 5s）自然超时才可能触发，实际表现是
 * 每次重启都走满兜底超时、以 exit(1) 收场：systemd 记成失败，还可能触发
 * 重启策略。
 *
 * closeIdleConnections 只断**空闲**的，真正有请求在跑的连接不受影响。
 * 兜底定时器到点则 closeAllConnections 强断所有（含在途），宁可掐断一个
 * 请求也不能让进程永远退不掉。
 */
export function gracefulShutdown(
  server: ClosableServer,
  opts: {
    graceMs?: number;
    log?: (msg: string) => void;
    exit?: (code: number) => void;
  } = {},
): void {
  const graceMs = opts.graceMs ?? 10_000;
  const log = opts.log ?? ((m: string) => console.log(m));
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  log("停止接收新请求，等待在途请求结束…");
  // 顺序要紧：先 close（停止 accept），再清空闲连接——反过来的话，
  // 刚清掉的连接可能马上被新请求补上，close 回调照样等不到。
  server.close(() => {
    log("已优雅关闭");
    exit(0);
  });
  server.closeIdleConnections?.();

  const timer = setTimeout(() => {
    log(`等待超过 ${graceMs}ms，强制关闭剩余连接`);
    server.closeAllConnections?.();
    exit(1);
  }, graceMs);
  // 别让兜底定时器把进程拖住：没有在途请求时，进程应该自然退出
  timer.unref?.();
}

/**
 * 进程级兜底：任何未捕获异常 / 未处理 promise reject 都不该让进程静默崩
 * 在不明处（Node 默认对 unhandledRejection 直接终止进程，日志只有 promise
 * 细节、没有业务上下文，systemd 只会记成一次失败重启）。
 *
 * 策略分两种：
 *  - uncaughtException：进程状态可能已损坏，记日志 + 退出，交给 systemd /
 *    容器重启策略拉起（比带病运行安全）。
 *  - unhandledRejection：只记日志、不退出。它可能是某次瞬态 reject（比如
 *    某个依赖库内部的一次性 reject），为一个点杀掉整个签名服务代价太大；
 *    但必须记下来让运维看到、按需重启。
 *
 * 抽成可注入函数便于单测：默认用真实 process，测试里传假 proc 不碰真进程。
 */
type GuardProc = { on(event: string, listener: (...args: unknown[]) => void): void };
export function installProcessGuard(
  opts: {
    log?: (msg: string) => void;
    exit?: (code: number) => void;
    proc?: GuardProc;
  } = {},
): void {
  const log = opts.log ?? ((m: string) => console.error(m));
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const proc = opts.proc ?? (process as unknown as GuardProc);
  proc.on("uncaughtException", (err: unknown) => {
    log(`💥 uncaughtException: ${err instanceof Error ? err.message : String(err)}`);
    exit(1);
  });
  proc.on("unhandledRejection", (reason: unknown) => {
    log(`⚠️ unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
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
  {
    const total = Object.keys(allowlist).length;
    const expiredCount = Object.values(allowlist).filter((e) => isExpired(e)).length;
    console.log(
      `   白名单  : ${total} 个钱包（配额制，可多次 mint）` +
        (expiredCount ? `，其中 ${expiredCount} 个已过期` : ""),
    );
  }
  console.log(`   监听    : http://127.0.0.1:${PORT}`);
  console.log(
    `   限流键  : ${TRUST_PROXY ? "X-Forwarded-For（已信任代理）" : "socket IP（反向代理后需设 TRUST_PROXY=1）"}`,
  );
  if (Object.keys(allowlist).length === 0) {
    console.warn("⚠️  白名单为空：backend/data/allowlist.json 缺失或内容为空，所有 /sign 都会返回 403");
  }
  void selfCheck();

  const server = createServer((req, res) => {
    void handler(req, res);
  });

  // 进程级兜底：未捕获异常 / 未处理 reject 都不会让进程静默崩在不明处
  installProcessGuard();

  // 端口占用：listen 的 error 事件不处理时，Node 会把它当未捕获异常直接
  // throw，表现为「进程启动后无声退出」。明确报错再退出，运维一眼定位。
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`❌ 端口 ${PORT} 已被占用，无法启动（另一个实例在跑？先停掉或改 PORT）`);
    } else {
      console.error(`❌ 监听失败：${err.message}`);
    }
    process.exit(1);
  });
  server.listen(PORT, "127.0.0.1");

  // SIGHUP：热加载白名单，改配额不用重启（kill -HUP <pid>）
  process.on("SIGHUP", reloadAllowlist);

  // 优雅关闭：容器滚动更新 / Ctrl-C 时先停收新连接，等在途请求处理完
  // 再退出——否则会掐断正在进行的 /sign。加超时兜底，避免有连接挂死
  // 导致进程永远退不掉。
  const SHUTDOWN_GRACE_MS = 10_000;
  // keep-alive 空闲超时：关到比兜底宽限期短，close 回调才有机会先触发；
  // 太长则空闲连接一直吊着，重启就总是走强制退出那条路。
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 6_000;
  let shuttingDown = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n收到 ${sig}：`);
      gracefulShutdown(server, {
        graceMs: SHUTDOWN_GRACE_MS,
        log: (m) => (m.startsWith("等待超过") ? console.warn(m) : console.log(m)),
      });
    });
  }
}
