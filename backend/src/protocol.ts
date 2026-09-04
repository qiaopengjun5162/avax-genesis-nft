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

export const FUJI_CHAIN_ID = 43113;
export const FUJI_RPC = "https://api.avax-test.network/ext/bc/C/rpc";
// GenesisMint 演示实例 #2（2026-09-04，干净状态供浏览器 mint 演示；实例#1 0x55Ab… 已有人领过）
export const CONTRACT_ADDRESS = "0xE9d6E87644e4498f5d94391b6F4553D3a58d6198";

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
