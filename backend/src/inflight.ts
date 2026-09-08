/**
 * 已签发但尚未上链的签名槽位（in-flight）。
 *
 * 为什么需要：合约 v4 没有 per-wallet 硬上限，配额完全由后端签名把关。
 * 而 /sign 是「读链上 minted → 判断 → 签发」，中间隔着 await（RPC 往返）。
 * 用户连点两下 / 两个并发请求会读到同一个 minted（此刻都还没上链），
 * 于是 limit=1 也能签出 2 张有效签名 → 配额被突破，且链上无法回滚。
 *
 * 做法：
 *  - 进入 /sign 前**同步**占位（单线程下 claim 是原子的，没有 TOCTOU 窗口）
 *  - 占位有效期 = 签名 deadline：签名过期即作废，槽位理应一起释放
 *  - 请求被拒 / 抛错 / RPC 不可达 → release 归还，不误伤正常重试
 *  - 签发成功 → 槽位保留到 deadline（前端在这期间再要签名会被挡）
 *
 * 局限（够用即可）：状态在进程内存里，多副本部署各算各的；
 * 真要跨副本一致得把配额搬到 Redis。这里是单进程签名服务，够。
 */
export interface Slot {
  /** 归还本次占位（幂等） */
  release: () => void;
}

export class InflightSlots {
  /** wallet → (slotId → 到期 unix 秒) */
  private readonly slots = new Map<string, Map<number, number>>();
  private nextId = 1;

  /** 占位，返回归还句柄 */
  claim(wallet: string, expiresAtSec: number): Slot {
    let m = this.slots.get(wallet);
    if (!m) {
      m = new Map<number, number>();
      this.slots.set(wallet, m);
    }
    const bucket = m;
    const id = this.nextId++;
    bucket.set(id, expiresAtSec);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        bucket.delete(id);
        if (bucket.size === 0) this.slots.delete(wallet);
      },
    };
  }

  /** 当前有效占位数量（顺带清理已过期的） */
  count(wallet: string, nowSec: number = Math.floor(Date.now() / 1000)): number {
    const bucket = this.slots.get(wallet);
    if (!bucket) return 0;
    let n = 0;
    for (const [id, exp] of bucket) {
      if (exp > nowSec) {
        n += 1;
      } else {
        bucket.delete(id);
      }
    }
    if (bucket.size === 0) this.slots.delete(wallet);
    return n;
  }

  /** 测试用：清空全部状态 */
  clear(): void {
    this.slots.clear();
  }
}

/**
 * 按 key（这里 = 钱包地址）串行的极简异步锁。
 *
 * 光有槽位计数还不够：两个并发请求会**同时**占位，然后各自数到
 * pending=2 → 双双被拒（用户看到莫名的「配额已用完」）。加上锁之后
 * 同钱包的 /sign 排队执行：第 1 个拿到签名，第 2 个才轮到，它数到
 * pending=2（含第 1 个未上链的）→ 正确返回 403。
 *
 * 锁粒度是单钱包：不同钱包互不阻塞，正常流量不受影响。
 */
export class KeyedLock {
  /** key → 队尾 promise（永不 reject，保证后续排队者不会被前一个的失败带崩） */
  private tail = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tail.get(key) ?? Promise.resolve();
    const cur = prev.then(fn, fn);
    const next: Promise<void> = cur.then(
      () => undefined,
      () => undefined,
    );
    this.tail.set(key, next);
    // 队列排空后清掉 key，避免 Map 随钱包数无限增长
    void next.then(() => {
      if (this.tail.get(key) === next) this.tail.delete(key);
    });
    return cur;
  }
}
