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

test("allowlist: 非法地址 isAllowlisted 返回 false 不抛", async () =>
  withTempAllowlist(JSON.stringify({ [A]: { limit: 1 } }), async (p) => {
    const { loadAllowlist, isAllowlisted } = await import(
      "../src/allowlist.ts?v=" + (Date.now() + 5)
    );
    const list = loadAllowlist(p);
    assert.equal(isAllowlisted("not-an-address", list), false);
  }));
