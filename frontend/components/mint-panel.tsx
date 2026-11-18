"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { CONTRACT_ADDRESS, SIGNER_URL, STATUS_TEXT, explorerTx, FAUCET_URL } from "@/lib/config";
import { genesisMintAbi } from "@/lib/abi";
import { resolveImageUrl } from "@/lib/media";
import { describeHttpFailure, humanizeError, isUserRejection } from "@/lib/errors";
import { parseQuotaResponse, type Quota } from "@/lib/quota";

const btnPrimary =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50";
const inputCls =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";

function fmtExpiry(sec: number | null | undefined): string {
  if (!sec) return "";
  return new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false });
}

/**
 * mint 三幕剧（v3：签名按次授权，同一钱包可 mint 多张，每张可自选图）：
 *  ① 连接钱包（白名单钱包，配额 = limit 张）
 *  ② 选图：留空 = 后端分配创世图；填 URL = 自己的图
 *  ③ POST /sign → {imageURI, deadline, signature} → 调合约 mint(imageURI, deadline, signature)
 */
export default function MintPanel({
  priceWei = 0n,
  priceReady = false,
  priceError = false,
}: {
  priceWei?: bigint;
  priceReady?: boolean;
  /** 读链上 price() 失败（RPC 不可达 / 合约地址错）：与「还在读」要分开说 */
  priceError?: boolean;
}) {
  const { address, isConnected, chainId } = useAccount();
  const { writeContractAsync } = useWriteContract();

  const [busy, setBusy] = useState<"signing" | "mining" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [customUri, setCustomUri] = useState("");
  const [artPreview, setArtPreview] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  /**
   * 后端整体不可用（没起 / 5xx / 网络不可达）。此时 /allowlist 拿不到配额，
   * 之前是静默吞掉 → 用户还能点 Mint 撞 503。现在显式标出来并禁用按钮，
   * 让 fail-closed 在前端也可见：连不上后端就不该让人去签。
   *
   * 注意**不含 429**：限流说明后端活着，只是我们轮询太快（15 次/分钟/标签页，
   * 多人共用一个出口 IP 时很容易撞）。把它说成「服务不可用」会把人引去查
   * 后端进程，而且会无辜禁掉 Mint —— 真正的配额判定在后端 /sign。
   */
  const [serviceDown, setServiceDown] = useState(false);
  const [serviceDetail, setServiceDetail] = useState<string | null>(null);
  /** 当前处于限流退避期：剩余秒数（0 = 没被限流） */
  const [rateLimitedSec, setRateLimitedSec] = useState(0);
  /** 退避截止时间戳。轮询照常 tick，但在截止前直接返回，不再打后端 */
  const backoffUntil = useRef(0);

  const { data: receipt } = useWaitForTransactionReceipt({ hash: txHash as `0x${string}` | undefined });
  const txOk = receipt?.status === "success";
  const txFailed = receipt?.status === "reverted";

  const wrongChain = isConnected && chainId !== 43113;

  // 连上后预检配额（含轮询，mint 后自动更新）
  const fetchQuota = useCallback(async () => {
    if (!address) return;
    // 限流退避期：不打后端（否则每 4s 继续撞 429，桶永远不会回血）
    if (Date.now() < backoffUntil.current) return;
    try {
      // 15s 超时：RPC 慢 + 同钱包锁排队都可能在 8s 上限（RPC_QUERY_TIMEOUT_MS）
      // 之后再卡几秒。给个总上限就免得「按钮卡在 ① 向后端要签名…」。
      const r = await fetch(`${SIGNER_URL}/allowlist/${address}`, {
        signal: AbortSignal.timeout(15_000),
      });
      // 先读文本再解析：网关 5xx 回的是 HTML，直接 r.json() 只会抛
      // `Unexpected token '<'`，指不到根因
      const text = await r.text();
      const outcome = parseQuotaResponse(r.status, text, r.headers.get("retry-after"));

      if (outcome.kind === "ok") {
        setQuota(outcome.quota);
        setServiceDown(false);
        setServiceDetail(null);
        setRateLimitedSec(0);
        return;
      }
      if (outcome.kind === "rate-limited") {
        // 服务是好的，只是我们太快：保留上一轮配额（比清空更有用），退避重试
        backoffUntil.current = Date.now() + outcome.retryAfterSec * 1000;
        setRateLimitedSec(outcome.retryAfterSec);
        return;
      }
      // 真失败：fail-closed，禁用 Mint 并说明原因（别再只说「连不上」）
      setServiceDown(true);
      setServiceDetail(outcome.detail);
    } catch {
      // 后端没起 / 超时 / 网络不可达：同样视为服务不可用
      setServiceDown(true);
      setServiceDetail("请求超时或网络不可达");
    }
  }, [address]);

  // 轮询配额（含初始拉取）。轮询属于「事件」而非「渲染同步」，
  // 用 useEffectEvent 包一层避免被当依赖。
  const pollQuota = useEffectEvent(() => {
    void fetchQuota();
  });

  useEffect(() => {
    // 初始拉取 + 每 4s tick 的 setState 都在 await 之后（异步），
    // 不会触发规则担心的同步级联渲染；该规则无法区分同步/异步故误报，
    // 精确关闭此行（不关全局，保留其对真同步 bug 的检测价值）。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    pollQuota();
    const t = setInterval(pollQuota, 4000);
    return () => clearInterval(t);
  }, []);

  // 切钱包时立刻清掉上一个账户的所有状态：quota / error / 预览图 / tx
  // ——否则切完会看到 A 钱包的「已领 1/3」、A 钱包的报错、A 钱包的交易
  // hash，最多等 4s 轮询才会刷成 B 的，期间还能点 mint（按钮条件只看
  // quotaDone，未对 address 做 key），最坏情况是用户按 A 的状态判断、
  // 调 B 的签名 + B 的链上交易，4s 后才发现走错了。
  useEffect(() => {
    // 这四个 setState 跟 address 是直接绑定（address 变 → 状态必须跟着变），
    // 属于 effect 的合法用法；set-state-in-effect 规则无法区分这种「依赖
    // 同步重置」与「同步级联渲染」，故误报。关单行，不关全局。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuota(null);
    setError(null);
    setArtPreview(null);
    setTxHash(null);
    setServiceDown(false);
    setServiceDetail(null);
    setRateLimitedSec(0);
    // 换钱包要清退避：上一个地址撞的限流不该让新地址继续等着
    backoffUntil.current = 0;
  }, [address]);

  async function onMint() {
    if (!address) return;
    setError(null);
    setTxHash(null);
    try {
      // ① 向后端要签名（带用户自选图，若有）
      setBusy("signing");
      const body: Record<string, string> = { wallet: address };
      if (customUri.trim()) body.imageURI = customUri.trim();
      const res = await fetch(`${SIGNER_URL}/sign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        // 20s：含 RPC 核验（8s timeout）+ in-flight 排队 + 链上读写。超出
        // 即取消，下次点 mint 重新要签名
        signal: AbortSignal.timeout(20_000),
      });
      // 先读文本再自己 parse：直接 res.json() 碰到 HTML 错误页（Nginx/网关
      // 5xx、SIGNER_URL 配错打到别的服务）会抛 `Unexpected token '<'`，
      // 那个报错指向不了真因。非 JSON 时交给 describeHttpFailure 说清楚。
      const text = await res.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        const v: unknown = text ? JSON.parse(text) : null;
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          parsed = v as Record<string, unknown>;
        }
      } catch {
        /* 非 JSON：parsed 保持 null，下面按 HTTP 失败处理 */
      }
      if (!res.ok || parsed === null) {
        const msg =
          typeof parsed?.error === "string" ? parsed.error : describeHttpFailure(res.status, text);
        setError(`签名服务拒绝：${msg}`);
        return;
      }

      // 字段形状校验：后端升/降级导致字段缺失时，别把 undefined 交给钱包
      // （那样报错会变成 "cannot convert undefined to bigint"，完全查不到源头）
      const { imageURI, deadline, signature } = parsed;
      if (typeof imageURI !== "string" || typeof deadline !== "number" || typeof signature !== "string") {
        setError("签名服务返回的字段不全（imageURI / deadline / signature），前后端版本可能不一致");
        return;
      }

      setArtPreview(imageURI);
      // 后端返回的 remaining 已扣掉这张刚签的（含在飞的），直接用；
      // 用 updater 拿 prev（而不是闭包里的 quota），避免读到上一轮的旧值
      const numOr = <T extends number | null>(v: unknown, fallback: T): number | T =>
        typeof v === "number" ? v : fallback;
      setQuota((prev) => ({
        minted: numOr(parsed.minted, prev?.minted ?? null),
        limit: numOr(parsed.limit, prev?.limit ?? 0),
        remaining: numOr(parsed.remaining, prev?.remaining ?? null),
        pending: (prev?.pending ?? 0) + 1,
        allowlisted: true,
      }));

      // ② 带签名上链（deadline 由后端签发，签名绑定，前端原样透传）
      setBusy("mining");
      const hash = await writeContractAsync({
        address: CONTRACT_ADDRESS,
        abi: genesisMintAbi,
        functionName: "mint",
        args: [imageURI, deadline, signature as `0x${string}`],
        // value 必须等于链上 price()：合约 mint 是 payable 且 `if (msg.value < price)
        // revert EtherAmountMismatch`。之前硬编码 0n，owner 一旦 setPrice 设价 mint
        // 必失败。price 由 page 读链上 price 传入，与展示一致。
        value: priceWei,
      });
      setTxHash(hash);
    } catch (e) {
      // AbortSignal.timeout 抛 DOMException（name=TimeoutError，AbortError 的子类），
      // 人话化只会得到「The user aborted a request」这种没头没尾的
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        setError("请求超时：签名服务 20 秒内没回（后端可能挂了或链上 RPC 卡着），重试一次");
      } else if (isUserRejection(e)) {
        // 钱包里点了「拒绝」：不算失败，提示一下即可，按钮已在 finally 里恢复可重点
        setError("你取消了签名/交易（钱包里点了拒绝）。要 mint 就再点一次 Mint。");
      } else {
        setError(humanizeError(e));
      }
    } finally {
      setBusy(null);
    }
  }

  if (!isConnected || !address) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-dashed border-gray-300 p-6 text-sm text-gray-500">
          先连接钱包。白名单钱包按配额 mint（默认每个钱包可领多张，测试不用换账户）。
        </div>
        <p className="text-xs text-gray-500">
          钱包里没测试 AVAX？gas 需要一点点（mint 本身免费）——
          <a className="text-blue-600 underline" href={FAUCET_URL} target="_blank" rel="noreferrer">
            Core 水龙头领测试币
          </a>
          （24h 冷却）。
        </p>
      </div>
    );
  }

  const quotaDone = Boolean(
    quota && quota.allowlisted && quota.remaining !== null && quota.remaining <= 0,
  );
  // 白名单内但 minted/remaining 都是 null（后端 fail-closed：链上配额核验失败）
  const quotaUnknown = Boolean(
    quota && quota.allowlisted && quota.minted === null && quota.remaining === null,
  );
  // 有签名在飞：后端预留了名额，签名过期（默认 1h）或上链后自动释放
  const pending = quota?.pending ?? 0;
  // 资格到期：后端此时 allowlisted 也是 false，但原因不同——不说清楚用户会
  // 以为「我没在名单里」，其实是「曾经在，过期了」
  const quotaExpired = Boolean(quota?.expired);
  // 后端整体不可用（没起 / 5xx / 网络不可达）：fail-closed 在前端也可见
  const backendDown = serviceDown;

  return (
    <div className="space-y-4">
      {wrongChain && (
        <p className="text-sm font-medium text-red-600">⚠ 当前链不是 Fuji，mint 会失败——请切到 Avalanche Fuji。</p>
      )}

      {backendDown && (
        <p className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">
          ⏳ 签名服务暂时连不上（后端没启动 / 报错 / 网络不可达），连上后会自动恢复——稍等或检查后端进程。
          {serviceDetail && (
            <span className="mt-1 block break-all font-mono text-xs text-yellow-700">{serviceDetail}</span>
          )}
        </p>
      )}

      {rateLimitedSec > 0 && !backendDown && (
        /**
         * 429 单独说：后端是活的，只是这个 IP 一分钟内轮询太多
         * （前端每 4s 一次 = 15 次/分钟/标签页，多人共用一个出口 IP 时很容易撞）。
         * 不显示这句的话，用户会把它当成「服务挂了」；也不该因此禁用 Mint——
         * 配额是否真的够，最终由后端 /sign 判定。
         */
        <p className="rounded-lg bg-yellow-50 p-3 text-sm text-yellow-800">
          ⏳ 配额刷新被限流（每 IP 每分钟请求数超限），约 {rateLimitedSec} 秒后自动重试。
          这不影响 mint —— 点按钮后最终以后端校验为准。
        </p>
      )}

      {!priceReady && !backendDown && (
        <p
          className={`rounded-lg p-3 text-sm ${
            priceError ? "bg-red-50 text-red-700" : "bg-yellow-50 text-yellow-800"
          }`}
        >
          {priceError
            ? "⚠ 读取链上价格失败（RPC 不可达 / 合约地址不对），暂时不能 mint——恢复后会自动解除，也可刷新页面重试。"
            : "⏳ 正在读取合约价格（owner 可能设了单价），完成后即可 mint。"}
        </p>
      )}

      {quota && (
        <div
          className={`rounded-lg px-3 py-2 text-sm ${
            quotaExpired
              ? "bg-amber-50 text-amber-800"
              : quota.allowlisted
                ? quotaUnknown
                  ? "bg-yellow-50 text-yellow-800"
                  : quotaDone
                    ? "bg-gray-100 text-gray-600"
                    : "bg-green-50 text-green-800"
                : "bg-red-50 text-red-700"
          }`}
        >
          {quotaExpired
            ? `⌛ 白名单资格已于 ${fmtExpiry(quota.expiresAt)} 过期（原可领 ${quota.limit} 张）——联系运营续期`
            : quota.allowlisted
            ? quotaUnknown
              ? "⏳ 配额核验中（链上 RPC 不可达），稍后刷新或换节点再试"
              : quotaDone
                ? pending > 0
                  ? `⏳ ${pending} 张签名待上链（名额已预留），上链后或 1 小时后自动释放`
                  : `✅ 配额已用完（${quota.minted}/${quota.limit}）——想继续可联系加配额`
                : `✅ 在白名单：已领 ${quota.minted} / 可领 ${quota.limit} 张` +
                  (pending > 0 ? `（${pending} 张签名待上链，名额已预留）` : "")
              : "⚠ 钱包不在白名单——签名服务会拒绝（后端 data/allowlist.json 加地址后重启）"}
        </div>
      )}

      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-gray-600">
          图片（可选）：留空 = 后端自动分配创世图；填 = 用你自己的图 URL
        </label>
        <input
          className={inputCls}
          placeholder="https://… 或 ipfs://… 或 data:image/…（≤500 字符，不能含引号）"
          value={customUri}
          onChange={(e) => setCustomUri(e.target.value)}
          disabled={busy !== null}
        />
      </div>

      <button
        className={btnPrimary}
        disabled={busy !== null || wrongChain || quotaDone || quotaUnknown || quotaExpired || backendDown || !priceReady}
        onClick={onMint}
      >
        {busy === "signing"
          ? "① 向后端要签名…"
          : busy === "mining"
            ? "② 提交链上交易…"
              : backendDown
              ? "⏳ 签名服务不可用"
              : !priceReady
              ? priceError
                ? "⚠ 价格读取失败"
                : "⏳ 读取价格中…"
              : quotaExpired
                ? "⌛ 资格已过期"
                : quotaUnknown
                  ? "⏳ 链上配额核验中"
                  : quotaDone
                    ? "配额已用完"
                    : "✨ Mint 一张 Genesis NFT"}
      </button>

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error.startsWith("签名服务拒绝") && <span className="mr-1">（白名单/配额/服务没启动问题）</span>}
          {error}
        </p>
      )}

      {artPreview && (
        <div className="flex items-center gap-4 rounded-xl border border-gray-200 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={resolveImageUrl(artPreview)} alt="预览" className="h-24 w-24 rounded-lg border border-gray-200" />
          <div className="min-w-0 text-sm text-gray-600">
            <p className="font-medium text-gray-900">签名成功，这张图将铸成 NFT</p>
            <p className="mt-1 break-all font-mono text-xs">{artPreview.slice(0, 90)}…</p>
          </div>
        </div>
      )}

      {txHash && (
        <div className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
          {txFailed ? (
            <p className="text-red-700">❌ 交易上链但执行失败（reverted）。看提示换图/换签名重试。</p>
          ) : txOk ? (
            <p>🎉 mint 成功！NFT 已上链（画廊约 4 秒内自动刷新，无需手动）。</p>
          ) : (
            <p>⏳ 交易确认中…</p>
          )}
          <a
            className="mt-1 inline-block break-all font-mono text-xs underline"
            href={explorerTx(txHash)}
            target="_blank"
            rel="noreferrer"
          >
            {txHash}
          </a>
        </div>
      )}

      <p className="text-xs text-gray-500">
        状态：{STATUS_TEXT.join(" / ")}。安全模型：每个签名绑定 (链+合约+钱包+图+过期时间) 且只能用一次，
        图重复/跨钱包/过期复用都会被链上拒绝。
      </p>
    </div>
  );
}
