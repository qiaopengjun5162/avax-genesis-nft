/**
 * `NEXT_PUBLIC_*` 归一化的测试。
 *
 * 这两个函数修的是「配置写错、但报错指向别处」的坑：
 *  - 空串 → 拼出相对路径，打到 Next 自己的路由（404 而不是「后端没配」）
 *  - 尾斜杠 → 拼出 `//sign`，部分网关直接 404
 * 这类问题只在部署时出现，本地 `.env` 写对了永远复现不了。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBaseUrl, pickAddress } from "../lib/env.ts";

const DEFAULT = "http://127.0.0.1:8787";

test("normalizeBaseUrl: 未设置 / 空串 / 纯空白都回退默认值", () => {
  assert.equal(normalizeBaseUrl(undefined, DEFAULT), DEFAULT);
  assert.equal(normalizeBaseUrl("", DEFAULT), DEFAULT);
  assert.equal(normalizeBaseUrl("   ", DEFAULT), DEFAULT);
});

test("normalizeBaseUrl: 去掉尾部斜杠（含多个），避免拼出 //sign", () => {
  assert.equal(normalizeBaseUrl("https://api.example.com/", DEFAULT), "https://api.example.com");
  assert.equal(normalizeBaseUrl("https://api.example.com///", DEFAULT), "https://api.example.com");
  assert.equal(normalizeBaseUrl("  https://api.example.com/v1/  ", DEFAULT), "https://api.example.com/v1");
});

test("normalizeBaseUrl: 保留端口与路径，不做多余改写", () => {
  assert.equal(normalizeBaseUrl("http://1.2.3.4:8791", DEFAULT), "http://1.2.3.4:8791");
});

test("pickAddress: 空值回退演示合约，非空原样透传", () => {
  const fallback = "0x48c9F7B4911Da705BD3285173B333b37CcB4a550";
  assert.equal(pickAddress(undefined, fallback), fallback);
  assert.equal(pickAddress("  ", fallback), fallback);
  assert.equal(pickAddress(" 0xAbCd ", fallback), "0xAbCd");
});

test("pickAddress: 格式错误的地址不静默回退（否则会铸到别人的合约上）", () => {
  const fallback = "0x48c9F7B4911Da705BD3285173B333b37CcB4a550";
  assert.equal(pickAddress("0xnot-an-address", fallback), "0xnot-an-address");
});
