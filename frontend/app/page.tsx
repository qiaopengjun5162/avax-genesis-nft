"use client";

import { useReadContract } from "wagmi";
import { CONTRACT_ADDRESS, STATUS_TEXT } from "@/lib/config";
import { genesisMintAbi } from "@/lib/abi";
import ConnectButton from "@/components/connect-button";
import MintPanel from "@/components/mint-panel";
import Gallery from "@/components/gallery";

export default function Home() {
  const { data: name } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "name",
  });
  const { data: symbol } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "symbol",
  });
  const { data: status } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "status",
  });
  const { data: totalSupply } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "totalSupply",
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
            Avalanche Fuji 上的 ECDSA 白名单创世 NFT——每钱包 1 张，图由后端签名分配。
          </p>
          <p className="mt-1 font-mono text-xs text-gray-400">{CONTRACT_ADDRESS}</p>
        </div>
        <ConnectButton />
      </div>

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="已铸" value={`${Number(totalSupply ?? 0n)} / 1000`} />
        <Stat label="状态" value={STATUS_TEXT[Number(status ?? 0n)] ?? "?"} />
        <Stat label="价格" value="0 AVAX" />
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
    <div className="rounded-xl bg-gray-50 p-3">
      <p className="text-xs text-gray-400">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  );
}
