"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { CONTRACT_ADDRESS } from "@/lib/config";
import { genesisMintAbi, decodeTokenUri, shortAddr } from "@/lib/abi";

type Nft = {
  tokenId: number;
  owner: `0x${string}`;
  meta: { name?: string; image?: string } | null;
};

/**
 * 画廊：读 totalSupply，逐个 token 查 ownerOf + tokenURI，
 * 只展示"属于我"的（规模小：for 演示最多扫 40 个）。
 */
export default function Gallery() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: totalSupply } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "totalSupply",
    query: { refetchInterval: 3000 },
  });

  const scanLimit = Number(totalSupply ?? 0n) > 40 ? 40 : Number(totalSupply ?? 0n);

  const { data: mine, isFetching } = useQuery({
    queryKey: ["my-nfts", address, Number(totalSupply ?? 0n)],
    enabled: Boolean(address && publicClient && scanLimit > 0),
    refetchInterval: 4000,
    queryFn: async () => {
      const out: Nft[] = [];
      for (let id = 0; id < scanLimit; id++) {
        const owner = (await publicClient!.readContract({
          address: CONTRACT_ADDRESS,
          abi: genesisMintAbi,
          functionName: "ownerOf",
          args: [BigInt(id)],
        })) as `0x${string}`;
        if (owner === address) {
          const uri = (await publicClient!.readContract({
            address: CONTRACT_ADDRESS,
            abi: genesisMintAbi,
            functionName: "tokenURI",
            args: [BigInt(id)],
          })) as string;
          out.push({ tokenId: id, owner, meta: decodeTokenUri(uri) });
        }
      }
      return out;
    },
  });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">我的 NFT</h2>
        <span className="text-xs text-gray-400">
          全网已铸 {Number(totalSupply ?? 0n)}/{1000}
          {isFetching && " · 扫描中…"}
        </span>
      </div>

      {!address ? (
        <p className="text-sm text-gray-500">连接钱包后展示你的藏品。</p>
      ) : mine && mine.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {mine.map((n) => (
            <div key={n.tokenId} className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={n.meta?.image} alt={n.meta?.name} className="aspect-square w-full bg-gray-200 object-cover" />
              <div className="p-3">
                <p className="text-sm font-semibold text-gray-900">{n.meta?.name ?? `#${n.tokenId}`}</p>
                <p className="mt-0.5 text-xs text-gray-500">owner {shortAddr(n.owner)}</p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-500">
          {Number(totalSupply ?? 0n) === 0 ? "还没有任何人 mint。" : "你还没有 NFT——点上面按钮领一张。"}
        </p>
      )}
    </div>
  );
}
