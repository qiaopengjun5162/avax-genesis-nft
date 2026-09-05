/**
 * env.ts 单元测试：node:test 原生 runner（Node ≥22，无第三方依赖）
 * 跑法：cd backend && npm test
 *
 * 注：env.ts 顶层有 `export const env = loadEnv()` 的副作用——测试
 * 用绝对路径调用 loadEnv(path)，避免每次 chdir 触发模块副作用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withTempEnv(content: string, fn: (path: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "env-"));
  const p = join(dir, ".env.test");
  writeFileSync(p, content);
  try {
    await fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function loadAt(path: string) {
  // 动态 import + query string 防止 Node 缓存上次结果
  const mod = await import(`../src/env.ts?v=${Date.now()}-${Math.random()}`);
  return mod.loadEnv(path);
}

test("env: 读取标准 KEY=VALUE", async () =>
  withTempEnv("FOO=bar\nBAZ=qux\n", async (p) => {
    const e = await loadAt(p);
    assert.equal(e.FOO, "bar");
    assert.equal(e.BAZ, "qux");
  }));

test("env: 自动 strip 引号（双引号 / 单引号）", async () =>
  withTempEnv(`A="quoted"\nB='quoted'\n`, async (p) => {
    const e = await loadAt(p);
    assert.equal(e.A, "quoted");
    assert.equal(e.B, "quoted");
  }));

test("env: 跳过 # 注释行 + 行尾注释", async () =>
  withTempEnv("# 整行注释\nFOO=bar # 行尾注释\n#BAR=ignored\n", async (p) => {
    const e = await loadAt(p);
    assert.equal(e.FOO, "bar");
    assert.equal("BAR" in e, false);
  }));

test("env: 支持 export 前缀", async () =>
  withTempEnv("export FOO=with-export\n", async (p) => {
    const e = await loadAt(p);
    assert.equal(e.FOO, "with-export");
  }));

test("env: 键名不合法（数字开头 / 包含连字符）则跳过", async () =>
  withTempEnv("FOO=keep\n1bad=skip\ndash-case=skip\n", async (p) => {
    const e = await loadAt(p);
    assert.equal(e.FOO, "keep");
    assert.equal("1bad" in e, false);
    assert.equal("dash-case" in e, false);
  }));

test("env: trim 键 / 值的空白", async () =>
  withTempEnv("FOO = bar  \n", async (p) => {
    const e = await loadAt(p);
    assert.equal(e.FOO, "bar");
  }));

test("env: 路径不存在时静默返回空对象", async () => {
  const e = await loadAt("/definitely/does/not/exist/" + Date.now() + ".env");
  assert.deepEqual(e, {});
});

test("env: URL 中的 # 不当作注释（前面没空白）", async () =>
  withTempEnv("URL=https://a.b/c#anchor\nFOO=bar\n", async (p) => {
    const e = await loadAt(p);
    assert.equal(e.URL, "https://a.b/c#anchor");
    assert.equal(e.FOO, "bar");
  }));

test("env: 空值也成键（EMPTY= → 空字符串）", async () =>
  withTempEnv("EMPTY=\n", async (p) => {
    const e = await loadAt(p);
    // 空值与缺省要区分，否则 caller 无法判断是否"未配置"
    assert.equal(e.EMPTY, "");
    assert.equal("MISSING" in e, false);
  }));

test("env: 行内 # 只有前置空白才算行尾注释", async () =>
  // `FOO=bar#nospace` 后端老逻辑会错误去除；新逻辑要求 # 前置空白
  withTempEnv("FOO=bar#nospace\n", async (p) => {
    const e = await loadAt(p);
    assert.equal(e.FOO, "bar#nospace");
  }));
