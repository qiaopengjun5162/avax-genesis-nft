import assert from "node:assert/strict";
import { test } from "node:test";
import { handler } from "../src/server.ts";
import { RateLimiter, clientIp } from "../src/ratelimit.ts";

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

test("ratelimit: clientIp 优先取 X-Forwarded-For 首段", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } }), "1.1.1.1");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "3.3.3.3" } }), "3.3.3.3");
  assert.equal(clientIp({ headers: {} }), "unknown");
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
