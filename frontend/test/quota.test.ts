/**
 * `/allowlist` 响应解析的测试。
 *
 * 这里守的是一句**诊断话术的准确性**：429（后端活着、我轮询太快）与
 * 5xx / 网络不可达（服务真挂了）必须分开。合并成「服务不可用」的代价是
 * 双重的——用户查错方向（去翻后端进程），而且 Mint 按钮被无辜禁用。
 *
 * 后端每 60s 只给 60 次 `/allowlist`，而前端每 4s 轮询一次 = 15 次/分钟/
 * 标签页：4 个标签页、或 4 个用户共用一个出口 IP（Nginx 后忘了开
 * TRUST_PROXY）就必然撞上。这不是极端情况，是默认配置下的常态。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuotaResponse } from "../lib/quota.ts";

const OK_BODY = JSON.stringify({
  wallet: "0x000000000000000000000000000000000000dEaD",
  allowlisted: true,
  expired: false,
  expiresAt: null,
  limit: 3,
  minted: 1,
  remaining: 2,
  pending: 0,
});

test("quota: 正常响应 → ok，字段原样保留", () => {
  const r = parseQuotaResponse(200, OK_BODY);
  assert.equal(r.kind, "ok");
  if (r.kind !== "ok") return;
  assert.equal(r.quota.limit, 3);
  assert.equal(r.quota.minted, 1);
  assert.equal(r.quota.remaining, 2);
  assert.equal(r.quota.allowlisted, true);
});

test("quota: minted/remaining 为 null（RPC 不可达）也是合法响应，不能当故障", () => {
  const r = parseQuotaResponse(
    200,
    JSON.stringify({ allowlisted: true, limit: 3, minted: null, remaining: null }),
  );
  assert.equal(r.kind, "ok", "后端 fail-closed 会说「未知」，这是有效信息，不是错误");
  if (r.kind !== "ok") return;
  assert.equal(r.quota.minted, null);
});

test("quota: 429 优先读 retry-after 头", () => {
  const r = parseQuotaResponse(429, JSON.stringify({ error: "请求过于频繁，请稍后再试" }), "37");
  assert.equal(r.kind, "rate-limited");
  if (r.kind !== "rate-limited") return;
  assert.equal(r.retryAfterSec, 37);
  assert.match(r.detail, /频繁/);
});

test("quota: 429 没有头时读 body 的 retryAfterSec，再没有就兜底 10s", () => {
  const withBody = parseQuotaResponse(429, JSON.stringify({ retryAfterSec: 5 }), null);
  assert.equal(withBody.kind === "rate-limited" && withBody.retryAfterSec, 5);

  const noHint = parseQuotaResponse(429, "", undefined);
  assert.equal(noHint.kind === "rate-limited" && noHint.retryAfterSec, 10);
});

test("quota: 坏 retry-after（0/负数/天文数字）夹到 1..300，不能把轮询钉死或变忙等", () => {
  for (const [header, lo, hi] of [
    ["0", 1, 300],
    ["-5", 1, 300],
    ["999999", 1, 300],
  ] as const) {
    const r = parseQuotaResponse(429, "", header);
    assert.equal(r.kind, "rate-limited");
    if (r.kind !== "rate-limited") return;
    assert.ok(
      r.retryAfterSec >= lo && r.retryAfterSec <= hi,
      `retryAfter=${header} 得到 ${r.retryAfterSec}，超出 ${lo}..${hi}`,
    );
  }
});

test("quota: 5xx / HTML 错误页 → down（这是真故障，要禁点）", () => {
  const html = parseQuotaResponse(502, "<html><body>Bad Gateway</body></html>");
  assert.equal(html.kind, "down");
  if (html.kind !== "down") return;
  assert.ok(!html.detail.includes("Unexpected token"), "别把 JSON 解析错误当原因");
  assert.ok(html.detail.length > 0);

  const empty = parseQuotaResponse(503, "   ");
  assert.equal(empty.kind, "down");
  if (empty.kind !== "down") return;
  assert.match(empty.detail, /503|响应体为空/);
});

test("quota: 200 但结构不符（前后端版本不一致）→ down，不能把 undefined 喂给渲染", () => {
  for (const body of [
    "{}",
    JSON.stringify({ allowlisted: "yes", limit: 3, minted: 0, remaining: 3 }),
    JSON.stringify({ allowlisted: true, minted: 0, remaining: 3 }),
    JSON.stringify({ allowlisted: true, limit: 3, minted: "0", remaining: 3 }),
    "[]",
    "",
  ]) {
    const r = parseQuotaResponse(200, body);
    assert.equal(r.kind, "down", `body=${body} 应判为结构不符`);
  }
});

test("quota: down 时优先用后端给的 error 文案，便于直接看出根因", () => {
  const r = parseQuotaResponse(500, JSON.stringify({ error: "链上配额核验失败（RPC 不可达）" }));
  assert.equal(r.kind, "down");
  if (r.kind !== "down") return;
  assert.match(r.detail, /RPC 不可达/);
});
