/**
 * `/allowlist/:wallet` 的响应解析（纯函数，可被 node:test 直接跑）。
 *
 * 为什么要单独拆出来：这个端点被前端**每 4 秒轮询一次**，它的失败方式
 * 直接决定「Mint 按钮能不能点」。三种失败必须分开说，之前全塞进
 * `serviceDown`：
 *
 *  - 429：后端**活得好好的**，只是这个 IP 一分钟内请求太多次（15 次/分钟/
 *    标签页，多人共用出口 IP 时很容易撞上）。说成「签名服务不可用」会
 *    把人引去查后端进程，而真正该做的是降速。
 *  - 5xx / 网络不可达：这才是服务真挂了，该 fail-closed（禁点）。
 *  - 200 但结构不对：前后端版本不一致，也不能当成正常配额用。
 */

export type Quota = {
  allowlisted: boolean;
  limit: number;
  // minted/remaining 为 null 表示后端拿不到链上配额（RPC 不可达），
  // 不要按"还有 N 张"乐观显示，按"未知"渲染
  minted: number | null;
  remaining: number | null;
  /**
   * 已签发但还没上链的张数。后端把它算进 remaining 里（防并发超额），
   * 所以会出现「已领 0 但按钮禁用」——不显示 pending 用户会以为坏了。
   */
  pending?: number;
  /** 白名单资格是否已到期（后端 expiresAt 判定） */
  expired?: boolean;
  /** 到期时间（unix 秒），null = 永不过期 */
  expiresAt?: number | null;
};

export type QuotaPoll =
  | { kind: "ok"; quota: Quota }
  /** 后端活着，只是限流：不该禁用 Mint，只需退避重试 */
  | { kind: "rate-limited"; retryAfterSec: number; detail: string }
  /** 服务不可用（5xx / 网络层 / 结构不符）：fail-closed */
  | { kind: "down"; detail: string };

const isNumOrNull = (v: unknown): v is number | null => v === null || typeof v === "number";

/** 后端返回的配额结构对吗（缺字段时不能让 undefined 流进渲染） */
function asQuota(v: unknown): Quota | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.allowlisted !== "boolean") return null;
  if (typeof o.limit !== "number" || !Number.isFinite(o.limit)) return null;
  if (!isNumOrNull(o.minted) || !isNumOrNull(o.remaining)) return null;
  return o as unknown as Quota;
}

/**
 * @param retryAfterHeader `retry-after` 响应头（后端 429 会带）
 */
export function parseQuotaResponse(
  status: number,
  bodyText: string,
  retryAfterHeader?: string | null,
): QuotaPoll {
  let parsed: unknown = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    /* 非 JSON（网关 HTML 错误页等）：留给下面按状态码分类 */
  }

  if (status === 429) {
    // 头优先（后端权威），退而求其次读 body 里的 retryAfterSec，都没有就 10s。
    // 夹到 1..300：坏头（0 / 负数 / 巨大值）不能把轮询钉死或变成忙等。
    const fromHeader = Number(retryAfterHeader);
    const fromBody =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Number((parsed as Record<string, unknown>).retryAfterSec)
        : NaN;
    const raw = Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : fromBody;
    const retryAfterSec = Number.isFinite(raw) && raw > 0 ? Math.min(300, Math.ceil(raw)) : 10;
    const detail =
      parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).error === "string"
        ? ((parsed as Record<string, unknown>).error as string)
        : "请求过于频繁";
    return { kind: "rate-limited", retryAfterSec, detail };
  }

  if (status !== 200) {
    const t = bodyText.trim();
    const detail =
      parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).error === "string"
        ? ((parsed as Record<string, unknown>).error as string)
        : t
          ? t.slice(0, 160)
          : `HTTP ${status}（响应体为空）`;
    return { kind: "down", detail };
  }

  const quota = asQuota(parsed);
  if (!quota) {
    return {
      kind: "down",
      detail: "配额响应结构不符（缺 allowlisted/limit/minted/remaining），前后端版本可能不一致",
    };
  }
  return { kind: "ok", quota };
}
