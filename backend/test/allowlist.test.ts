/**
 * allowlist.ts 单测：loadAllowlist 文件不存在 + 地址 checksum + entryFor
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

async function withTempAllowlist(content: string, fn: (path: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "al-"));
  const p = join(dir, "allowlist.test.json");
  writeFileSync(p, content);
  try {
    await fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("allowlist: 加载并存为 checksum 地址", async () =>
  withTempAllowlist(JSON.stringify({ [A]: { limit: 2 } }), async (p) => {
    const { loadAllowlist } = await import("../src/allowlist.ts?v=" + Date.now());
    const list = loadAllowlist(p);
    // 小写入、读出为 checksum
    assert.ok(list[A], "checksum 形式应能匹配");
    assert.equal(list[A].limit, 2);
  }));

test("allowlist: 加载时小写地址也被归一为 checksum", async () =>
  withTempAllowlist(
    JSON.stringify({ [A.toLowerCase()]: { limit: 3 } }),
    async (p) => {
      const { loadAllowlist } = await import("../src/allowlist.ts?v=" + (Date.now() + 1));
      const list = loadAllowlist(p);
      // 归一化后，原大写 key 应能命中
      assert.ok(list[A]);
      assert.equal(list[A].limit, 3);
    },
  ));

test("allowlist: 文件缺失静默返回空对象", async () => {
  const { loadAllowlist } = await import("../src/allowlist.ts?v=" + (Date.now() + 2));
  const list = loadAllowlist("/definitely/does/not/exist/" + Date.now() + ".json");
  assert.deepEqual(list, {});
});

test("allowlist: 缺 limit 字段或非法 → 默认 1", async () =>
  withTempAllowlist(
    JSON.stringify({ [A]: { limit: -5 }, [B]: {} }),
    async (p) => {
      const { loadAllowlist } = await import("../src/allowlist.ts?v=" + (Date.now() + 3));
      const list = loadAllowlist(p);
      assert.equal(list[A].limit, 1, "负值/0 都被夹到 1");
      assert.equal(list[B].limit, 1, "缺省填 1");
    },
  ));

test("allowlist: isAllowlisted / entryFor 大小写都认", async () =>
  withTempAllowlist(JSON.stringify({ [A]: { limit: 2 } }), async (p) => {
    const { loadAllowlist, isAllowlisted, entryFor } = await import(
      "../src/allowlist.ts?v=" + (Date.now() + 4)
    );
    const list = loadAllowlist(p);
    assert.ok(isAllowlisted(A, list));
    assert.ok(isAllowlisted(A.toLowerCase(), list));
    assert.ok(entryFor(A.toLowerCase(), list)?.limit === 2);
    assert.ok(!isAllowlisted(B, list));
    assert.equal(entryFor(B, list), undefined);
  }));

test("allowlist: expiresAt 支持 ISO 字符串 / unix 秒 / 毫秒", async () =>
  withTempAllowlist(
    JSON.stringify({
      [A]: { limit: 2, expiresAt: "2026-10-01T00:00:00.000Z" },
      [B]: { limit: 2, expiresAt: 1800000000 },
    }),
    async (p) => {
      const { loadAllowlist } = await import("../src/allowlist.ts?v=" + (Date.now() + 6));
      const list = loadAllowlist(p);
      assert.equal(list[A].expiresAt, Date.parse("2026-10-01T00:00:00.000Z") / 1000);
      assert.equal(list[B].expiresAt, 1800000000);
    },
  ));

test("allowlist: expiresAt 缺省/非法 → 永不过期（不静默拒绝）", async () =>
  withTempAllowlist(
    JSON.stringify({ [A]: { limit: 2 }, [B]: { limit: 2, expiresAt: "下周三" } }),
    async (p) => {
      const { loadAllowlist, isExpired } = await import(
        "../src/allowlist.ts?v=" + (Date.now() + 7)
      );
      const list = loadAllowlist(p);
      // 配错的到期时间若被当成"过期"，整批人会被无声拒之门外——宁可放行
      assert.equal(list[A].expiresAt, null);
      assert.equal(list[B].expiresAt, null);
      assert.equal(isExpired(list[B]), false);
    },
  ));

test("allowlist: isExpired 边界 —— 到期那一刻仍算有效", async () => {
  const { isExpired } = await import("../src/allowlist.ts?v=" + (Date.now() + 8));
  const at = 1800000000;
  const entry = { limit: 1, expiresAt: at };
  assert.equal(isExpired(entry, at - 1), false);
  assert.equal(isExpired(entry, at), false, "「有效期至当天」应包含当天");
  assert.equal(isExpired(entry, at + 1), true);
  assert.equal(isExpired(undefined, at), false, "没有条目不算过期");
});

test("allowlist: 一条地址写错只跳过它，不把整份白名单清空", async () =>
  withTempAllowlist(
    // 有人手抄地址少一位、或误留模板占位符，都会走到这条路径
    JSON.stringify({ [A]: { limit: 2 }, "0xNOT_AN_ADDRESS": { limit: 5 } }),
    async (p) => {
      const { loadAllowlist } = await import("../src/allowlist.ts?v=" + (Date.now() + 9));
      const list = loadAllowlist(p);
      assert.equal(Object.keys(list).length, 1, "坏 key 被跳过，好的那条必须留下");
      assert.equal(list[A].limit, 2);
      // 反面情形：整份被吞掉 = 所有人 403 且毫无提示，正是要避免的
    },
  ));

test("allowlist: 非法地址 isAllowlisted 返回 false 不抛", async () =>
  withTempAllowlist(JSON.stringify({ [A]: { limit: 1 } }), async (p) => {
    const { loadAllowlist, isAllowlisted } = await import(
      "../src/allowlist.ts?v=" + (Date.now() + 5)
    );
    const list = loadAllowlist(p);
    assert.equal(isAllowlisted("not-an-address", list), false);
  }));
