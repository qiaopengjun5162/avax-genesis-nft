/**
 * 统计卡展示值回归测试。
 *
 * 这里钉的是一类「静默故障」：allowFailure 的 multicall 里某一项读失败时，
 * page.tsx 拿到的就是 undefined。旧实现 `status ?? 0` / `totalSupply ?? 0n`
 * 会把它渲染成「Waiting（未开始）」和「已铸 0」——不崩不红，用户只看到一个
 * 看似真实、实则捏造的事实。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { STATUS_TEXT, statusLabel, supplyLabel } from "../lib/stats.ts";

test("statusLabel: 读不到不能显示成 Waiting", () => {
  assert.equal(statusLabel(undefined), "…");
  assert.equal(statusLabel(0), STATUS_TEXT[0]);
  assert.equal(statusLabel(1), STATUS_TEXT[1]);
  assert.equal(statusLabel(2), STATUS_TEXT[2]);
  // 合约新增了状态码但文案没跟上：明确标 ?，不冒充某个已知状态
  assert.equal(statusLabel(7), "?");
});

test("supplyLabel: 任一项读不到都不能伪造成 0", () => {
  assert.equal(supplyLabel(undefined, undefined), "… / …");
  assert.equal(supplyLabel(undefined, 100n), "… / 100");
  assert.equal(supplyLabel(5n, undefined), "5 / …");
  assert.equal(supplyLabel(0n, 100n), "0 / 100");
});

test("supplyLabel: 大额走 bigint 字符串，不经 Number 丢精度", () => {
  const huge = 2n ** 100n;
  assert.equal(supplyLabel(huge, huge), `${huge} / ${huge}`);
});
