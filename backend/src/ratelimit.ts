/**
 * 极简内存固定窗口限流器（单进程足够；多副本需换 Redis/共享存储）。
 *
 * 为什么需要：/sign 与 /allowlist 都是匿名端点，每次调用都要读链上
 * numberMinted/totalSupply（RPC）+ 可能签名。没有限流，任何人都能用
 * 脚本把 RPC 配额打满、把签名服务的 CPU 吃光——典型的匿名 DoS 面。
 *
 * 固定窗口足够本场景：实现简单、无时钟漂移问题；缺点是窗口边界处
 * 允许约 2× 突发，但对一个演示签名服务可接受（真要平滑用令牌桶再换）。
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  /** 桶数量硬上限：超过就淘汰最老的，宁可牺牲计数精度也不让内存无上限 */
  private readonly maxKeys: number;
  private lastSweepAt = 0;
  private warnedOverflow = false;

  constructor(max: number, windowMs: number, opts: { maxKeys?: number } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = opts.maxKeys ?? 50_000;
  }

  /**
   * 记一次命中：返回是否放行 + 剩余次数 + 距重置秒数。
   *
   * 惰性清扫：桶过了窗口就永远不会被读到，不回收的话 Map 会随「来访过的
   * 不同 IP 数」单调增长——限流本身反而成了内存 DoS 面。每窗口最多扫一次
   * （O(n)），key 数超阈值时立刻扫，避免突发流量把 Map 撑大。
   */
  hit(key: string, now = Date.now()): RateLimitResult {
    if (this.buckets.size > 0 && (now - this.lastSweepAt >= this.windowMs || this.buckets.size >= this.maxKeys)) {
      this.sweep(now);
    }
    const b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.max - 1, retryAfterSec: 0 };
    }
    if (b.count >= this.max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.ceil((b.resetAt - now) / 1000),
      };
    }
    b.count += 1;
    return { allowed: true, remaining: this.max - b.count, retryAfterSec: 0 };
  }

  /** 清掉已过期的桶；仍超限则按插入顺序淘汰最老的（Map 保序） */
  private sweep(now: number): void {
    this.lastSweepAt = now;
    for (const [k, b] of this.buckets) {
      if (now >= b.resetAt) this.buckets.delete(k);
    }
    if (this.buckets.size <= this.maxKeys) return;
    // 同一窗口内涌进海量不同 IP：清扫不掉，只能淘汰。代价是最老的桶计数
    // 归零（限流对它们临时放宽），换来的是内存有界——OOM 比放宽糟得多。
    let overflow = this.buckets.size - this.maxKeys;
    for (const k of this.buckets.keys()) {
      if (overflow-- <= 0) break;
      this.buckets.delete(k);
    }
    if (!this.warnedOverflow) {
      this.warnedOverflow = true;
      console.warn(`⚠️  限流 key 数超过 ${this.maxKeys}，已淘汰最老的桶（疑似 IP 泛洪扫描）`);
    }
  }

  /** 当前桶数量（测试 / 排障用） */
  get size(): number {
    return this.buckets.size;
  }

  /** 测试用：清空所有状态 */
  clear() {
    this.buckets.clear();
  }
}

/**
 * 取客户端 IP —— 限流的计数键，取错等于限流形同虚设。
 *
 * X-Forwarded-For 是**客户端可伪造**的请求头：攻击者每次换一个值就能
 * 拿到一个全新桶，30 次/分钟的限流直接被绕过。所以默认只认 socket 地址
 * （真实 TCP 对端，伪造不了）；只有明确声明「我前面有可信反向代理」
 * （TRUST_PROXY=1）时才读 XFF。
 *
 * 代价要说清：部署在 Nginx / LB 后面却忘了开 TRUST_PROXY，所有请求都会
 * 被算成代理那一个 IP —— 表现为「一个人触发限流，全场 429」。两个方向
 * 都不好，但被绕过（安全）比被误杀（可用性，且日志里一眼可见）更糟。
 */
export function clientIp(
  req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } },
  opts: { trustProxy?: boolean } = {},
): string {
  if (opts.trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
    if (Array.isArray(xff) && xff.length) return String(xff[0]).trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}
