// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {GenesisMint} from "../src/GenesisMint.sol";

/**
 * @title DeployGenesisMint
 * @dev 部署到 Avalanche Fuji：
 *   DEPLOYER_PRIVATE_KEY（.env）签名部署；signer 初期=deployer（后端做好后可 setSigner 换）
 *
 *   forge script script/DeployGenesisMint.s.sol --rpc-url avalancheFuji \
 *     --broadcast --verify -vvv
 */
contract DeployGenesisMint is Script {
    function run() external returns (GenesisMint nft) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        console.log("Deployer: ", deployer);
        console.log("Balance:  ", deployer.balance);

        // 初期签名后端 = 部署者自己；正式版由后端服务持有独立 key
        address initialSigner = vm.envOr("SIGNER_ADDRESS", deployer);
        console.log("Signer:   ", initialSigner);

        vm.startBroadcast(deployerKey);
        nft = new GenesisMint(
            "GenesisMint", // name
            "GNM", // symbol
            deployer, // initialOwner
            initialSigner, // signer
            0, // price：免费 mint（后续 setPrice 开启收费）
            "GenesisMint: Avalanche Fuji collection minted via ECDSA allowlist"
        );
        vm.stopBroadcast();

        console.log("GenesisMint deployed at:", address(nft));
        console.log("name:", nft.name());
        console.log("symbol:", nft.symbol());
        console.log("owner:", nft.owner());
        console.log("status:", uint256(nft.status()), "(0=Waiting)");
    }
}
