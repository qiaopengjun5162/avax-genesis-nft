"use client";

import { formatEther } from "viem";
import { useReadContract } from "wagmi";
import { CONTRACT_ADDRESS, STATUS_TEXT } from "@/lib/config";
import { genesisMintAbi } from "@/lib/abi";
import ConnectButton from "@/components/connect-button";
import MintPanel from "@/components/mint-panel";
import Gallery from "@/components/gallery";

export default function Home() {
  // 轮询：mint 上链后 stats 自动更新（治 wagmi 读的陈旧显示）
  const poll = { refetchInterval: 3000 } as const;
  const { data: name } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "name",
    query: poll,
  });
  const { data: symbol } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "symbol",
    query: poll,
  });
  const { data: status } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "status",
    query: poll,
  });
  const { data: totalSupply } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "totalSupply",
    query: poll,
  });
  // 链上真实读：owner 调整单价 / 改最大供给时，前端不再"过期"
  const { data: maxSupply } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "MAX_SUPPLY",
    query: poll,
  });
  const { data: priceWei } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "price",
    query: poll,
  });

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {String(name ?? "GenesisMint")}{" "}
            <span className="text-gray-400">({String(symbol ?? "")})</span>
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Avalanche Fuji 上的 ECDSA 白名单创世 NFT——白名单钱包按配额 mint（可领多张），
            图可自动生成或自选 URL。
          </p>
          <p className="mt-1 font-mono text-xs text-gray-400">{CONTRACT_ADDRESS}</p>
        </div>
        <ConnectButton />
      </div>

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="已铸"
          value={
            maxSupply !== undefined
              ? `${Number(totalSupply ?? 0n)} / ${Number(maxSupply)}`
              : `${Number(totalSupply ?? 0n)} / …`
          }
        />
        <Stat label="状态" value={STATUS_TEXT[Number(status ?? 0n)] ?? "?"} />
        <Stat
          label="价格"
          value={
            priceWei != null
              ? `${Number(formatEther(priceWei as bigint)).toString()} AVAX`
              : "…"
          }
        />
        <Stat label="网络" value="Fuji 43113" />
      </div>

      <section className="mb-10 rounded-2xl border border-gray-200 p-6">
        <h2 className="mb-4 text-lg font-semibold">Mint</h2>
        <MintPanel />
      </section>

      <Gallery />
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-base font-semibold text-gray-900">{value}</p>
    </div>
  );
}
