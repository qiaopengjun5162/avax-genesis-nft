"use client";

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { CONTRACT_ADDRESS, SIGNER_URL, STATUS_TEXT, explorerTx, FAUCET_URL } from "@/lib/config";
import { genesisMintAbi } from "@/lib/abi";

const btnPrimary =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50";
const inputCls =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none";

/** 合约 custom error selector → 人话（cast sig 对过） */
const REVERT_HINTS: Array<{ sel: string; hint: string }> = [
  { sel: "0x8baa579f", hint: "签名无效：钱包不在白名单 / 签名被篡改，请重试" },
  { sel: "0x7248afc4", hint: "签名已过期：领取窗口约 1 小时，请重新点 Mint 要一个新签名" }, // SignatureExpired
  { sel: "0x900bb2c9", hint: "这个签名已经上链过了（同一签名只能用一次），请重新点 Mint 要一个新签名" },
  { sel: "0x06290e4e", hint: "mint 还没开始（合约 Waiting 状态）" },
  { sel: "0x8a164f63", hint: "供给已满（1000/1000）" },
  // 后续合约定性调整带来的新错误（v3+）——cast sig -- 验证过
  { sel: "0xd7d248ba", hint: "mint 已被 owner 暂停（合约 Paused 状态），等恢复" }, // MintPaused
  { sel: "0x9be4ff54", hint: "图 URL 是空的——请选一张图或留空让后端分配" }, // EmptyImageURI
  { sel: "0xd92e233d", hint: "owner 配置错：setSigner 不能传 0 地址（合约层问题，联系 owner）" }, // ZeroAddress
  { sel: "0xc2caa2a6", hint: "合约余额为 0 或 owner 提现失败（合约层问题，联系 owner）" }, // NoBalance
];

function humanizeError(e: unknown): string {
  const text = e instanceof Error ? `${e.message} ${(e as { cause?: unknown }).cause ?? ""}` : String(e);
  for (const { sel, hint } of REVERT_HINTS) {
    if (text.includes(sel)) return hint;
  }
  const first = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "未知错误";
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
}

type Quota = {
  allowlisted: boolean;
  limit: number;
  // minted/remaining 为 null 表示后端拿不到链上配额（RPC 不可达），
  // 不要按"还有 N 张"乐观显示，按"未知"渲染 + 禁用 mint 防误签
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
export default function MintPanel() {
  const { address, isConnected, chainId } = useAccount();
  const { writeContractAsync } = useWriteContract();

  const [busy, setBusy] = useState<"signing" | "mining" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [customUri, setCustomUri] = useState("");
  const [artPreview, setArtPreview] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const { data: receipt } = useWaitForTransactionReceipt({ hash: txHash as `0x${string}` | undefined });
  const txOk = receipt?.status === "success";
  const txFailed = receipt?.status === "reverted";

  const wrongChain = isConnected && chainId !== 43113;

  // 连上后预检配额（含轮询，mint 后自动更新）
  const fetchQuota = useCallback(async () => {
    if (!address) return;
    try {
      // 15s 超时：RPC 慢 + 同钱包锁排队都可能在 8s 上限（RPC_QUERY_TIMEOUT_MS）
      // 之后再卡几秒。给个总上限就免得「按钮卡在 ① 向后端要签名…」。
      const r = await fetch(`${SIGNER_URL}/allowlist/${address}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) setQuota(await r.json());
    } catch {
      /* 后端没起 / 超时：静默，下一轮继续试 */
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
      const data = await res.json();
      if (!res.ok) {
        setError(`签名服务拒绝：${data.error ?? res.status}`);
        setBusy(null);
        return;
      }
      setArtPreview(data.imageURI);
      // 后端返回的 remaining 已扣掉这张刚签的（含在飞的），直接用
      setQuota({
        minted: data.minted,
        limit: data.limit,
        remaining: data.remaining,
        pending: (quota?.pending ?? 0) + 1,
        allowlisted: true,
      });

      // ② 带签名上链（deadline 由后端签发，签名绑定，前端原样透传）
      setBusy("mining");
      const hash = await writeContractAsync({
        address: CONTRACT_ADDRESS,
        abi: genesisMintAbi,
        functionName: "mint",
        args: [data.imageURI, data.deadline as number, data.signature as `0x${string}`],
        value: 0n,
      });
      setTxHash(hash);
    } catch (e) {
      // AbortSignal.timeout 抛 DOMException（name=TimeoutError，AbortError 的子类），
      // 人话化只会得到「The user aborted a request」这种没头没尾的
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
        setError("请求超时：签名服务 20 秒内没回（后端可能挂了或链上 RPC 卡着），重试一次");
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

  return (
    <div className="space-y-4">
      {wrongChain && (
        <p className="text-sm font-medium text-red-600">⚠ 当前链不是 Fuji，mint 会失败——请切到 Avalanche Fuji。</p>
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
          placeholder="https://… 或 ipfs://… 或 data:image/…（≤500 字符）"
          value={customUri}
          onChange={(e) => setCustomUri(e.target.value)}
          disabled={busy !== null}
        />
      </div>

      <button
        className={btnPrimary}
        disabled={busy !== null || wrongChain || quotaDone || quotaUnknown || quotaExpired}
        onClick={onMint}
      >
        {busy === "signing"
          ? "① 向后端要签名…"
          : busy === "mining"
            ? "② 提交链上交易…"
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
          <img src={artPreview} alt="预览" className="h-24 w-24 rounded-lg border border-gray-200" />
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
