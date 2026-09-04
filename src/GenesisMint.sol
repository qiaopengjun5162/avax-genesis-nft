// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC721A} from "erc721a/contracts/ERC721A.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title GenesisMint v3
 * @dev ERC721A 创世 NFT：ECDSA 签名白名单 mint（签名按次授权，可多次 mint）
 *
 * 相对 v1（每钱包 1 张）的改动：
 *  - 去掉链上"每钱包限 1 张"（_numberMinted 检查）→ 改由后端按配额发签名
 *  - 每个 (wallet, imageURI) 签名**只能用一次**：usedHashes 记已用哈希
 *    → 同一签名重放（铸两张同图）被拒 = SignatureAlreadyUsed
 *  - 白名单配额由后端控制：钱包可 mint N 张（每张不同图/不同签名），测试无需换账户
 *  - 图可以是后端分配的创世图，也可以是用户自选的 URL（签名照绑，安全模型不变）
 *
 * 安全模型（不变，参考 MFNFT 修复）：
 *  - 签名绑定 (chainid, 本合约, msg.sender, imageURI) → 防跨链/跨合约/跨钱包重放
 *  - 签名即授权：没有后端签名，任何钱包都 mint 不了
 */
contract GenesisMint is ERC721A, Ownable, ReentrancyGuard {
    using ECDSA for bytes32;
    using Strings for uint256;

    enum Status {
        Waiting,
        Started
    }

    uint256 public constant MAX_SUPPLY = 1000;
    uint256 public price;
    Status public status;
    address public signer;
    string public description;

    // tokenId => 该 NFT 的图片 URI（后端分配或用户自选）
    mapping(uint256 => string) private _tokenImageURIs;
    // 已使用签名哈希（inner hash）→ 防同一签名重放
    mapping(bytes32 => bool) public usedHashes;

    error MintNotStarted();
    error InvalidSignature();
    error SignatureAlreadyUsed();
    error MaxSupplyExceeded();
    error EtherAmountMismatch(uint256 required, uint256 sent);
    error RefundFailed();
    error WithdrawFailed();
    error NonexistentToken();

    event Minted(address indexed minter, uint256 indexed tokenId, string imageURI);
    event StatusChanged(Status status);
    event PriceChanged(uint256 price);
    event SignerChanged(address indexed signer);
    event Withdrawn(address indexed recipient, uint256 amount);

    constructor(
        string memory name_,
        string memory symbol_,
        address initialOwner,
        address signer_,
        uint256 price_,
        string memory description_
    ) ERC721A(name_, symbol_) Ownable(initialOwner) {
        signer = signer_;
        price = price_;
        description = description_;
    }

    /**
     * @dev 白名单 mint（一次一张，配额由后端签名控制）
     * signature = signer 对 keccak(chainid, address(this), msg.sender, imageURI)
     *            经 toEthSignedMessageHash 包装后的 ECDSA 签名
     * 每个签名只能用一次：同一 (钱包, 图) 想铸第二张会被 SignatureAlreadyUsed 拒绝
     */
    function mint(
        string calldata imageURI,
        bytes calldata signature
    ) external payable nonReentrant returns (uint256 tokenId) {
        if (status != Status.Started) revert MintNotStarted();
        if (_totalMinted() + 1 > MAX_SUPPLY) revert MaxSupplyExceeded();
        if (msg.value < price) revert EtherAmountMismatch(price, msg.value);

        bytes32 inner = _innerHash(imageURI);
        if (usedHashes[inner]) revert SignatureAlreadyUsed();
        if (_recover(inner, signature) != signer) revert InvalidSignature();

        usedHashes[inner] = true;
        tokenId = _nextTokenId();
        _safeMint(msg.sender, 1);
        _tokenImageURIs[tokenId] = imageURI;
        _refundExcess();

        emit Minted(msg.sender, tokenId, imageURI);
    }

    function numberMinted(address owner) external view returns (uint256) {
        return _numberMinted(owner);
    }

    function tokenImageURI(uint256 tokenId) external view returns (string memory) {
        if (!_exists(tokenId)) revert NonexistentToken();
        return _tokenImageURIs[tokenId];
    }

    ////////////////////////////////////////////////////////////////
    // 管理员
    ////////////////////////////////////////////////////////////////

    function setStatus(Status _status) external onlyOwner {
        status = _status;
        emit StatusChanged(_status);
    }

    function setPrice(uint256 _price) external onlyOwner {
        price = _price;
        emit PriceChanged(_price);
    }

    function setSigner(address _signer) external onlyOwner {
        if (_signer == address(0)) revert InvalidSignature();
        signer = _signer;
        emit SignerChanged(_signer);
    }

    function withdraw(address payable recipient) external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        if (balance == 0) revert WithdrawFailed();
        (bool ok, ) = recipient.call{value: balance}("");
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(recipient, balance);
    }

    ////////////////////////////////////////////////////////////////
    // 内部
    ////////////////////////////////////////////////////////////////

    function _innerHash(string calldata imageURI) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(block.chainid, address(this), msg.sender, imageURI)
        );
    }

    function _recover(bytes32 inner, bytes calldata signature) internal pure returns (address) {
        return MessageHashUtils.toEthSignedMessageHash(inner).recover(signature);
    }

    function _refundExcess() private {
        uint256 excess = msg.value - price;
        if (excess > 0) {
            (bool ok, ) = msg.sender.call{value: excess}("");
            if (!ok) revert RefundFailed();
        }
    }

    function tokenURI(
        uint256 tokenId
    ) public view override(ERC721A) returns (string memory) {
        if (!_exists(tokenId)) revert NonexistentToken();

        string memory imageURI = _tokenImageURIs[tokenId];
        if (bytes(imageURI).length == 0) return "";

        string memory json = Base64.encode(
            bytes(
                string.concat(
                    '{"name":"', name(), " #", tokenId.toString(), '",',
                    '"description":"', description, '",',
                    '"image":"', imageURI, '",',
                    '"attributes":[]}'
                )
            )
        );
        return string.concat("data:application/json;base64,", json);
    }
}
