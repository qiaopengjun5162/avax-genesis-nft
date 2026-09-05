/**
 * 签名协议（与合约 GenesisMint._isValidSignature 逐字节一致）
 *
 * 合约侧：
 *   inner = keccak256(abi.encodePacked(chainid, address(this), msg.sender, imageURI))
 *   final = MessageHashUtils.toEthSignedMessageHash(inner)   // EIP-191 前缀
 *   recovered == signer
 *
 * 后端侧（ethers）：
 *   inner = solidityPackedKeccak256(...)                     // 同上
 *   signer.signMessage(inner)   // ethers 对 32 字节自动加
 *                              // "\x19Ethereum Signed Message:\n32" 前缀 = toEthSignedMessageHash
 */
import { ethers } from "ethers";
import { env } from "./env.ts";

export const FUJI_CHAIN_ID = 43113;

// GenesisMint v3 演示实例（2026-09-04：签名按次授权，钱包可 mint 多张）
const DEFAULT_CONTRACT = "0x7AD0921D80CeFC98889a84B960c74866A452Cc2A";
const DEFAULT_RPC = "https://api.avax-test.network/ext/bc/C/rpc";

/**
 * 合约地址：.env 的 CONTRACT_ADDRESS 优先，缺省用已验证的演示实例。
 * 换部署实例只改 .env，不用动代码（也不该动——代码里写死地址迟早失联）。
 * 地址非法就在这里抛错：早失败好过拿着错地址签出一堆废签名。
 */
export const CONTRACT_ADDRESS: string = (() => {
  const raw = env.CONTRACT_ADDRESS?.trim();
  return raw ? ethers.getAddress(raw) : DEFAULT_CONTRACT;
})();

/** RPC 同理可覆盖（公共节点限流时换成自己的） */
export const FUJI_RPC: string = env.FUJI_RPC?.trim() || DEFAULT_RPC;

export function buildInnerHash(
  wallet: string,
  imageURI: string,
  contract: string = CONTRACT_ADDRESS,
  chainId: number = FUJI_CHAIN_ID,
): Uint8Array {
  const inner = ethers.solidityPackedKeccak256(
    ["uint256", "address", "address", "string"],
    [chainId, ethers.getAddress(contract), ethers.getAddress(wallet), imageURI],
  );
  return ethers.getBytes(inner);
}

/** 后端签名（白名单授权） */
export async function signMint(
  signer: ethers.Wallet,
  wallet: string,
  imageURI: string,
): Promise<string> {
  return signer.signMessage(buildInnerHash(wallet, imageURI));
}

/** 验签：返回恢复出的地址（供自检/测试用） */
export function recoverSigner(wallet: string, imageURI: string, signature: string): string {
  return ethers.verifyMessage(buildInnerHash(wallet, imageURI), signature);
}
