"use client";

import { useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { CONTRACT_ADDRESS, SIGNER_URL, STATUS_TEXT, explorerTx } from "@/lib/config";
import { genesisMintAbi } from "@/lib/abi";

const btnPrimary =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50";

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

  const [busy, setBusy] = useState<"signing" | "mining" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artPreview, setArtPreview] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const { isSuccess } = useWaitForTransactionReceipt({ hash: txHash as `0x${string}` | undefined });

  const wrongChain = isConnected && chainId !== 43113;

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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (!isConnected || !address) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 p-6 text-sm text-gray-500">
        先连接钱包。只有白名单内的钱包能拿到签名（每钱包 1 张）。
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

      <button className={btnPrimary} disabled={busy !== null || wrongChain} onClick={onMint}>
        {busy === "signing" && "① 向后端要签名…"}
        {busy === "mining" && "② 提交链上交易…"}
        {busy === null && "✨ Mint 我的 Genesis NFT"}
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
          {isSuccess ? (
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
          {isSuccess && (
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
