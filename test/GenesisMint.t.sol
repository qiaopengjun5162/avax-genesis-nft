// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {GenesisMint} from "../src/GenesisMint.sol";

contract GenesisMintTest is Test {
    using ECDSA for bytes32;

    GenesisMint public nft;

    // 固定角色
    address public owner = address(0xA11CE);
    uint256 public signerPk = 0xB0B;
    address public signer = vm.addr(signerPk);
    uint256 public newSignerPk = 0xC0C;
    address public newSigner = vm.addr(newSignerPk);
    address public alice = address(0xA11CA);
    address public bob = address(0xB0B2);
    uint256 public malloryPk = 0xDAD;
    address public mallory = vm.addr(malloryPk);

    uint256 public constant PRICE = 0.01 ether;
    string public constant DESC = "Genesis collection on Avalanche Fuji";

    event Minted(address indexed minter, uint256 indexed tokenId, string imageURI);
    event StatusChanged(GenesisMint.Status status);
    event PriceChanged(uint256 price);
    event SignerChanged(address indexed signer);
    event Withdrawn(address indexed recipient, uint256 amount);

    function setUp() public {
        // 给测试用户打钱（mint 要付 AVAX）
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(mallory, 10 ether);
        vm.deal(owner, 2000 ether); // 供给上限测试要循环付 1000*PRICE

        vm.prank(owner);
        nft = new GenesisMint("GenesisMint", "GNM", owner, signer, PRICE, DESC);
    }

    ////////////////////////////////////////////////////////////////
    // 工具：按合约内部同款规则出签名
    ////////////////////////////////////////////////////////////////

    function _sign(
        uint256 pk,
        address minter,
        string memory imageURI
    ) internal view returns (bytes memory) {
        bytes32 inner = keccak256(
            abi.encodePacked(block.chainid, address(nft), minter, imageURI)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            pk,
            MessageHashUtils.toEthSignedMessageHash(inner)
        );
        return abi.encodePacked(r, s, v);
    }

    function _uri(uint256 n) internal pure returns (string memory) {
        return string(abi.encodePacked("ipfs://QmYuanqiGenesis", vm.toString(n)));
    }

    function _startMint() internal {
        vm.prank(owner);
        nft.setStatus(GenesisMint.Status.Started);
    }

    ////////////////////////////////////////////////////////////////
    // 构造与读函数
    ////////////////////////////////////////////////////////////////

    function test_Constructor_SetsAllParams() public view {
        assertEq(nft.name(), "GenesisMint");
        assertEq(nft.symbol(), "GNM");
        assertEq(nft.owner(), owner);
        assertEq(nft.signer(), signer);
        assertEq(nft.price(), PRICE);
        assertEq(nft.description(), DESC);
        assertEq(uint256(nft.status()), uint256(GenesisMint.Status.Waiting));
        assertEq(nft.MAX_SUPPLY(), 1000);
    }

    function test_DeployerStartsWithZeroSupply() public view {
        assertEq(nft.totalSupply(), 0);
    }

    ////////////////////////////////////////////////////////////////
    // mint 主流程
    ////////////////////////////////////////////////////////////////

    function test_Mint_Success() public {
        _startMint();
        bytes memory sig = _sign(signerPk, alice, _uri(1));

        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(nft));
        emit Minted(alice, 0, _uri(1));
        uint256 tokenId = nft.mint{value: PRICE}(_uri(1), sig);

        assertEq(tokenId, 0);
        assertEq(nft.balanceOf(alice), 1);
        assertEq(nft.ownerOf(0), alice);
        assertEq(nft.numberMinted(alice), 1);
        assertEq(nft.tokenImageURI(0), _uri(1));
        assertEq(address(nft).balance, PRICE); // 钱进合约
    }

    function test_Mint_ZeroPriceNoPayment() public {
        vm.prank(owner);
        nft.setPrice(0);
        _startMint();
        bytes memory sig = _sign(signerPk, alice, _uri(2));

        vm.prank(alice);
        nft.mint(_uri(2), sig);

        assertEq(nft.balanceOf(alice), 1);
        assertEq(address(nft).balance, 0);
    }

    function test_Mint_RefundsOverpayment() public {
        _startMint();
        bytes memory sig = _sign(signerPk, alice, _uri(3));
        uint256 aliceBefore = alice.balance;

        vm.prank(alice);
        nft.mint{value: PRICE + 1 ether}(_uri(3), sig);

        // 多付的 1 ether 原路退回
        assertEq(alice.balance, aliceBefore - PRICE);
        assertEq(address(nft).balance, PRICE);
    }

    function test_Mint_AllowsEveryWalletOnce() public {
        _startMint();
        vm.prank(alice);
        nft.mint{value: PRICE}(_uri(10), _sign(signerPk, alice, _uri(10)));
        vm.prank(bob);
        nft.mint{value: PRICE}(_uri(11), _sign(signerPk, bob, _uri(11)));

        assertEq(nft.totalSupply(), 2);
        assertEq(nft.balanceOf(bob), 1);
    }

    ////////////////////////////////////////////////////////////////
    // 防护：签名重放（原 MFNFT 的洞）
    ////////////////////////////////////////////////////////////////

    function test_RevertWhen_MintNotStarted() public {
        bytes memory sig = _sign(signerPk, alice, _uri(1));
        vm.prank(alice);
        vm.expectRevert(GenesisMint.MintNotStarted.selector);
        nft.mint{value: PRICE}(_uri(1), sig);
    }

    function test_Mint_SameWalletMultipleUris() public {
        // v3：同钱包可 mint 多张——每张不同图 = 不同签名
        _startMint();
        vm.prank(alice);
        nft.mint{value: PRICE}(_uri(1), _sign(signerPk, alice, _uri(1)));
        vm.prank(alice);
        nft.mint{value: PRICE}(_uri(2), _sign(signerPk, alice, _uri(2)));
        vm.prank(alice);
        nft.mint{value: PRICE}(_uri(3), _sign(signerPk, alice, _uri(3)));

        assertEq(nft.balanceOf(alice), 3);
        assertEq(nft.numberMinted(alice), 3);
        assertEq(nft.totalSupply(), 3);
    }

    function test_RevertWhen_SameSignatureReplayed() public {
        // 同一 (钱包, 图) 签名只能用一次 → 第二笔 SignatureAlreadyUsed
        _startMint();
        bytes memory sig = _sign(signerPk, alice, _uri(1));
        vm.prank(alice);
        nft.mint{value: PRICE}(_uri(1), sig);

        vm.prank(alice);
        vm.expectRevert(GenesisMint.SignatureAlreadyUsed.selector);
        nft.mint{value: PRICE}(_uri(1), sig);
    }

    function test_RevertWhen_ForgedSignature() public {
        _startMint();
        // mallory 自己签（不是合法 signer）
        bytes memory forged = _sign(malloryPk, alice, _uri(1));
        vm.prank(alice);
        vm.expectRevert(GenesisMint.InvalidSignature.selector);
        nft.mint{value: PRICE}(_uri(1), forged);
    }

    function test_RevertWhen_ReplayAliceSigByBob() public {
        _startMint();
        // alice 的合法签名（绑定 alice 地址）
        bytes memory sig = _sign(signerPk, alice, _uri(1));

        vm.prank(bob);
        vm.expectRevert(GenesisMint.InvalidSignature.selector);
        nft.mint{value: PRICE}(_uri(1), sig);
    }

    function test_RevertWhen_WrongImageInSig() public {
        _startMint();
        // 签名对应 _uri(1)，却拿 _uri(2) 来 mint
        bytes memory sig = _sign(signerPk, alice, _uri(1));
        vm.prank(alice);
        vm.expectRevert(GenesisMint.InvalidSignature.selector);
        nft.mint{value: PRICE}(_uri(2), sig);
    }

    function test_RevertWhen_CrossContractReplay() public {
        // 同一签名换到另一份合约（模拟不同地址部署的副本）
        vm.prank(owner);
        GenesisMint other = new GenesisMint("Other", "OTH", owner, signer, PRICE, DESC);
        vm.prank(owner);
        other.setStatus(GenesisMint.Status.Started);

        bytes memory sig = _sign(signerPk, alice, _uri(1));

        // 在 other 上重放 alice 对 nft 的签名 → 应失败（绑定 address(this)）
        vm.prank(alice);
        vm.expectRevert(GenesisMint.InvalidSignature.selector);
        other.mint{value: PRICE}(_uri(1), sig);
    }

    function test_RevertWhen_CrossChainSignature() public {
        // 用另一个 chainid 签的签名 → 应失败（绑定 block.chainid）
        _startMint();
        bytes32 inner = keccak256(
            abi.encodePacked(uint256(1), address(nft), alice, _uri(1)) // chainid=1 而非当前
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            signerPk,
            MessageHashUtils.toEthSignedMessageHash(inner)
        );
        bytes memory wrongChainSig = abi.encodePacked(r, s, v);

        vm.prank(alice);
        vm.expectRevert(GenesisMint.InvalidSignature.selector);
        nft.mint{value: PRICE}(_uri(1), wrongChainSig);
    }

    ////////////////////////////////////////////////////////////////
    // 价格 / 供给 / 管理员
    ////////////////////////////////////////////////////////////////

    function test_RevertWhen_Underpay() public {
        _startMint();
        bytes memory sig = _sign(signerPk, alice, _uri(1));
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(GenesisMint.EtherAmountMismatch.selector, PRICE, PRICE - 1)
        );
        nft.mint{value: PRICE - 1}(_uri(1), sig);
    }

    function test_MaxSupplyBound() public {
        vm.prank(owner);
        nft.setPrice(0); // 免费灌满，避免值转移精度问题
        _startMint();
        // v3：单钱包可连续 mint 多张（每张不同图不同签名）
        vm.startPrank(alice);
        for (uint256 i = 0; i < nft.MAX_SUPPLY(); i++) {
            string memory u = _uri(1000 + i);
            nft.mint(u, _sign(signerPk, alice, u));
        }
        vm.stopPrank();
        assertEq(nft.totalSupply(), nft.MAX_SUPPLY());

        // 供给已满 → 上限报错（先于签名检查触发）
        vm.prank(alice);
        vm.expectRevert(GenesisMint.MaxSupplyExceeded.selector);
        nft.mint(_uri(5000), _sign(signerPk, alice, _uri(5000)));
    }

    function test_OwnerOnly_Gating() public {
        vm.prank(alice);
        vm.expectRevert();
        nft.setStatus(GenesisMint.Status.Started);

        vm.prank(alice);
        vm.expectRevert();
        nft.setPrice(1);

        vm.prank(alice);
        vm.expectRevert();
        nft.setSigner(alice);
    }

    function test_Admin_UpdatesAndEvents() public {
        // setStatus
        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(nft));
        emit StatusChanged(GenesisMint.Status.Started);
        nft.setStatus(GenesisMint.Status.Started);
        assertEq(uint256(nft.status()), uint256(GenesisMint.Status.Started));

        // setPrice
        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(nft));
        emit PriceChanged(0.02 ether);
        nft.setPrice(0.02 ether);
        assertEq(nft.price(), 0.02 ether);

        // setSigner → 换新 key
        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(nft));
        emit SignerChanged(newSigner);
        nft.setSigner(newSigner);
        assertEq(nft.signer(), newSigner);

        // 换 signer 后旧签名作废（用旧 signerPk 签 → revert）
        vm.prank(alice);
        vm.expectRevert(GenesisMint.InvalidSignature.selector);
        nft.mint{value: 0.02 ether}(_uri(9), _sign(signerPk, alice, _uri(9)));

        // 新 signer 的签名生效
        vm.prank(alice);
        nft.mint{value: 0.02 ether}(_uri(9), _sign(newSignerPk, alice, _uri(9)));
    }

    function test_Withdraw_OnlyOwnerMovesFunds() public {
        _startMint();
        vm.prank(alice);
        nft.mint{value: PRICE}(_uri(1), _sign(signerPk, alice, _uri(1)));

        // 非 owner 不能提
        vm.prank(alice);
        vm.expectRevert();
        nft.withdraw(payable(alice));

        // owner 提走
        vm.prank(owner);
        vm.expectEmit(true, true, true, true, address(nft));
        emit Withdrawn(owner, PRICE);
        nft.withdraw(payable(owner));

        assertEq(address(nft).balance, 0);
    }

    function test_RevertWhen_WithdrawEmpty() public {
        vm.prank(owner);
        vm.expectRevert(GenesisMint.NoBalance.selector);
        nft.withdraw(payable(owner));
    }

    function test_RevertWhen_WithdrawToZeroAddress() public {
        // 转给 0 地址的 call 会"成功"（无代码），钱等于永久烧掉 → 必须挡住
        _startMint();
        vm.prank(alice);
        nft.mint{value: PRICE}(_uri(1), _sign(signerPk, alice, _uri(1)));

        vm.prank(owner);
        vm.expectRevert(GenesisMint.ZeroAddress.selector);
        nft.withdraw(payable(address(0)));

        assertEq(address(nft).balance, PRICE); // 钱没丢
    }

    function test_RevertWhen_SetSignerZero() public {
        vm.prank(owner);
        vm.expectRevert(GenesisMint.ZeroAddress.selector);
        nft.setSigner(address(0));
    }

    function test_RevertWhen_RefundFails() public {
        // mint 者是一个"能收 NFT 但拒收 ETH"的合约 → 超付退款失败 → 整笔回滚
        Rejector rejector = new Rejector();
        vm.deal(address(rejector), 1 ether); // msg.sender 是 rejector，需有钱付
        _startMint();
        bytes memory sig = _sign(signerPk, address(rejector), _uri(1));

        vm.prank(address(rejector));
        vm.expectRevert(GenesisMint.RefundFailed.selector);
        nft.mint{value: PRICE + 1}(_uri(1), sig);

        // 原子性：回滚后没有 NFT 被铸出
        assertEq(nft.totalSupply(), 0);
        assertEq(nft.balanceOf(address(rejector)), 0);
    }

    function test_RevertWhen_WithdrawToRejector() public {
        _startMint();
        vm.prank(alice);
        nft.mint{value: PRICE}(_uri(1), _sign(signerPk, alice, _uri(1)));

        Rejector rejector = new Rejector();
        vm.prank(owner);
        vm.expectRevert(GenesisMint.WithdrawFailed.selector);
        nft.withdraw(payable(address(rejector)));

        // 钱还在合约里
        assertEq(address(nft).balance, PRICE);
    }

    function test_TokenURI_EmptyImageReturnsEmpty() public {
        _startMint();
        vm.prank(alice);
        nft.mint{value: PRICE}("", _sign(signerPk, alice, ""));

        assertEq(bytes(nft.tokenURI(0)).length, 0);
    }

    ////////////////////////////////////////////////////////////////
    // tokenURI（链上 Base64 JSON）
    ////////////////////////////////////////////////////////////////

    function test_TokenURI_ContainsOnchainJson() public {
        _startMint();
        vm.prank(alice);
        nft.mint{value: PRICE}(_uri(7), _sign(signerPk, alice, _uri(7)));

        string memory uri = nft.tokenURI(0);
        assertTrue(_hasPrefix(uri, "data:application/json;base64,"));

        string memory json = _base64Decode(_stripPrefix(uri));
        assertTrue(_contains(json, '"name":"GenesisMint #0"'));
        assertTrue(_contains(json, '"description":"Genesis collection on Avalanche Fuji"'));
        assertTrue(_contains(json, '"image":"ipfs://QmYuanqiGenesis7"'));
    }

    function test_RevertWhen_TokenURINonexistent() public {
        vm.expectRevert(GenesisMint.NonexistentToken.selector);
        nft.tokenURI(999);
    }

    ////////////////////////////////////////////////////////////////
    // fuzz：随机金额必须正好支付 price（超付退、少付 revert）
    ////////////////////////////////////////////////////////////////

    function testFuzz_Mint_PaymentAccounting(uint256 amount) public {
        _startMint();
        amount = bound(amount, PRICE, 5 ether);
        bytes memory sig = _sign(signerPk, alice, _uri(1));
        uint256 aliceBefore = alice.balance;

        vm.prank(alice);
        nft.mint{value: amount}(_uri(1), sig);

        assertEq(address(nft).balance, PRICE);
        assertEq(alice.balance, aliceBefore - PRICE);
    }

    function testFuzz_SignatureGarbageAlwaysReverts(bytes calldata junk) public {
        _startMint();
        vm.prank(alice);
        vm.expectRevert();
        nft.mint{value: PRICE}(_uri(1), junk);
    }

    ////////////////////////////////////////////////////////////////
    // 字符串工具（测试专用）
    ////////////////////////////////////////////////////////////////

    function _stripPrefix(string memory uri) internal pure returns (string memory) {
        bytes memory b = bytes(uri);
        uint256 prefixLen = bytes("data:application/json;base64,").length;
        return string(_sub(b, prefixLen, b.length - prefixLen));
    }

    function _hasPrefix(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory sb = bytes(s);
        bytes memory pb = bytes(prefix);
        if (sb.length < pb.length) return false;
        for (uint256 i = 0; i < pb.length; i++) {
            if (sb[i] != pb[i]) return false;
        }
        return true;
    }

    function _sub(
        bytes memory b,
        uint256 start,
        uint256 len
    ) internal pure returns (bytes memory) {
        require(start + len <= b.length, "sub out of range");
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = b[start + i];
        }
        return out;
    }

    function _base64Decode(string memory input) internal pure returns (string memory) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        bytes memory data = bytes(input);
        uint256 len = data.length;
        require(len % 4 == 0, "bad b64 length");
        uint256 olen = (len / 4) * 3;
        if (len > 0 && data[len - 1] == "=") olen--;
        if (len > 1 && data[len - 2] == "=") olen--;
        bytes memory out = new bytes(olen);
        uint256 j;
        for (uint256 i = 0; i < len; i += 4) {
            uint256 a = _idx(table, data[i]);
            uint256 b = _idx(table, data[i + 1]);
            uint256 c = data[i + 2] == "=" ? 64 : _idx(table, data[i + 2]);
            uint256 d = data[i + 3] == "=" ? 64 : _idx(table, data[i + 3]);
            uint256 n = (a << 18) | (b << 12) | (c << 6) | d;
            if (j < olen) out[j++] = bytes1(uint8((n >> 16) & 0xFF));
            if (j < olen) out[j++] = bytes1(uint8((n >> 8) & 0xFF));
            if (j < olen) out[j++] = bytes1(uint8(n & 0xFF));
        }
        return string(out);
    }

    function _idx(bytes memory table, bytes1 c) internal pure returns (uint256) {
        for (uint256 i = 0; i < table.length; i++) {
            if (table[i] == c) return i;
        }
        revert("bad b64 char");
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0) return true;
        if (n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool match_ = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    match_ = false;
                    break;
                }
            }
            if (match_) return true;
        }
        return false;
    }
}

/// @dev 能收 ERC721A NFT 但拒绝一切 ETH 转入的合约（构造退款失败场景）
contract Rejector {
    receive() external payable {
        revert("reject ETH");
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return 0x150b7a02; // IERC721AReceiver.onERC721Received.selector
    }
}
