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
  /**
   * wallet → 上次对账时读到的链上 numberMinted。
   * 用来识别「签名已经上链」：链上每多铸一张，就有一个在途槽位该释放。
   * 没有它，已上链的签名会同时算在 minted 和 pending 里（双算），
   * limit=2 的用户铸完第 1 张后 1 小时内签不了第 2 张。
   */
  private readonly mintedBaseline = new Map<string, number>();
  private nextId = 1;
  private claimsSinceSweep = 0;

  /** 占位，返回归还句柄 */
  claim(wallet: string, expiresAtSec: number): Slot {
    // count() 只清「被查询的那个钱包」的过期槽位：用户签完就再没回来过，
    // 那笔记录会一直躺着。定期全局扫一遍才收得掉。
    if (++this.claimsSinceSweep >= 64) this.sweep();
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

  /**
   * 与链上已铸数量对账：链上每多一张，就释放一个最早的在途槽位。
   *
   * 为什么要做：槽位只在 deadline（1h）到期才释放，但用户往往签完立刻上链。
   * 上链后这张 NFT 既算在链上 minted 里、又还占着 pending 槽位——被算两次。
   * 于是 limit=2 的用户铸完第 1 张后，1h 内签第 2 张都会撞 403「配额已用完」。
   *
   * 槽位只做计数、不绑定具体签名，所以按 FIFO 释放最早的即可：
   * 释放数量 = minted 增量，总数守恒，不会多放（不会让超额签发出去）。
   *
   * 首次调用只记基线不释放：进程启动时链上可能已铸 N 张，那 N 张不是本
   * 进程的槽位，贸然释放会误伤刚 claim 的在途签名。
   */
  reconcileMinted(wallet: string, mintedOnChain: number): number {
    if (!this.mintedBaseline.has(wallet)) {
      this.mintedBaseline.set(wallet, mintedOnChain);
      return 0;
    }
    const prev = this.mintedBaseline.get(wallet)!;
    // 链上读数单调。回退（RPC 读到旧块 / 换了个落后的节点）时基线**不能**
    // 跟着往回调——否则抖动一恢复，增量就被算成「又铸了一张」，误放槽位
    // → 在途签名被当成已上链，用户明明没铸却被放号。
    if (mintedOnChain <= prev) return 0;
    this.mintedBaseline.set(wallet, mintedOnChain);

    const bucket = this.slots.get(wallet);
    if (!bucket) return 0;
    let released = 0;
    const toRelease = mintedOnChain - prev;
    // Map 保持插入顺序 → 最早的在前面（FIFO）
    for (const id of bucket.keys()) {
      if (released >= toRelease) break;
      bucket.delete(id);
      released += 1;
    }
    if (bucket.size === 0) this.slots.delete(wallet);
    return released;
  }

  /**
   * 全局清扫：回收所有已过期槽位（含从没人再查过的钱包），返回清掉的个数。
   * 单进程签名服务的钱包数有限，O(n) 全扫很便宜。
   */
  sweep(nowSec: number = Math.floor(Date.now() / 1000)): number {
    this.claimsSinceSweep = 0;
    let removed = 0;
    for (const [wallet, bucket] of this.slots) {
      for (const [id, exp] of bucket) {
        if (exp <= nowSec) {
          bucket.delete(id);
          removed += 1;
        }
      }
      if (bucket.size === 0) this.slots.delete(wallet);
    }
    return removed;
  }

  /** 当前有多少个钱包占着槽位（测试 / 排障用） */
  get walletCount(): number {
    return this.slots.size;
  }

  /** 测试用：清空全部状态 */
  clear(): void {
    this.slots.clear();
    this.mintedBaseline.clear();
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
