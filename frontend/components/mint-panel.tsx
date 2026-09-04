"use client";

import { useState } from "react";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { CONTRACT_ADDRESS, SIGNER_URL, STATUS_TEXT, explorerTx, FAUCET_URL } from "@/lib/config";
import { genesisMintAbi } from "@/lib/abi";

const btnPrimary =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50";

/** 合约 custom error selector → 人话（selector 用 cast sig 对过） */
const REVERT_HINTS: Array<{ sel: string; hint: string }> = [
  { sel: "0xb88ec8ed", hint: "这个钱包已经 mint 过了（每钱包限 1 张）" },
  { sel: "0x8baa579f", hint: "签名无效：钱包不在白名单，或签名服务返回的不是你的签名" },
  { sel: "0x06290e4e", hint: "mint 还没开始（合约 Waiting 状态，等 owner 开启）" },
  { sel: "0x8a164f63", hint: "供给已满（1000/1000）" },
  { sel: "0xf0c49d44", hint: "退款失败（罕见，钱包拒收 ETH 时会触发，交易已回滚）" },
];

function humanizeError(e: unknown): string {
  const text = e instanceof Error ? `${e.message} ${(e as { cause?: unknown }).cause ?? ""}` : String(e);
  for (const { sel, hint } of REVERT_HINTS) {
    if (text.includes(sel)) return hint;
  }
  // 去掉 viem 那一大坨 JSON，只留首行人话
  const first = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "未知错误";
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
}

/**
 * mint 三幕剧：
 *  ① 前端连钱包（白名单钱包）
 *  ② POST 签名后端 → 拿到 { imageURI, signature }
 *  ③ 带签名调合约 mint() → 链上铸出
 */
export default function MintPanel() {
  const { address, isConnected, chainId } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { invalidateQueries } = useQueryClient();

  // 已 mint 张数（每钱包 1 张 → >0 直接禁用按钮，不等到链上才报错）
  const { data: minted } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "numberMinted",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const [busy, setBusy] = useState<"signing" | "mining" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artPreview, setArtPreview] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const { data: receipt } = useWaitForTransactionReceipt({ hash: txHash as `0x${string}` | undefined });
  // wagmi v2：查询 status==='success' 只代表已上链；交易是否成功看 receipt.status
  const txOk = receipt?.status === "success";
  const txFailed = receipt?.status === "reverted";

  const wrongChain = isConnected && chainId !== 43113;
  const mintedCount = (minted ?? 0n) as bigint; // ABI cast 后类型丢失，显式断言
  const alreadyMinted = mintedCount > 0n;

  async function onMint() {
    if (!address) return;
    setError(null);
    setTxHash(null);
    try {
      // ① 向后端要签名
      setBusy("signing");
      const res = await fetch(`${SIGNER_URL}/sign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: address }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(`签名服务拒绝：${data.error ?? res.status}`);
        setBusy(null);
        return;
      }
      setArtPreview(data.imageURI);

      // ② 带签名上链（price=0 免费；若 owner 改价，value 传 price）
      setBusy("mining");
      const hash = await writeContractAsync({
        address: CONTRACT_ADDRESS,
        abi: genesisMintAbi,
        functionName: "mint",
        args: [data.imageURI, data.signature as `0x${string}`],
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
          先连接钱包。只有白名单内的钱包能拿到签名（每钱包 1 张）。
        </div>
        <p className="text-xs text-gray-400">
          钱包里没测试 AVAX？gas 需要一点点（mint 本身免费）——
          <a className="text-blue-600 underline" href={FAUCET_URL} target="_blank" rel="noreferrer">
            Core 水龙头领测试币
          </a>
          （24h 冷却，或 build.avax.network 官方水龙头）。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {wrongChain && (
        <p className="text-sm font-medium text-red-600">
          ⚠ 当前链不是 Fuji，mint 会失败——请先在钱包里切到 Avalanche Fuji。
        </p>
      )}

      {alreadyMinted && (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          🎁 这个钱包已经领过 {String(mintedCount)} 张（每钱包限 1 张）——去下方画廊看你的 NFT。
          想再 mint 请换一个白名单内的钱包。
        </div>
      )}

      <button
        className={btnPrimary}
        disabled={busy !== null || wrongChain || alreadyMinted}
        onClick={onMint}
      >
        {alreadyMinted
          ? "✅ 已领取（每钱包 1 张）"
          : busy === "signing"
            ? "① 向后端要签名…"
            : busy === "mining"
              ? "② 提交链上交易…"
              : "✨ Mint 我的 Genesis NFT"}
      </button>

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error.startsWith("签名服务拒绝") && (
            <span className="mr-1">（钱包不在白名单，或签名服务没启动）</span>
          )}
          {error}
        </p>
      )}

      {artPreview && (
        <div className="flex items-center gap-4 rounded-xl border border-gray-200 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={artPreview} alt="我的创世图" className="h-24 w-24 rounded-lg" />
          <div className="text-sm text-gray-600">
            <p className="font-medium text-gray-900">签名成功，后端分配了这张创世图</p>
            <p className="mt-1 break-all font-mono text-xs">{artPreview.slice(0, 80)}…</p>
          </div>
        </div>
      )}

      {txHash && (
        <div className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">
          {txFailed ? (
            <p className="text-red-700">❌ 交易上链但执行失败（reverted）。看下钱包网络/白名单状态。</p>
          ) : txOk ? (
            <p>🎉 mint 成功！NFT 已上链。</p>
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
          {txOk && (
            <button
              className="ml-3 rounded bg-blue-600 px-2 py-1 text-xs text-white"
              onClick={() => invalidateQueries()}
            >
              刷新画廊
            </button>
          )}
        </div>
      )}

      <p className="text-xs text-gray-400">
        状态说明：{STATUS_TEXT.join(" / ")}。mint 由 ECDSA 签名白名单保护——签名绑定你的钱包地址，
        不能转借他人。
      </p>
    </div>
  );
}
