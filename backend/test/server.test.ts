import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { handler } from "../src/server.ts";
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
  assert.equal(last._headers["access-control-allow-origin"], "*");
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
