/**
 * 错误人话化的测试。
 *
 * 这里守着两个**静默故障**（都不报错、不崩，只是提示永不出现）：
 *
 * 1. selector / 名字写错 → 匹配不上，用户看到一串原始 viem 报错。
 *    历史上踩过一次：SignatureExpired 写成 0x7248afc4（ABI 里没这个
 *    selector），「签名过期」这条最常见的路径永远显示不出人话。
 *
 * 2. **只按 hex selector 匹配**。viem 在 ABI 里有这个 error 时会解码，
 *    解码后 message 里只有名字 `Error: SignatureExpired()`，hex 只躺在
 *    `raw`/`data` 里 —— 于是 12 条提示全部是死代码，用户永远只看到
 *    `The contract function "mint" reverted.`（实测于 viem 2.56）。
 *    所以下面的用例**用真实 viem 错误对象**构造，不用手搓字符串；
 *    手搓字符串只能证明「假设成立」，证明不了真实链路。
 *
 * selector 与名字都不写死：全部用 viem 从 lib/genesisMintAbi.json 现算，
 * 合约改了 error 签名，测试自己会红。
 *
 * 跑法：cd frontend && npm test
 * （node:test + --experimental-strip-types，不引入 vitest 等新依赖）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeErrorResult,
  toFunctionSelector,
} from "viem";
import type { Abi } from "viem";
import { describeHttpFailure, REVERT_HINTS, humanizeError, isUserRejection } from "../lib/errors.ts";

type AbiError = { type: string; name?: string; inputs?: Array<{ type: string; name?: string }> };

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

/** 按类型造一个样例参数（只为让 encodeErrorResult 能跑通） */
function sampleArg(type: string): unknown {
  if (type === "address") return "0x000000000000000000000000000000000000dEaD";
  if (type === "bool") return true;
  if (type === "string") return "x";
  if (type.startsWith("bytes")) return "0x";
  return 1n;
}

/**
 * 构造**真实**的 viem revert 错误链（和浏览器里 writeContract 抛出来的一致）：
 *   ContractFunctionExecutionError(cause: ContractFunctionRevertedError(raw: 0x…))
 */
function realRevertError(sig: string): Error {
  const name = sig.slice(0, sig.indexOf("("));
  const types = sig
    .slice(sig.indexOf("(") + 1, sig.lastIndexOf(")"))
    .split(",")
    .filter(Boolean);
  const data = encodeErrorResult({
    abi: abi as unknown as Abi,
    errorName: name,
    args: types.map(sampleArg),
  });
  const reverted = new ContractFunctionRevertedError({
    abi: abi as unknown as Abi,
    data,
    functionName: "mint",
  });
  return new ContractFunctionExecutionError(reverted, {
    abi: abi as unknown as Abi,
    functionName: "mint",
    args: ["ipfs://x", 1, "0x"],
  });
}

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

test("REVERT_HINTS: 名字与 selector 必须指向同一个 error（改一处忘了另一处 = 死条目）", () => {
  for (const { sel, name } of REVERT_HINTS) {
    const derived = toFunctionSelector(name);
    assert.equal(derived, sel, `${name} 的 selector 应是 ${derived}，表里写的是 ${sel}`);
    assert.ok(SELECTOR_BY_SIG.has(name), `ABI 里找不到 ${name}`);
  }
});

test("REVERT_HINTS: 无重复 selector / 名字（重复说明照抄时忘了改）", () => {
  const sels = REVERT_HINTS.map((h) => h.sel);
  const names = REVERT_HINTS.map((h) => h.name);
  assert.equal(new Set(sels).size, sels.length, `selector 有重复：${sels.join(", ")}`);
  assert.equal(new Set(names).size, names.length, `名字有重复：${names.join(", ")}`);
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

test("humanizeError: 命中已知 selector 返回人话（裸 RPC 报错、未解码时）", () => {
  const expired = SELECTOR_BY_SIG.get("SignatureExpired()")!;
  const err = new Error(`execution reverted: custom error ${expired}`);
  assert.match(humanizeError(err), /签名已过期/);
});

test("humanizeError: 真实 viem 错误对象（已解码，只有名字没有 hex）也要命中", () => {
  for (const sig of USER_FACING) {
    const expected = REVERT_HINTS.find((h) => h.name === sig);
    assert.ok(expected, `${sig} 没有 hint`);
    const out = humanizeError(realRevertError(sig));
    assert.equal(out, expected.hint, `${sig} 的人话化没命中，实际显示：${out}`);
  }
});

test("humanizeError: 已解码但未收录的 custom error 至少带出名字，不能只说 reverted", () => {
  const out = humanizeError(realRevertError("WithdrawFailed()"));
  assert.match(out, /WithdrawFailed/, `实际显示：${out}`);
  assert.ok(!/^The contract function/.test(out), "不该把 viem 的套话当错误原因");
});

test("humanizeError: Error(string) 的 reason 要显示出来（viem 放在 message 第 3 行）", () => {
  const errAbi = [
    { type: "error", name: "Error", inputs: [{ type: "string", name: "message" }] },
  ] as unknown as Abi;
  const data = encodeErrorResult({ abi: errAbi, errorName: "Error", args: ["余额不足"] });
  const err = new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: errAbi, data, functionName: "mint" }),
    { abi: errAbi, functionName: "mint" },
  );
  assert.equal(humanizeError(err), "余额不足");
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
  assert.equal(humanizeError("boom"), "boom");
});

test("humanizeError: 循环 cause 不会死循环（第三方库可能造出环形引用）", () => {
  const a = new Error("a");
  const b = new Error("b");
  (a as Error & { cause?: unknown }).cause = b;
  (b as Error & { cause?: unknown }).cause = a;
  assert.equal(typeof humanizeError(a), "string");
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

test("describeHttpFailure: HTML 错误页要指向反向代理，而不是「Unexpected token」", () => {
  const msg = describeHttpFailure(502, "<html><body>Bad Gateway</body></html>");
  assert.match(msg, /HTTP 502/);
  assert.match(msg, /反向代理|网关/);
  assert.ok(!msg.includes("Unexpected token"));
});

test("describeHttpFailure: 空响应体单独说明（不是同一句「未知错误」）", () => {
  assert.match(describeHttpFailure(500, "   "), /响应体为空/);
});

test("describeHttpFailure: 普通文本体截断到 120 字以内", () => {
  const out = describeHttpFailure(400, "x".repeat(300));
  assert.ok(out.length <= 130, `长度 ${out.length} 超限`);
  assert.ok(out.endsWith("…"));
});
