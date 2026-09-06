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

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** 记一次命中：返回是否放行 + 剩余次数 + 距重置秒数 */
  hit(key: string, now = Date.now()): RateLimitResult {
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

  /** 测试用：清空所有状态 */
  clear() {
    this.buckets.clear();
  }
}

/** 从请求里取客户端 IP：优先 X-Forwarded-For（反向代理后），否则 socket 地址 */
export function clientIp(req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } }): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff.length) return String(xff[0]).trim();
  return req.socket?.remoteAddress ?? "unknown";
}
