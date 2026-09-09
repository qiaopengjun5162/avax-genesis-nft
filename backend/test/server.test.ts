import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import {
  handler,
  corsHeaders,
  formatAccessLog,
  nextArtIndex,
  resetArtIndex,
  loadArtIndex,
  persistArtIndex,
  gracefulShutdown,
  numEnv,
  rpcHealth,
  installProcessGuard,
  type ClosableServer,
} from "../src/server.ts";
import { type Allowlist } from "../src/allowlist.ts";
import { RateLimiter, clientIp } from "../src/ratelimit.ts";
import { InflightSlots, KeyedLock } from "../src/inflight.ts";

/** 最小 mock：server.ts 的 handler 只用 url/method/headers + 可选异步迭代体 */
function mockReq(method: string, path: string, body?: string) {
  const req: any = { method, url: path, headers: { host: "127.0.0.1:8787" } };
  if (body !== undefined) {
    const buf = Buffer.from(body);
    req[Symbol.asyncIterator] = async function* () {
      yield buf;
    };
  }
  return req;
}

function mockRes() {
  const res: any = {
    statusCode: 0,
    _headers: {},
    _body: "",
    writeHead(code: number, headers: Record<string, string>) {
      res.statusCode = code;
      Object.assign(res._headers, headers);
      return res;
    },
    end(chunk?: string) {
      if (chunk !== undefined) res._body += chunk;
      return res;
    },
  };
  return res;
}

async function call(method: string, path: string, body?: string) {
  const req = mockReq(method, path, body);
  const res = mockRes();
  await handler(req, res);
  let json: any = undefined;
  if (res._body) {
    try {
      json = JSON.parse(res._body);
    } catch {
      /* 非 JSON（正常路径不会走到这） */
    }
  }
  return { code: res.statusCode, headers: res._headers, json };
}

test("server: GET / 返回服务信息含合约地址", async () => {
  const { code, json } = await call("GET", "/");
  assert.equal(code, 200);
  assert.equal(json.service, "genesis-mint-signer");
  assert.match(json.contract, /^0x[0-9a-fA-F]{40}$/);
  assert.match(json.protocol, /deadline/);
});

test("server: GET /healthz 返回 ok 且结构正确", async () => {
  const { code, json } = await call("GET", "/healthz");
  assert.equal(code, 200);
  assert.equal(json.ok, true);
  assert.ok(["ok", "degraded"].includes(json.status));
  assert.match(json.contract, /^0x[0-9a-fA-F]{40}$/);
  assert.ok(typeof json.uptimeSec === "number");
  assert.ok(typeof json.rpc.reachable === "boolean");
});

test("server: 未知路径返回 404", async () => {
  const { code } = await call("GET", "/nope");
  assert.equal(code, 404);
});

test("rpcHealth: 复用同一 provider，缓存窗口内只打一次 RPC（不泄漏连接池）", async () => {
  // 曾经每次都 new JsonRpcProvider → 15s 缓存未命中就泄漏一条连接池。
  // 改为单例 + 缓存命中时直接返回，同一个 provider 在窗口内只查一次链。
  let calls = 0;
  const fake = { getBlockNumber: async () => { calls += 1; return 12345; } } as any;
  const r1 = await rpcHealth(fake);
  const r2 = await rpcHealth(fake); // 同 provider，窗口内 → 命中缓存
  assert.equal(r1.reachable, true);
  assert.equal(r1.blockNumber, 12345);
  assert.equal(calls, 1, "15s 缓存窗口内只打一次 RPC");
  assert.deepEqual(r1, r2, "命中缓存应返回同一对象");
});

test("rpcHealth: RPC 不通返回 degraded 但仍是合法结构（服务不崩）", async () => {
  let calls = 0;
  const fake = {
    getBlockNumber: async () => {
      calls += 1;
      throw new Error("ECONNREFUSED");
    },
  } as any;
  const r = await rpcHealth(fake);
  assert.equal(r.reachable, false);
  assert.equal(r.blockNumber, null);
  assert.equal(typeof r.reachable, "boolean");
});

test("server: OPTIONS 预检返回 204", async () => {
  const { code } = await call("OPTIONS", "/sign");
  assert.equal(code, 204);
});

test("server: POST /sign 坏 JSON 返回 400（非 500）", async () => {
  const { code, json } = await call("POST", "/sign", "{not json");
  assert.equal(code, 400);
  assert.match(json.error, /JSON/);
});

test("server: POST /sign 缺 wallet 返回 400", async () => {
  const { code, json } = await call("POST", "/sign", JSON.stringify({}));
  assert.equal(code, 400);
  assert.match(json.error, /wallet/);
});

test("server: POST /sign 超大 body 返回 413（且不能掐断连接）", async () => {
  // 曾经在这里 req.destroy()：socket 一销毁，413 根本发不出去，
  // 客户端只看到连接被重置。现在改成「先回 413，再排空剩余 body」。
  const big = "a".repeat(9 * 1024); // > MAX_BODY_BYTES(8KB)
  const req: any = { method: "POST", url: "/sign", headers: { host: "x" }, socket: { remoteAddress: "5.5.5.9" } };
  let resumed = false;
  req.resume = () => {
    resumed = true;
    return req;
  };
  const buf = Buffer.from(big);
  req[Symbol.asyncIterator] = async function* () {
    yield buf;
  };
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.statusCode, 413);
  assert.match(res._body, /body 超过/);
  assert.equal(resumed, true); // 剩余字节必须排空，否则连接挂死
});

// ---- RateLimiter 单元 ----

test("ratelimit: 窗口内超过上限即拒绝，不同 key 独立计数", () => {
  const rl = new RateLimiter(2, 1000);
  assert.deepEqual(rl.hit("a"), { allowed: true, remaining: 1, retryAfterSec: 0 });
  assert.deepEqual(rl.hit("a"), { allowed: true, remaining: 0, retryAfterSec: 0 });
  const denied = rl.hit("a");
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSec > 0);
  // 不同 key 独立
  assert.equal(rl.hit("b").allowed, true);
});

test("ratelimit: 窗口过期后重新计数", () => {
  const rl = new RateLimiter(1, 1000);
  assert.equal(rl.hit("x", 1000).allowed, true);
  assert.equal(rl.hit("x", 1000).allowed, false); // 同窗口内第 2 次：拒
  assert.equal(rl.hit("x", 2001).allowed, true); // 越过 resetAt：放行
});

test("ratelimit: clear 后状态归零", () => {
  const rl = new RateLimiter(1, 1000);
  assert.equal(rl.hit("k").allowed, true);
  assert.equal(rl.hit("k").allowed, false);
  rl.clear();
  assert.equal(rl.hit("k").allowed, true);
});

test("ratelimit: clientIp 默认只用 socket 地址（XFF 可伪造，不能当限流键）", () => {
  // X-Forwarded-For 是客户端可控请求头：每次换个值就能拿到新桶 → 限流被绕过
  const forged = { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" }, socket: { remoteAddress: "9.9.9.9" } };
  assert.equal(clientIp(forged), "9.9.9.9");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "3.3.3.3" } }), "3.3.3.3");
  assert.equal(clientIp({ headers: {} }), "unknown");
});

test("ratelimit: trustProxy 开启后才读 X-Forwarded-For 首段", () => {
  const req = { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" }, socket: { remoteAddress: "9.9.9.9" } };
  assert.equal(clientIp(req, { trustProxy: true }), "1.1.1.1");
  // 开了开关但请求没带 XFF → 仍回落到 socket，不能返回空串
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "9.9.9.9" } }, { trustProxy: true }), "9.9.9.9");
});

// ---- 集成：/sign 超速率返回 429 ----

test("server: /sign 超过速率限制返回 429 + Retry-After", async () => {
  // 默认每 IP 30 次/窗口（SIGN_RATE_LIMIT），循环触发限流。
  // 每次都返回 400（缺 wallet，限流计数在 wallet 校验之前），直到触顶 429。
  const ipReq = (body: string) => {
    const req: any = {
      method: "POST",
      url: "/sign",
      headers: { host: "x" },
      socket: { remoteAddress: "9.9.9.9" },
    };
    const buf = Buffer.from(body);
    req[Symbol.asyncIterator] = async function* () {
      yield buf;
    };
    return req;
  };

  let last = mockRes();
  for (let i = 0; i < 31; i++) {
    last = mockRes();
    await handler(ipReq("{}"), last);
  }
  assert.equal(last.statusCode, 429); // 第 31 次（>上限 30）触发限流
  assert.ok(Number(last._headers["retry-after"]) > 0);
  // 限流拒绝也得带 CORS 头，否则浏览器里只看到「跨域失败」看不到 429。
  // 具体值取决于 .env 有没有配 CORS_ORIGIN（匹配逻辑由 cors 单测覆盖）。
  assert.equal(last._headers["vary"], "Origin");
});

// ---- fail-closed 配额核验 ----

const ANVIL_KEY_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDR_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // anvil 演示钱包 #0（checksummed）

function postSign(body: object, ip: string) {
  const req: any = {
    method: "POST",
    url: "/sign",
    headers: { host: "x" },
    socket: { remoteAddress: ip },
  };
  const buf = Buffer.from(JSON.stringify(body));
  req[Symbol.asyncIterator] = async function* () { yield buf; };
  return req;
}
function getAllowlist(wallet: string, ip: string) {
  return { method: "GET", url: `/allowlist/${wallet}`, headers: { host: "x" }, socket: { remoteAddress: ip } } as any;
}

test("server: /sign 链上配额核验失败（RPC 不可达）返回 503（fail-closed）", async () => {
  // 合约 v3 没有 per-wallet 硬上限，配额全靠后端签名把关。
  // 若 minted 读不到（null）还按 0 走就会无限越界。所以 fail-closed：503 + 拒签。
  const testWallet = new ethers.Wallet(ANVIL_KEY_0);
  const res = mockRes();
  await handler(postSign({ wallet: ANVIL_ADDR_0 }, "1.1.1.1"), res, {
    signer: testWallet,
    allowlist: { [ANVIL_ADDR_0]: { limit: 3 } } as Allowlist,
    numberMintedOnChain: async () => null,
  });
  assert.equal(res.statusCode, 503);
  assert.match(res._body, /RPC 不可达|链上配额核验/);
});

test("server: /allowlist 白名单内 RPC 不可达时 minted/remaining 为 null", async () => {
  const res = mockRes();
  await handler(getAllowlist(ANVIL_ADDR_0, "2.2.2.2"), res, {
    allowlist: { [ANVIL_ADDR_0]: { limit: 3 } } as Allowlist,
    numberMintedOnChain: async () => null,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res._body);
  assert.equal(body.allowlisted, true);
  assert.equal(body.limit, 3);
  assert.equal(body.minted, null);   // 未知
  assert.equal(body.remaining, null); // 未知
});

test("server: /allowlist 不在白名单时 minted/remaining 为 0（非 null）", async () => {
  const res = mockRes();
  await handler(getAllowlist(ANVIL_ADDR_0, "3.3.3.3"), res, {
    allowlist: {},
    numberMintedOnChain: async () => null, // 即便 RPC 挂也不该改变"非白名单"的语义
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res._body);
  assert.equal(body.allowlisted, false);
  assert.equal(body.limit, 0);
  assert.equal(body.minted, 0);
  assert.equal(body.remaining, 0);
});

test("server: /sign 注入依赖走完整流程返回签名（验证 deps 接线）", async () => {
  // 用 user-provided imageURI 避开 totalSupplyOnChain 真链调用，保证测试离线
  const testWallet = new ethers.Wallet(ANVIL_KEY_0);
  const res = mockRes();
  await handler(
    postSign({ wallet: ANVIL_ADDR_0, imageURI: "https://example.com/x.png" }, "4.4.4.4"),
    res,
    {
      signer: testWallet,
      allowlist: { [ANVIL_ADDR_0]: { limit: 5 } } as Allowlist,
      numberMintedOnChain: async () => 1,
    },
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res._body);
  assert.match(body.signature, /^0x[0-9a-fA-F]+$/);
  assert.equal(body.wallet, ANVIL_ADDR_0);
  assert.equal(body.minted, 1);
  assert.equal(body.limit, 5);
  assert.equal(body.remaining, 3); // 5 - 1 - 1
  assert.equal(body.imageURI, "https://example.com/x.png");
  assert.equal(body.deadline > Math.floor(Date.now() / 1000), true);
});

test("accesslog: 结构化一行日志（去 query / UA 裁剪 / 含耗时）", () => {
  const req = {
    method: "POST",
    url: "/sign?sig=0xdeadbeef&x=1",
    headers: { host: "h", "user-agent": "U".repeat(300) },
    socket: { remoteAddress: "1.2.3.4" },
  } as any;
  const line = formatAccessLog(req, 200, 42);
  assert.equal(line.method, "POST");
  assert.equal(line.path, "/sign"); // query 里的签名不该进日志
  assert.equal(line.status, 200);
  assert.equal(line.ms, 42);
  assert.equal(line.ip, "1.2.3.4");
  assert.equal(line.ua.length, 120); // 超长 UA 只留前 120 字符
  assert.doesNotThrow(() => JSON.stringify(line));
});

// ---- 白名单到期（expiresAt）----

test("server: /sign 白名单已过期返回 403（且不去读链上配额）", async () => {
  const w = new ethers.Wallet(ANVIL_KEY_0);
  let chainReads = 0;
  const res = mockRes();
  await handler(postSign({ wallet: ANVIL_ADDR_0, imageURI: "https://example.com/x.png" }, "12.12.12.1"), res, {
    signer: w,
    allowlist: { [ANVIL_ADDR_0]: { limit: 3, expiresAt: Math.floor(Date.now() / 1000) - 60 } } as Allowlist,
    numberMintedOnChain: async () => {
      chainReads += 1;
      return 0;
    },
  });
  assert.equal(res.statusCode, 403);
  assert.match(res._body, /过期/);
  assert.equal(chainReads, 0, "过期就没必要再打 RPC");
});

test("server: /allowlist 已过期 → allowlisted=false + expired=true", async () => {
  const res = mockRes();
  await handler(getAllowlist(ANVIL_ADDR_0, "12.12.12.2"), res, {
    allowlist: { [ANVIL_ADDR_0]: { limit: 3, expiresAt: Math.floor(Date.now() / 1000) - 60 } } as Allowlist,
    numberMintedOnChain: async () => 0,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res._body);
  assert.equal(body.expired, true);
  assert.equal(body.allowlisted, false); // 语义：现在不给你签
  assert.equal(body.limit, 3); // 但原本的配额仍返回，前端可以显示"曾可领 3 张"
  assert.ok(body.expiresAt > 0);
});

test("server: /sign 未过期正常签发（回归：别把没到期的人也拦了）", async () => {
  const w = new ethers.Wallet(ANVIL_KEY_0);
  const res = mockRes();
  await handler(postSign({ wallet: ANVIL_ADDR_0, imageURI: "https://example.com/x.png" }, "12.12.12.3"), res, {
    signer: w,
    allowlist: { [ANVIL_ADDR_0]: { limit: 3, expiresAt: Math.floor(Date.now() / 1000) + 3600 } } as Allowlist,
    numberMintedOnChain: async () => 0,
  });
  assert.equal(res.statusCode, 200);
  assert.match(JSON.parse(res._body).signature, /^0x/);
});

// ---- 创世图序号（防同钱包连签撞同一张图）----

test("artIndex: 链上总量不动时也严格递增", () => {
  // 同一钱包在第一张上链前再签一次：totalSupply 还是 0，
  // 若直接拿 totalSupply 当序号，两次都是 0 → 同一张 data URI →
  // 第二张 mint 必撞 SignatureAlreadyUsed。
  resetArtIndex();
  assert.equal(nextArtIndex(0), 0);
  assert.equal(nextArtIndex(0), 1);
  assert.equal(nextArtIndex(0), 2);
  // 链上追上来后（前几张已铸），接着链上走，不回退
  assert.equal(nextArtIndex(3), 3);
  assert.equal(nextArtIndex(3), 4);
  resetArtIndex();
});

test("server: /sign 不传 imageURI 时 totalSupply 不可达 → 503（fail-closed）", async () => {
  // 关键的「序号撞车会铸出两张完全相同的 NFT」是因为 RPC 半通：numberMinted
  // 读得到、totalSupply 读不到。回退 (?? 0) 会让 nextArtIndex 退到水位线之下，
  // 撞到之前发过的图——合约 usedHashes 键含 deadline，去重挡不住。
  // 改成与 numberMinted 同一套口径：读不到 → null → 503。
  resetArtIndex();
  const res = mockRes();
  await handler(postSign({ wallet: ANVIL_ADDR_0 }, "9.9.9.3"), res, {
    signer: new ethers.Wallet(ANVIL_KEY_0),
    allowlist: { [ANVIL_ADDR_0]: { limit: 3 } } as Allowlist,
    numberMintedOnChain: async () => 0, // 这边正常
    totalSupplyOnChain: async () => null, // 但 totalSupply 不可达
  });
  assert.equal(res.statusCode, 503);
  assert.match(res._body, /总量|不可达/);
  // 关键的副作用约束：水位线不应被推进——fail-closed 必须真的「不签」，
  // 否则下次重启读回一个错序号，等于自己埋下撞图种子。
  // 起始 -1：第一次 nextArtIndex(999) 应当走 max(999, 0) = 999
  assert.equal(nextArtIndex(999), 999, "503 路径没动水位线，仍是从 -1 开始算");
  resetArtIndex();
});

test("server: 同一钱包连签两次（都未上链）拿到两张不同的图", async () => {
  // 端到端验证上面那条：不传 imageURI → 后端自动分配创世图
  const inflight = new InflightSlots();
  const w = new ethers.Wallet(ANVIL_KEY_0);
  const deps = {
    signer: w,
    allowlist: { [ANVIL_ADDR_0]: { limit: 3 } } as Allowlist,
    numberMintedOnChain: async () => 0,
    totalSupplyOnChain: async () => 0, // 两张都还没上链，链上总量纹丝不动
    inflight,
  };
  const r1 = mockRes();
  await handler(postSign({ wallet: ANVIL_ADDR_0 }, "11.11.11.1"), r1, deps);
  const r2 = mockRes();
  await handler(postSign({ wallet: ANVIL_ADDR_0 }, "11.11.11.2"), r2, deps);
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  const u1 = JSON.parse(r1._body).imageURI;
  const u2 = JSON.parse(r2._body).imageURI;
  assert.match(u1, /^data:image\/svg\+xml;base64,/);
  assert.notEqual(u1, u2); // 相同 = 第二张必然作废
  resetArtIndex();
});

// ---- CORS 允许源白名单 ----

test("cors: 未配置白名单时回显 *（本地开发默认）", () => {
  const h = corsHeaders({ headers: { origin: "https://evil.example" } } as any, []);
  assert.equal(h["access-control-allow-origin"], "*");
});

test("cors: 配了白名单就只回显命中的 origin，未命中不发 ACAO", () => {
  const allowed = ["https://mint.example", "http://localhost:3000"];
  const ok = corsHeaders({ headers: { origin: "https://mint.example" } } as any, allowed);
  assert.equal(ok["access-control-allow-origin"], "https://mint.example");

  const bad = corsHeaders({ headers: { origin: "https://evil.example" } } as any, allowed);
  assert.equal(bad["access-control-allow-origin"], undefined); // 浏览器会拦掉响应
});

test("cors: 结尾斜杠与大小写不同的 origin 不被误判放行", () => {
  const allowed = ["http://localhost:3000"];
  // 带尾斜杠视为同一个源，回显时归一化（前端填配置时最容易多打一个 /）
  assert.equal(
    corsHeaders({ headers: { origin: "http://localhost:3000/" } } as any, allowed)[
      "access-control-allow-origin"
    ],
    "http://localhost:3000",
  );
  // 缺 Origin 头（curl / 服务端调用）→ 不发 ACAO
  assert.equal(
    corsHeaders({ headers: {} } as any, allowed)["access-control-allow-origin"],
    undefined,
  );
});

test("cors: 任何分支都带 Vary: Origin（否则缓存会把 A 站的响应发给 B 站）", () => {
  assert.equal(corsHeaders({ headers: {} } as any, [])["vary"], "Origin");
  assert.equal(
    corsHeaders({ headers: { origin: "https://x.example" } } as any, ["https://x.example"])["vary"],
    "Origin",
  );
});

// ---- in-flight 槽位 + 按钱包串行锁（防并发突破配额）----

test("inflight: 占位计数 / 归还幂等 / 过期自动清理", () => {
  const s = new InflightSlots();
  const now = Math.floor(Date.now() / 1000);
  const a = s.claim("0xA", now + 60);
  const b = s.claim("0xA", now + 60);
  assert.equal(s.count("0xA", now), 2);
  a.release();
  assert.equal(s.count("0xA", now), 1);
  a.release(); // 幂等：重复归还不能再减
  assert.equal(s.count("0xA", now), 1);

  const expired = s.claim("0xA", now - 1); // 已经过期的签名
  assert.equal(s.count("0xA", now), 1); // 过期的那个不计数
  b.release();
  expired.release();
  assert.equal(s.count("0xA", now), 0);
});

test("server: /allowlist 的 remaining 计入待上链签名（与 /sign 同口径）", async () => {
  const inflight = new InflightSlots();
  const now = Math.floor(Date.now() / 1000);
  inflight.claim(ANVIL_ADDR_0, now + 600);
  inflight.claim(ANVIL_ADDR_0, now + 600);
  const res = mockRes();
  await handler(getAllowlist(ANVIL_ADDR_0, "9.9.9.1"), res, {
    allowlist: { [ANVIL_ADDR_0]: { limit: 3 } } as Allowlist,
    numberMintedOnChain: async () => 0,
    inflight,
  });
  const body = JSON.parse(res._body);
  assert.equal(body.minted, 0);
  assert.equal(body.pending, 2);
  // 只算已铸会给出 remaining=3，用户点下去却吃 403（有 2 张在飞）
  assert.equal(body.remaining, 1);
});

test("keylock: 同 key 串行执行，不同 key 互不阻塞", async () => {
  const lk = new KeyedLock();
  const order: string[] = [];
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const p1 = lk.run("a", async () => {
    order.push("a1-start");
    await sleep(20);
    order.push("a1-end");
  });
  const p2 = lk.run("a", async () => {
    order.push("a2");
  });
  const p3 = lk.run("b", async () => {
    order.push("b1");
  });
  await Promise.all([p1, p2, p3]);
  // b 不排队（不同 key）；a2 必须等 a1 跑完
  assert.deepEqual(order, ["a1-start", "b1", "a1-end", "a2"]);
});

test("server: limit=1 时并发两个 /sign 只签得出一个（in-flight 占位生效）", async () => {
  // 没有占位的话：两个请求都读到 minted=0（此刻都还没上链）→ 都能签出
  // → limit=1 实际 mint 出 2 张，配额被绕过。
  const inflight = new InflightSlots();
  const locks = new KeyedLock();
  const w = new ethers.Wallet(ANVIL_KEY_0);
  let open = () => {};
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const deps = {
    signer: w,
    allowlist: { [ANVIL_ADDR_0]: { limit: 1 } } as Allowlist,
    // 卡在 RPC 上，制造两个请求同时在飞的窗口
    numberMintedOnChain: async () => {
      await gate;
      return 0;
    },
    inflight,
    locks,
  };
  const r1 = mockRes();
  const r2 = mockRes();
  const p1 = handler(
    postSign({ wallet: ANVIL_ADDR_0, imageURI: "https://example.com/a.png" }, "7.7.7.1"),
    r1,
    deps,
  );
  const p2 = handler(
    postSign({ wallet: ANVIL_ADDR_0, imageURI: "https://example.com/b.png" }, "7.7.7.2"),
    r2,
    deps,
  );
  open();
  await Promise.all([p1, p2]);
  assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 403]);
  // 签发成功那张保留占位（签名在 deadline 内仍可用），被拒的已归还
  assert.equal(inflight.count(ANVIL_ADDR_0), 1);
});

test("server: /sign 失败路径归还 in-flight 占位，重试不受影响", async () => {
  const inflight = new InflightSlots();
  const w = new ethers.Wallet(ANVIL_KEY_0);
  const deps = (nm: () => Promise<number | null>) => ({
    signer: w,
    allowlist: { [ANVIL_ADDR_0]: { limit: 1 } } as Allowlist,
    numberMintedOnChain: nm,
    inflight,
  });
  // 第一次：RPC 不可达 → 503。占位必须归还，否则这个钱包永久签不了
  const r1 = mockRes();
  await handler(
    postSign({ wallet: ANVIL_ADDR_0, imageURI: "https://example.com/a.png" }, "8.8.8.1"),
    r1,
    deps(async () => null),
  );
  assert.equal(r1.statusCode, 503);
  assert.equal(inflight.count(ANVIL_ADDR_0), 0);

  // 第二次：RPC 恢复 → 正常签出
  const r2 = mockRes();
  await handler(
    postSign({ wallet: ANVIL_ADDR_0, imageURI: "https://example.com/a.png" }, "8.8.8.2"),
    r2,
    deps(async () => 0),
  );
  assert.equal(r2.statusCode, 200);
});

// ---- 内存有界：限流桶 / in-flight 槽位都不能只增不减 ----

test("ratelimit: 过期桶被惰性回收（Map 不随来访 IP 数无限增长）", () => {
  const rl = new RateLimiter(10, 1000);
  const t0 = 1_000_000;
  for (let i = 0; i < 100; i++) rl.hit(`ip-${i}`, t0);
  assert.equal(rl.size, 100);
  // 跨过一个窗口后再来一次请求 → 触发清扫，旧桶全清，只剩这一个
  rl.hit("ip-new", t0 + 1001);
  assert.equal(rl.size, 1);
});

test("ratelimit: key 数超硬上限时淘汰最老的（宁可放宽计数也不 OOM）", () => {
  const rl = new RateLimiter(10, 60_000, { maxKeys: 50 });
  const t0 = 2_000_000;
  for (let i = 0; i < 80; i++) rl.hit(`ip-${i}`, t0);
  assert.ok(rl.size <= 51, `应被压回上限附近，实际 ${rl.size}`);
  // 反面情形：不设上限时这里会是 80 且随流量单调增长
});

test("inflight: 过期槽位即使没人再查也会被全局清扫回收", () => {
  const f = new InflightSlots();
  const nowSec = Math.floor(Date.now() / 1000);
  f.claim("0xaaa", nowSec - 10); // 已过期
  f.claim("0xbbb", nowSec + 600); // 仍有效
  assert.equal(f.walletCount, 2);
  assert.equal(f.sweep(nowSec), 1);
  assert.equal(f.walletCount, 1, "过期的回收掉，有效的必须留着");
  assert.equal(f.count("0xbbb", nowSec), 1);
});

test("inflight: claim 满 64 次自动全局清扫一次", () => {
  const f = new InflightSlots();
  const nowSec = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 64; i++) f.claim(`w${i}`, nowSec - 1);
  assert.ok(f.walletCount < 64, `应有槽位被自动回收，实际 ${f.walletCount}`);
});

// ---- 图序号水位线落盘（防重启后又撞同一张图）----

test("artIndex: 水位线可落盘读回，坏内容回退 -1", async () => {
  const { loadArtIndex: load } = await import("../src/server.ts");
  const p = join(mkdtempSync(join(tmpdir(), "artidx-")), ".art-index");
  assert.equal(load(p), -1, "文件不存在 → 当作从没发过");
  writeFileSync(p, " 42 \n");
  assert.equal(load(p), 42, "容忍首尾空白");
  writeFileSync(p, "not-a-number");
  assert.equal(load(p), -1, "内容不可信 → 回退 -1，不拿错序号去发图");
  writeFileSync(p, "-5");
  assert.equal(load(p), -1, "负数同样不可信");
});

test("artIndex: 重启后读回的水位线继续递增（不退回撞图）", async () => {
  const { loadArtIndex: load } = await import("../src/server.ts");
  const p = join(mkdtempSync(join(tmpdir(), "artidx-")), ".art-index");
  writeFileSync(p, "7");
  // 模拟重启：水位线从盘上读回，此时链上总量仍是 5（上一张还没上链）
  const resumed = load(p);
  assert.equal(Math.max(5, resumed + 1), 8, "必须接着 7 往后走，而不是回到 5+1=6");
});

test("artIndex: 水位线原子落盘——临时文件被重命名，不留 .tmp 残留", async () => {
  const p = join(mkdtempSync(join(tmpdir(), "artidx-")), ".art-index");
  persistArtIndex(42, p);
  assert.equal(readFileSync(p, "utf8").trim(), "42", "正式文件落成了正确内容");
  // rename 是原子的：要么 .tmp 还在、要么已被改名覆盖，绝不会「长留一个 .tmp」
  let tmpLeft = false;
  try {
    readFileSync(`${p}.tmp`, "utf8");
    tmpLeft = true;
  } catch {
    /* 没有 .tmp 是正确结果 */
  }
  assert.equal(tmpLeft, false, "原子替换后不应残留临时文件");
});

// ---- 错误码口径 ----

test("server: /allowlist 地址 checksum 非法 → 400（不是 500）", async () => {
  // /sign 早就对这种输入返回 400，/allowlist 却让 getAddress 的异常漏到
  // 兜底 catch → 500。客户端错误被报成服务端错误，排障方向直接跑偏，
  // 还白扣一次限流额度。
  const good = ethers.getAddress("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  const i = good.split("").findIndex((c, idx) => idx > 1 && /[a-f]/i.test(c));
  const flipped =
    good[i] === good[i].toLowerCase() ? good[i].toUpperCase() : good[i].toLowerCase();
  const bad = good.slice(0, i) + flipped + good.slice(i + 1);
  assert.throws(() => ethers.getAddress(bad), "前提：构造出的地址确实 checksum 非法");

  const res = mockRes();
  await handler(getAllowlist(bad, "9.9.9.1"), res);
  assert.equal(res.statusCode, 400);
  assert.match(res._body, /wallet/);
});

test("server: 未捕获异常只回通用文案，不把内部细节吐给客户端", async () => {
  const quiet = mock.method(console, "error", () => {});
  try {
    const res = mockRes();
    await handler(postSign({ wallet: ANVIL_ADDR_0 }, "9.9.9.2"), res, {
      signer: new ethers.Wallet(ANVIL_KEY_0),
      allowlist: { [ANVIL_ADDR_0]: { limit: 3 } } as Allowlist,
      numberMintedOnChain: async () => {
        throw new Error("RPC_URL=https://user:secret@example.com ENOENT /etc/passwd");
      },
    });
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res._body).error, "内部错误");
    assert.ok(!res._body.includes("secret"), "内部细节只能进日志，不能进响应");
  } finally {
    quiet.mock.restore();
  }
});

// ---- 启动配置自检 ----

test("numEnv: 合法值原样返回", () => {
  assert.equal(numEnv("X", 30, { min: 1, max: 100 }, { X: "30" }), 30);
  assert.equal(numEnv("X", 30, { min: 1, max: 100 }, { X: "1" }), 1, "下界包含");
  assert.equal(numEnv("X", 30, { min: 1, max: 100 }, { X: "100" }), 100, "上界包含");
});

test("numEnv: 缺省/空串/非法值一律回退", () => {
  const quiet = mock.method(console, "warn", () => {});
  try {
    assert.equal(numEnv("X", 30, {}, {}), 30, "缺省");
    assert.equal(numEnv("X", 30, {}, { X: "" }), 30, "空串");
    assert.equal(numEnv("X", 30, { min: 1 }, { X: "0" }), 30, "0 在 {min:1} 下非法");
    assert.equal(numEnv("X", 30, { min: 1 }, { X: "abc" }), 30, "非数字");
    assert.equal(numEnv("X", 30, { min: 1 }, { X: "NaN" }), 30, "显式 NaN 字符串");
    assert.equal(numEnv("X", 30, { max: 100 }, { X: "1e9" }), 30, "超上界");
  } finally {
    quiet.mock.restore();
  }
});

test("numEnv: 缺省的语义是「用 fallback」，不是「当成 0 处理」", () => {
  // 防止有人把签名过期时间配成 SIGN_DEADLINE_SECONDS=0 → Number("0") = 0
  // → 走「合法值」分支 → deadline = now → 用户签名立即过期。
  // 0 是合法整数，但对 SIGN_DEADLINE_SECONDS 是灾难值。
  assert.equal(numEnv("SIGN_DEADLINE_SECONDS", 3600, { min: 1 }, { SIGN_DEADLINE_SECONDS: "0" }), 3600);
});

// ---- 优雅关闭 ----

/** 记录调用顺序的假 server（不绑端口，纯行为断言） */
function mockServer() {
  const calls: string[] = [];
  let closeCb: (() => void) | undefined;
  const server: ClosableServer & { calls: string[]; fireClose: () => void } = {
    calls,
    close: (cb) => {
      calls.push("close");
      closeCb = cb as (() => void) | undefined;
    },
    closeIdleConnections: () => calls.push("closeIdleConnections"),
    closeAllConnections: () => calls.push("closeAllConnections"),
    fireClose: () => closeCb?.(),
  };
  return server;
}

test("gracefulShutdown: 先 close 再断空闲连接，close 回调一到就 exit 0", () => {
  const s = mockServer();
  const exits: number[] = [];
  gracefulShutdown(s, { graceMs: 5000, log: () => {}, exit: (c) => exits.push(c) });

  // 顺序要紧：先停止 accept，再清空闲——反了的话清完又被新请求补上
  assert.deepEqual(s.calls, ["close", "closeIdleConnections"]);
  s.fireClose();
  assert.deepEqual(exits, [0], "在途请求跑完 → 正常退出，不带失败码");
});

test("gracefulShutdown: 到点还没关完 → 强断所有连接并 exit 1", async () => {
  const s = mockServer();
  const exits: number[] = [];
  const logs: string[] = [];
  gracefulShutdown(s, { graceMs: 10, log: (m) => logs.push(m), exit: (c) => exits.push(c) });

  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(exits, [1], "超时必须退出，不能永远挂着");
  assert.ok(s.calls.includes("closeAllConnections"), "兜底要把在途连接也断掉");
  assert.ok(logs.some((m) => m.includes("强制关闭")), "要留下一条可排查的告警");
});

// ---- 进程级兜底（installProcessGuard）----

test("installProcessGuard: 注册 uncaughtException + unhandledRejection 两个监听", () => {
  const events: string[] = [];
  installProcessGuard({
    proc: { on: (ev: string) => events.push(ev) } as never,
    exit: () => {},
  });
  assert.ok(events.includes("uncaughtException"), "必须接管 uncaughtException");
  assert.ok(events.includes("unhandledRejection"), "必须接管 unhandledRejection");
});

test("installProcessGuard: uncaughtException 记录并退出（状态可能已损坏）", () => {
  let logMsg = "";
  let exitCode: number | undefined;
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  installProcessGuard({
    proc: { on: (ev: string, cb: (...a: unknown[]) => void) => (handlers[ev] = cb) } as never,
    log: (m) => (logMsg = m),
    exit: (c) => (exitCode = c),
  });
  handlers["uncaughtException"]!(new Error("boom"));
  assert.match(logMsg, /uncaughtException/, "要留下可排查的日志");
  assert.equal(exitCode, 1, "状态不可信，必须退出让 systemd 重启");
});

test("installProcessGuard: unhandledRejection 只记录不退出（单点不杀全服务）", () => {
  let logMsg = "";
  let exitCalled = false;
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  installProcessGuard({
    proc: { on: (ev: string, cb: (...a: unknown[]) => void) => (handlers[ev] = cb) } as never,
    log: (m) => (logMsg = m),
    exit: () => (exitCalled = true),
  });
  handlers["unhandledRejection"]!("some-reason");
  assert.match(logMsg, /unhandledRejection/, "要留下可排查的日志");
  assert.equal(exitCalled, false, "unhandledRejection 不该退出，否则一个 reject 杀掉整服务");
});
