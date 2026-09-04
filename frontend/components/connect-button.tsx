"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";

/**
 * 统一连接入口：一个按钮 → RainbowKit 弹卡片列出钱包供选择
 * （RainbowKit 只配了 Fuji 单链 → 连接即强制切到测试网，见 lib/config.ts）
 */
export default function WalletButton() {
  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openAccountModal,
        openChainModal,
        openConnectModal,
        mounted,
      }) => {
        const ready = mounted;
        const connected = ready && account && chain;
        return (
          <div
            {...(!ready && { "aria-hidden": true, style: { opacity: 0, pointerEvents: "none" } })}
          >
            {(() => {
              if (!connected) {
                return (
                  <button
                    onClick={openConnectModal}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
                  >
                    连接钱包
                  </button>
                );
              }
              if (chain.unsupported || chain.id !== 43113) {
                return (
                  <button
                    onClick={openChainModal}
                    className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                  >
                    ⚠ 切到 Fuji 测试网（当前 {chain.name}）
                  </button>
                );
              }
              return (
                <div className="flex items-center gap-2">
                  <button
                    onClick={openChainModal}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-green-700 hover:bg-gray-100"
                    title="点击切换网络"
                  >
                    🧪 {chain.name}
                  </button>
                  <button
                    onClick={openAccountModal}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
                  >
                    {account.displayName}
                  </button>
                </div>
              );
            })()}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
