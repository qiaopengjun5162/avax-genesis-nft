/**
 * chain-value.ts 单测：链上 uint256 → number 的安全归一化。
 *
 * 为什么值得单独测：裸 Number(x) 遇 NaN 时不会抛错、`!== null` 也成立，
 * 于是 fail-closed 的 `minted === null` 检查形同虚设，NaN 直接流进
 * `minted + pending > limit` —— 比较恒 false，配额判断失效变无限签发。
 * 这类静默故障不崩不红，只能靠单测钉住每种非法输入。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { toOnChainCount } from "../src/chain-value.ts";

test("chain-value: 合法的 bigint / number 原样转成 number", () => {
  assert.equal(toOnChainCount(0n), 0);
  assert.equal(toOnChainCount(7n), 7);
  assert.equal(toOnChainCount(0), 0);
  assert.equal(toOnChainCount(42), 42);
  assert.equal(toOnChainCount(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test("chain-value: NaN / Infinity 一律 null（否则 fail-closed 被绕过）", () => {
  assert.equal(toOnChainCount(NaN), null);
  assert.equal(toOnChainCount(Infinity), null);
  assert.equal(toOnChainCount(-Infinity), null);
  // Number("abc") 也是 NaN，但这里类型是 string → 直接 null
  assert.equal(toOnChainCount("abc"), null);
});

test("chain-value: 小数 / 负数 / 超大数一律 null", () => {
  assert.equal(toOnChainCount(3.5), null);
  assert.equal(toOnChainCount(-1), null);
  assert.equal(toOnChainCount(-1n), null);
  assert.equal(toOnChainCount(Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(toOnChainCount(BigInt(Number.MAX_SAFE_INTEGER) + 1n), null, "bigint 比较走大数路径，不能先转 number 丢精度");
});

test("chain-value: 非数值类型（null / undefined / 字符串 / 对象）一律 null", () => {
  for (const bad of [null, undefined, "5", "0x10", {}, [], true]) {
    assert.equal(toOnChainCount(bad), null, `非数值输入 ${String(bad)} 必须归一成 null`);
  }
});
