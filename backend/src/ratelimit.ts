import { isIP } from "node:net";

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
  /** 累计全量清扫次数（测试 / 排障：用来证明热路径没有退化成每请求一次 O(n)） */
  private sweepCount = 0;
  private warnedOverflow = false;

  constructor(max: number, windowMs: number, opts: { maxKeys?: number } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    // 至少留 1 个桶，否则淘汰逻辑会把刚插入的也删掉
    this.maxKeys = Math.max(1, Math.floor(opts.maxKeys ?? 50_000));
  }

  /**
   * 记一次命中：返回是否放行 + 剩余次数 + 距重置秒数。
   *
   * 惰性清扫分两件事，**不能混**：
   *  - 过期回收：按**时间**触发，每个窗口最多一次 O(n) 全表扫；
   *  - 容量淘汰：按**数量**触发，从 Map 头部（最老）删掉溢出量，O(溢出量)。
   *
   * 之前把「桶数 >= maxKeys」也当成清扫条件，于是桶满之后**每一次请求**
   * 都全表扫一遍（50k 个桶 = 每请求 5 万次迭代）。泛洪时这不是限流，是
   * CPU 放大器：攻击者只需把桶填满，之后每个请求都让我们做 O(n) 工作。
   */
  hit(key: string, now = Date.now()): RateLimitResult {
    if (this.buckets.size > 0 && now - this.lastSweepAt >= this.windowMs) {
      this.sweepExpired(now);
    }
    const b = this.buckets.get(key);
    if (!b || now >= b.resetAt) {
      this.insert(key, { count: 1, resetAt: now + this.windowMs });
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

  /** 插入新桶（已有同名桶则覆盖），必要时先按溢出量淘汰最老的 */
  private insert(key: string, bucket: { count: number; resetAt: number }): void {
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) {
      // 同一窗口内涌进海量不同 IP：清扫不掉，只能淘汰。代价是最老的桶计数
      // 归零（限流对它们临时放宽），换来的是内存有界——OOM 比放宽糟得多。
      this.evictOldest(this.buckets.size - this.maxKeys + 1);
    }
    this.buckets.set(key, bucket);
  }

  /** 清掉已过期的桶 */
  private sweepExpired(now: number): void {
    this.lastSweepAt = now;
    this.sweepCount += 1;
    for (const [k, b] of this.buckets) {
      if (now >= b.resetAt) this.buckets.delete(k);
    }
  }

  /** 从最老的开始删 count 个（Map 保序，只做 O(count)，不扫全表） */
  private evictOldest(count: number): void {
    let left = count;
    for (const k of this.buckets.keys()) {
      if (left-- <= 0) break;
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

  /** 累计全量清扫次数（测试 / 排障用） */
  get sweeps(): number {
    return this.sweepCount;
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
  opts: { trustProxy?: boolean; trustHops?: number } = {},
): string {
  const socketIp = req.socket?.remoteAddress ?? "unknown";
  if (!opts.trustProxy) return socketIp;

  const xff = req.headers["x-forwarded-for"];
  const raw = typeof xff === "string" ? xff : Array.isArray(xff) ? xff.map(String).join(",") : "";
  // XFF 形如 "client, proxy1, proxy2"：**最左是客户端，越右越靠近本服务**。
  // 常见 Nginx 配置 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
  // 是 append —— 客户端能往最左边塞任意假 IP（每次换 = 每次一个新限流桶，绕过限流）。
  // 所以不能取最左（首位），要从右往左数第 N 跳（N = 自己信任的代理层数）：
  // 右侧那几段是代理自己写上去的，客户端伪造不了。N 默认 1 = 最右一段。
  const hops = Number.isFinite(opts.trustHops) ? Math.max(1, Math.floor(opts.trustHops!)) : 1;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return socketIp;
  // 段数少于声明的信任跳数 = 实际链路与配置不符（少了一层代理，或请求绕过
  // 代理直连）。此时 XFF 里**根本不存在**「我方代理写入、客户端改不了」的那
  // 一段：最左是客户端可伪造的，照取等于把限流键交给客户端 → 换值即换桶。
  // 宁可回落 socket（真实 TCP 对端，伪造不了）：代价是所有请求挤到代理那
  // 一个 IP、更容易撞限流——可用性问题一眼能从访问日志看出来；而限流被绕
  // 过是安全问题，悄无声息。
  if (parts.length < hops) return socketIp;
  const chosen = parts[parts.length - hops];
  // 仍要校验是合法 IP：伪造的 "abc" / "1.2.3.4:9999" 之类不能当限流键，
  // 否则一个字符串一个桶照样绕过；不合法就回落到伪造不了的真实 TCP 对端。
  return isIP(chosen) ? chosen : socketIp;
}
