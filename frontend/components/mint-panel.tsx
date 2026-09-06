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
  { sel: "0x900bb2c9", hint: "这张图这个钱包已经领过了（每个签名只能用一次），换一张或重新要个签名" },
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
};

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
      const r = await fetch(`${SIGNER_URL}/allowlist/${address}`);
      if (r.ok) setQuota(await r.json());
    } catch {
      /* 后端没起时静默 */
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
      });
      const data = await res.json();
      if (!res.ok) {
        setError(`签名服务拒绝：${data.error ?? res.status}`);
        setBusy(null);
        return;
      }
      setArtPreview(data.imageURI);
      setQuota({ minted: data.minted + 1, limit: data.limit, remaining: data.remaining, allowlisted: true });

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
      setError(humanizeError(e));
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

  return (
    <div className="space-y-4">
      {wrongChain && (
        <p className="text-sm font-medium text-red-600">⚠ 当前链不是 Fuji，mint 会失败——请切到 Avalanche Fuji。</p>
      )}

      {quota && (
        <div
          className={`rounded-lg px-3 py-2 text-sm ${
            quota.allowlisted
              ? quotaUnknown
                ? "bg-yellow-50 text-yellow-800"
                : quotaDone
                  ? "bg-gray-100 text-gray-600"
                  : "bg-green-50 text-green-800"
              : "bg-red-50 text-red-700"
          }`}
        >
          {quota.allowlisted
            ? quotaUnknown
              ? "⏳ 配额核验中（链上 RPC 不可达），稍后刷新或换节点再试"
              : quotaDone
                ? `✅ 配额已用完（${quota.minted}/${quota.limit}）——想继续可联系加配额`
                : `✅ 在白名单：已领 ${quota.minted} / 可领 ${quota.limit} 张`
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
        disabled={busy !== null || wrongChain || quotaDone || quotaUnknown}
        onClick={onMint}
      >
        {busy === "signing"
          ? "① 向后端要签名…"
          : busy === "mining"
            ? "② 提交链上交易…"
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
