"use client";

import { useAccount, useConnect, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { fuji } from "@/lib/config";
import { shortAddr } from "@/lib/abi";

const btnPrimary =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50";
const btnOutline =
  "rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-100";
const btnDanger =
  "rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50";

export default function ConnectButton() {
  const { address, isConnected, chainId } = useAccount();
  const { mutateAsync: connectAsync } = useConnect();
  const { disconnect } = useDisconnect();
  const connectors = useConnectors();
  const { switchChain, isPending: switching } = useSwitchChain();

  const wrongChain = isConnected && chainId !== fuji.id;

  if (isConnected && address) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
          ✅ {shortAddr(address)}
        </span>
        {wrongChain && (
          <button
            className={btnDanger}
            disabled={switching}
            onClick={() => switchChain({ chainId: fuji.id })}
          >
            {switching ? "切换中…" : "⚠ 切到 Avalanche Fuji (43113)"}
          </button>
        )}
        <button className={btnOutline} onClick={() => disconnect()}>
          断开
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {connectors.map((c) => (
        <button
          key={c.id}
          className={btnPrimary}
          onClick={async () => {
            try {
              await connectAsync({ connector: c });
            } catch (e) {
              console.error("connect failed", e);
            }
          }}
        >
          连接钱包（{c.name}）
        </button>
      ))}
    </div>
  );
}
