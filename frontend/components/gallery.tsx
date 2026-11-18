"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { CONTRACT_ADDRESS } from "@/lib/config";
import { genesisMintAbi, shortAddr } from "@/lib/abi";
import { decodeTokenUri } from "@/lib/token-uri";

type Nft = {
  tokenId: number;
  owner: `0x${string}`;
  meta: { name?: string; image?: string } | null;
};

/**
 * 画廊：一次 `tokensOfOwner(address)` 拿回该地址的全部 tokenId，
 * 再按需读 tokenURI 拉元数据。供应链上最大供给（MAX_SUPPLY）由合约保证。
 *
 * 历史实现是"扫 totalSupply + ownerOf"，存在天然 40 件上限——超
 * 过就把别人之后的 NFT 全漏掉。改为 ERC721AQueryable 后可以一次
 * 性查清。
 */
export default function Gallery() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const poll = { refetchInterval: 3000 } as const;

  const { data: totalSupply } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "totalSupply",
    query: poll,
  });
  // 与首页共用链上 MAX_SUPPLY（避免硬编码 1000 又一处）
  const { data: maxSupply } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: genesisMintAbi,
    functionName: "MAX_SUPPLY",
    query: poll,
  });

  const totalNum = Number(totalSupply ?? 0n);
  const maxNum = maxSupply === undefined ? null : Number(maxSupply);

  const { data: mine, error, isFetching, refetch } = useQuery({
    queryKey: ["my-nfts", address, totalNum],
    enabled: Boolean(address && publicClient),
    refetchInterval: 4000,
    queryFn: async (): Promise<Nft[]> => {
      const ids = (await publicClient!.readContract({
        address: CONTRACT_ADDRESS,
        abi: genesisMintAbi,
        functionName: "tokensOfOwner",
        args: [address as `0x${string}`],
      })) as readonly bigint[];

      // ERC721A 支持多签（一次 mint 多张），ownerOf 在多签情形不
      // 会重复；并发的 tokenURI 请求并发发出去，远快于串行
      const out: Nft[] = await Promise.all(
        ids.map(async (id) => {
          const uri = (await publicClient!.readContract({
            address: CONTRACT_ADDRESS,
            abi: genesisMintAbi,
            functionName: "tokenURI",
            args: [id],
          })) as string;
          return {
            tokenId: Number(id),
            owner: address as `0x${string}`,
            meta: decodeTokenUri(uri),
          };
        }),
      );
      return out;
    },
  });

  const supplyLabel = maxNum === null ? `${totalNum} / …` : `${totalNum} / ${maxNum}`;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">我的 NFT</h2>
        <span className="text-xs text-gray-400">
          全网已铸 {supplyLabel}
          {isFetching && " · 扫描中…"}
        </span>
      </div>

      {!address ? (
        <p className="text-sm text-gray-500">连接钱包后展示你的藏品。</p>
      ) : error ? (
        /**
         * 读链失败必须单独说清。之前这里和「空列表」共用同一个分支，
         * RPC 挂了 / 合约地址配错 / 限流，用户看到的都是「你还没有 NFT」
         * ——把故障说成事实，他只会以为自己的 NFT 丢了。
         */
        <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">
          <p>画廊读取失败（RPC 不可达 / 合约地址不对 / 被限流），这不代表你没有 NFT。</p>
          <p className="mt-1 break-all font-mono text-xs text-red-600">
            {error instanceof Error ? error.message : String(error)}
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-2 rounded-md border border-red-300 px-3 py-1 text-xs hover:bg-red-100"
          >
            重试
          </button>
        </div>
      ) : mine && mine.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {mine.map((n) => (
            <div key={n.tokenId} className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
              {/* 元数据缺失/没图时不要渲染 <img src={undefined}>：那是一个破图图标 */}
              {n.meta?.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={n.meta.image}
                  alt={n.meta.name ?? `#${n.tokenId}`}
                  className="aspect-square w-full bg-gray-200 object-cover"
                />
              ) : (
                <div className="flex aspect-square w-full items-center justify-center bg-gray-100 text-xs text-gray-400">
                  无图
                </div>
              )}
              <div className="p-3">
                <p className="text-sm font-semibold text-gray-900">{n.meta?.name ?? `#${n.tokenId}`}</p>
                <p className="mt-0.5 text-xs text-gray-500">owner {shortAddr(n.owner)}</p>
              </div>
            </div>
          ))}
        </div>
      ) : mine ? (
        <p className="text-sm text-gray-500">
          {totalNum === 0 ? "还没有任何人 mint。" : "你还没有 NFT——点上面按钮领一张。"}
        </p>
      ) : (
        // 首次加载：既不是「没有」，也还不到报错的时候
        <p className="text-sm text-gray-500">正在读取你的 NFT…</p>
      )}
    </div>
  );
}
