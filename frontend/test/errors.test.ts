/**
 * 错误人话化的测试。核心目的只有一个：**盯住 selector 不写错**。
 *
 * 为什么值得单独测：selector 写错是**静默故障**——匹配不上就走 fallback，
 * 用户看到一串原始 viem 报错，没人会来提 bug。历史上就踩过一次：
 * SignatureExpired 写成了 0x7248afc4（ABI 里根本没这个 selector），真值是
 * 0x0819bdcd，于是「签名过期」这条最常见的路径永远显示不出人话提示。
 *
 * 所以这里**不写死任何 selector**，全部用 viem 从 lib/genesisMintAbi.json
 * 现算：合约改了 error 签名，测试自己会红，不用人记得同步。
 *
 * 跑法：cd frontend && npm test
 * （用 node:test + --experimental-strip-types，不引入 vitest 等新依赖）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toFunctionSelector } from "viem";
import { REVERT_HINTS, humanizeError, isUserRejection } from "../lib/errors.ts";

type AbiError = { type: string; name?: string; inputs?: Array<{ type: string }> };

const abi = JSON.parse(
  readFileSync(new URL("../lib/genesisMintAbi.json", import.meta.url), "utf8"),
) as AbiError[];

/** ABI 里的 custom error → selector（现算，不硬编码） */
const SELECTOR_BY_SIG = new Map<string, string>();
for (const e of abi) {
  if (e.type !== "error" || !e.name) continue;
  const sig = `${e.name}(${(e.inputs ?? []).map((i) => i.type).join(",")})`;
  SELECTOR_BY_SIG.set(sig, toFunctionSelector(sig));
}
const KNOWN_SELECTORS = new Set(SELECTOR_BY_SIG.values());

/** 用户自己就会撞上的 error——这些必须有 hint，否则人话化形同虚设 */
const USER_FACING = [
  "InvalidSignature()",
  "SignatureExpired()",
  "SignatureAlreadyUsed()",
  "MintNotStarted()",
  "MaxSupplyExceeded()",
  "EtherAmountMismatch(uint256,uint256)",
  "MintPaused()",
  "EmptyImageURI()",
  "RefundFailed()",
  "NonexistentToken()",
  "ZeroAddress()",
  "NoBalance()",
];

test("ABI 里确实解析出了 custom error（防止 ABI 文件被换掉/清空后测试空转）", () => {
  assert.ok(SELECTOR_BY_SIG.size > 10, `只解析到 ${SELECTOR_BY_SIG.size} 个 error，ABI 可能不对`);
});

test("REVERT_HINTS: 每个 selector 都必须是合约真实存在的 error", () => {
  for (const { sel } of REVERT_HINTS) {
    assert.ok(
      KNOWN_SELECTORS.has(sel),
      `${sel} 不在合约 ABI 里——这是个死条目，对应的提示永远不会显示（多半是写错了）`,
    );
  }
});

test("REVERT_HINTS: 无重复 selector（重复说明照抄时忘了改）", () => {
  const sels = REVERT_HINTS.map((h) => h.sel);
  assert.equal(new Set(sels).size, sels.length, `有重复：${sels.join(", ")}`);
});

test("REVERT_HINTS: 用户会撞上的 error 都必须有 hint", () => {
  const covered = new Set(REVERT_HINTS.map((h) => h.sel));
  for (const sig of USER_FACING) {
    const sel = SELECTOR_BY_SIG.get(sig);
    assert.ok(sel, `ABI 里找不到 ${sig}`);
    assert.ok(covered.has(sel!), `${sig}（${sel}）没有对应 hint，用户会看到原始报错`);
  }
});

test("REVERT_HINTS: hint 是给人看的（非空、不把 selector 抄进文案）", () => {
  for (const { sel, hint } of REVERT_HINTS) {
    assert.ok(hint.trim().length > 4, `${sel} 的 hint 太短`);
    assert.ok(!hint.includes(sel), `${sel} 的 hint 里不该出现 selector 本身`);
  }
});

test("humanizeError: 命中已知 selector 返回人话", () => {
  const expired = SELECTOR_BY_SIG.get("SignatureExpired()")!;
  const err = new Error(`execution reverted: custom error ${expired}`);
  assert.match(humanizeError(err), /签名已过期/);
});

test("humanizeError: 未知错误取首行并截断（viem 的长错误能把页面撑爆）", () => {
  const long = new Error(`${"x".repeat(300)}\nsecond line`);
  const out = humanizeError(long);
  assert.ok(!out.includes("\n"), "只取首行");
  assert.ok(out.length <= 161, `长度 ${out.length} 超限`);
  assert.ok(out.endsWith("…"));
});

test("humanizeError: 非 Error 输入也不崩", () => {
  assert.equal(typeof humanizeError("boom"), "string");
  assert.equal(typeof humanizeError(undefined), "string");
});

test("isUserRejection: 识别钱包拒绝，不误判普通链上失败", () => {
  const rejected = new Error("User rejected the request.");
  (rejected as Error & { shortMessage?: string }).shortMessage = "User rejected";
  assert.equal(isUserRejection(rejected), true);

  const code = Object.assign(new Error("denied"), { code: 4001 });
  assert.equal(isUserRejection(code), true);

  assert.equal(isUserRejection(new Error("insufficient funds")), false);
  assert.equal(isUserRejection("rejected"), false, "非 Error 不该被当成拒绝");
});
