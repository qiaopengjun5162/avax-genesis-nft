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
 * @title GenesisMint
 * @dev ERC721A 创世 NFT：ECDSA 签名白名单 mint（一人一图一签名）
 *
 * 设计（相对参考 MFNFT 的修复，见 README）：
 *  - 签名绑定 (chainid, 本合约, minter, imageURI) → 防跨链/跨合约/跨钱包重放
 *  - 每钱包限 1 张（_numberMinted 链上强制）→ 签名只能用自己的
 *  - EOA 检查去掉：msg.sender 绑定已足够，智能合约钱包(ERC-1271)可扩展
 *  - 退款用低层 call 而非 transfer(2300 gas)
 *  - 全部 custom errors，省 gas 且便于前端解析
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

    // tokenId => 该 NFT 的独立图片 URI（后端按钱包分配）
    mapping(uint256 => string) private _tokenImageURIs;

    error MintNotStarted();
    error WalletAlreadyMinted();
    error InvalidSignature();
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
     * @dev 白名单 mint：前端向后端要签名 → 提交 (imageURI, signature)
     * signature = signer 对 keccak(chainid, address(this), msg.sender, imageURI)
     *            经 toEthSignedMessageHash 包装后的哈希的 ECDSA 签名
     */
    function mint(
        string calldata imageURI,
        bytes calldata signature
    ) external payable nonReentrant returns (uint256 tokenId) {
        if (status != Status.Started) revert MintNotStarted();
        if (_totalMinted() + 1 > MAX_SUPPLY) revert MaxSupplyExceeded();
        if (_numberMinted(msg.sender) != 0) revert WalletAlreadyMinted();
        if (msg.value < price) revert EtherAmountMismatch(price, msg.value);
        if (!_isValidSignature(imageURI, signature)) revert InvalidSignature();

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

    function _isValidSignature(
        string calldata imageURI,
        bytes calldata signature
    ) internal view returns (bool) {
        bytes32 inner = keccak256(
            abi.encodePacked(block.chainid, address(this), msg.sender, imageURI)
        );
        address recovered = MessageHashUtils.toEthSignedMessageHash(inner).recover(signature);
        return recovered == signer && recovered != address(0);
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
