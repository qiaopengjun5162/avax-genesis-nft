"use client";

import { formatEther } from "viem";
import { useReadContracts } from "wagmi";
import { CONTRACT_ADDRESS } from "@/lib/config";
import { statusLabel, supplyLabel } from "@/lib/stats";
import { genesisMintAbi } from "@/lib/abi";
import ConnectButton from "@/components/connect-button";
import MintPanel from "@/components/mint-panel";
import Gallery from "@/components/gallery";

export default function Home() {
  /**
   * 6 个只读值合成一次 multicall。
   *
   * 原来每个字段各挂一个 useReadContract + 3s 轮询：一个页面 6 次
   * eth_call，加上画廊的 2 次，公共 Fuji 节点很容易被自己的轮询打出
   * 429。multicall 在同一个块高度一次性取回，既省请求数，也避免
   * 「已铸用旧块、MAX_SUPPLY 用新块」这种同一屏数据不一致。
   *
   * allowFailure：单个 view 失败不该让整屏数据全空（例如 owner 换过
   * 合约实现、某个字段不存在）。失败的那一项拿 status === "failure"。
   */
  const { data, error, refetch } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: CONTRACT_ADDRESS, abi: genesisMintAbi, functionName: "name" },
      { address: CONTRACT_ADDRESS, abi: genesisMintAbi, functionName: "symbol" },
      { address: CONTRACT_ADDRESS, abi: genesisMintAbi, functionName: "status" },
      { address: CONTRACT_ADDRESS, abi: genesisMintAbi, functionName: "totalSupply" },
      { address: CONTRACT_ADDRESS, abi: genesisMintAbi, functionName: "MAX_SUPPLY" },
      { address: CONTRACT_ADDRESS, abi: genesisMintAbi, functionName: "price" },
    ],
    query: { refetchInterval: 3000 },
  });

  const [nameR, symbolR, statusR, supplyR, maxR, priceR] = data ?? [];
  /** 取成功的返回值；失败/未加载 → undefined（不要伪造成 0） */
  const val = <T,>(r: { status: string; result?: unknown } | undefined): T | undefined =>
    r?.status === "success" ? (r.result as T) : undefined;

  const name = val<string>(nameR);
  const symbol = val<string>(symbolR);
  const status = val<number>(statusR);
  const totalSupply = val<bigint>(supplyR);
  const maxSupply = val<bigint>(maxR);
  const priceWei = val<bigint>(priceR);

  // 整批读失败（RPC 不可达 / 合约地址错）与「某一项失败」要分开说：
  // 前者是网络/配置问题，后者多半是合约实现变了。都不该静默显示成 0。
  const priceFailed = priceR?.status === "failure";
  const rpcDown = Boolean(error);

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {name ?? "GenesisMint"} <span className="text-gray-400">({symbol ?? ""})</span>
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Avalanche Fuji 上的 ECDSA 白名单创世 NFT——白名单钱包按配额 mint（可领多张），
            图可自动生成或自选 URL。
          </p>
          <p className="mt-1 font-mono text-xs text-gray-400">{CONTRACT_ADDRESS}</p>
        </div>
        <ConnectButton />
      </div>

      {rpcDown && (
        <div className="mb-6 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <p>链上数据读取失败（RPC 不可达 / 合约地址不对 / 被限流），下面的数字不是真实值。</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-2 rounded-md border border-red-300 px-3 py-1 text-xs hover:bg-red-100"
          >
            重试
          </button>
        </div>
      )}

      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="已铸" value={supplyLabel(totalSupply, maxSupply)} />
        <Stat label="状态" value={statusLabel(status)} />
        <Stat
          label="价格"
          value={priceWei !== undefined ? `${Number(formatEther(priceWei))} AVAX` : "…"}
        />
        <Stat label="网络" value="Fuji 43113" />
      </div>

      <section className="mb-10 rounded-2xl border border-gray-200 p-6">
        <h2 className="mb-4 text-lg font-semibold">Mint</h2>
        <MintPanel
          priceWei={priceWei ?? 0n}
          priceReady={priceWei !== undefined}
          priceError={priceFailed || rpcDown}
        />
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
