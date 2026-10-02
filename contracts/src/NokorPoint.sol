// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {NokorPass} from "./NokorPass.sol";

/// @title Nokor Point
/// @notice Giftable points with no cash value. The token id of a point is the pass
///         on which it was earned, so every redemption shows, without identifying
///         anyone, whether the point came back on a later trip of the same person
///         (return) or was spent by someone else (spread) (SPEC §7).
///
///         A gift is created into escrow with a one-time claim key. The giver sends
///         the key to a friend (in a link); the friend, once holding a pass, claims.
///         The claim key signs the recipient's address, so a claim seen in transit
///         cannot be redirected to another account.
contract NokorPoint is ERC1155, AccessControl, EIP712, Nonces {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant REDEEMER_ROLE = keccak256("REDEEMER_ROLE");

    bytes32 private constant GIFT_TYPEHASH = keccak256(
        "Gift(address giver,uint256 earnedOnPass,uint256 amount,address claimKey,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant CLAIM_TYPEHASH = keccak256("Claim(uint256 giftId,address recipient)");
    bytes32 private constant REDEEM_TYPEHASH = keccak256(
        "RedeemPoints(address holder,uint256 earnedOnPass,uint256 amount,bytes32 offerRef,uint256 nonce,uint256 deadline)"
    );

    struct Gift {
        address giver;
        uint256 earnedOnPass;
        uint256 amount;
        address claimKey; // address of the one-time key; zero once claimed or cancelled
        uint64 createdAt;
    }

    NokorPass public immutable pass;
    /// @notice Points expire this many seconds after the pass they were earned on was issued.
    uint64 public lifetime;

    uint256 public nextGiftId = 1;
    mapping(uint256 => Gift) private _gifts;
    bool private _intoEscrow;

    event Awarded(uint256 indexed earnedOnPass, address indexed to, uint256 amount, bytes32 indexed reasonRef);
    event GiftCreated(uint256 indexed giftId, address indexed giver, uint256 earnedOnPass, uint256 amount);
    event GiftClaimed(uint256 indexed giftId, address indexed recipient, uint256 recipientPass);
    event GiftCancelled(uint256 indexed giftId);
    /// @param returning the point came back on a later pass of the same person
    /// @param spread the point was spent by a different person
    event PointsRedeemed(
        uint256 indexed redeemerPass,
        uint256 indexed earnedOnPass,
        uint256 amount,
        bytes32 indexed offerRef,
        bool returning,
        bool spread
    );

    error NoValidPass(address account);
    error ZeroAmount();
    error PointsExpired(uint256 earnedOnPass);
    error Expired();
    error BadSignature();
    error GiftUnavailable(uint256 giftId);
    error NotGiver(uint256 giftId);

    constructor(address admin, NokorPass pass_, uint64 lifetime_) ERC1155("") EIP712("Nokor Point", "1") {
        pass = pass_;
        lifetime = lifetime_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function setLifetime(uint64 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        lifetime = seconds_;
    }

    // ------------------------------------------------------------------ earning

    /// @notice Award points on the recipient's current pass. The policy (how many
    ///         points for which event) is set by the Ministry of Tourism off-chain.
    function award(address to, uint256 amount, bytes32 reasonRef) external onlyRole(MINTER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        uint256 passId = pass.validPassOf(to);
        if (passId == 0) revert NoValidPass(to);
        _mint(to, passId, amount, "");
        emit Awarded(passId, to, amount, reasonRef);
    }

    function expiresAt(uint256 earnedOnPass) public view returns (uint64) {
        return pass.passInfo(earnedOnPass).issuedAt + lifetime;
    }

    // ------------------------------------------------------------------ gifting

    function createGift(uint256 earnedOnPass, uint256 amount, address claimKey) external returns (uint256) {
        return _createGift(msg.sender, earnedOnPass, amount, claimKey);
    }

    function createGiftWithSig(
        address giver,
        uint256 earnedOnPass,
        uint256 amount,
        address claimKey,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256) {
        _checkSig(
            giver,
            keccak256(abi.encode(GIFT_TYPEHASH, giver, earnedOnPass, amount, claimKey, _useNonce(giver), deadline)),
            deadline,
            signature
        );
        return _createGift(giver, earnedOnPass, amount, claimKey);
    }

    /// @dev A giver need not hold a valid pass: a visitor who has gone home can
    ///      still send points to a friend who is planning a trip.
    function _createGift(address giver, uint256 earnedOnPass, uint256 amount, address claimKey)
        private
        returns (uint256 giftId)
    {
        if (amount == 0 || claimKey == address(0)) revert ZeroAmount();
        _intoEscrow = true;
        _safeTransferFrom(giver, address(this), earnedOnPass, amount, "");
        _intoEscrow = false;
        giftId = nextGiftId++;
        _gifts[giftId] = Gift(giver, earnedOnPass, amount, claimKey, uint64(block.timestamp));
        emit GiftCreated(giftId, giver, earnedOnPass, amount);
    }

    /// @notice Claim a gift. `claimSignature` is the claim key's signature over
    ///         (giftId, recipient). Anyone may submit it; the points go only to
    ///         `recipient`, who must hold a valid pass.
    function claimGift(uint256 giftId, address recipient, bytes calldata claimSignature) external {
        Gift storage g = _gifts[giftId];
        if (g.claimKey == address(0)) revert GiftUnavailable(giftId);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, giftId, recipient)));
        if (ECDSA.recover(digest, claimSignature) != g.claimKey) revert BadSignature();
        uint256 recipientPass = pass.validPassOf(recipient);
        if (recipientPass == 0) revert NoValidPass(recipient);
        g.claimKey = address(0);
        _safeTransferFrom(address(this), recipient, g.earnedOnPass, g.amount, "");
        emit GiftClaimed(giftId, recipient, recipientPass);
    }

    function cancelGift(uint256 giftId) external {
        Gift storage g = _gifts[giftId];
        if (g.claimKey == address(0)) revert GiftUnavailable(giftId);
        if (g.giver != msg.sender) revert NotGiver(giftId);
        g.claimKey = address(0);
        _intoEscrow = true; // the giver may no longer hold a valid pass
        _safeTransferFrom(address(this), g.giver, g.earnedOnPass, g.amount, "");
        _intoEscrow = false;
        emit GiftCancelled(giftId);
    }

    function giftInfo(uint256 giftId) external view returns (Gift memory) {
        return _gifts[giftId];
    }

    // ------------------------------------------------------------------ redeeming

    /// @notice Spend points on an offer (a merchant's discount, the state's
    ///         baseline use). Submitted by the operator with the holder's signature.
    function redeemWithSig(
        address holder,
        uint256 earnedOnPass,
        uint256 amount,
        bytes32 offerRef,
        uint256 deadline,
        bytes calldata signature
    ) external onlyRole(REDEEMER_ROLE) {
        _checkSig(
            holder,
            keccak256(abi.encode(REDEEM_TYPEHASH, holder, earnedOnPass, amount, offerRef, _useNonce(holder), deadline)),
            deadline,
            signature
        );
        if (amount == 0) revert ZeroAmount();
        uint256 redeemerPass = pass.validPassOf(holder);
        if (redeemerPass == 0) revert NoValidPass(holder);
        _burn(holder, earnedOnPass, amount);
        bool same = pass.samePerson(redeemerPass, earnedOnPass);
        emit PointsRedeemed(redeemerPass, earnedOnPass, amount, offerRef, same && redeemerPass != earnedOnPass, !same);
    }

    // ------------------------------------------------------------------ rules

    /// @dev Points move only: into gift escrow, out of escrow to a pass holder, or
    ///      directly between holders of valid passes. Expired points do not move.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0)) {
            for (uint256 i; i < ids.length; ++i) {
                if (block.timestamp > expiresAt(ids[i])) revert PointsExpired(ids[i]);
            }
        }
        if (from != address(0) && to != address(0) && !_intoEscrow) {
            if (to != address(this) && !pass.hasValidPass(to)) revert NoValidPass(to);
            if (to == address(this)) revert NoValidPass(to);
            if (from != address(this) && !pass.hasValidPass(from)) revert NoValidPass(from);
        }
        super._update(from, to, ids, values);
    }

    function _checkSig(address signer, bytes32 structHash, uint256 deadline, bytes calldata signature) private view {
        if (block.timestamp > deadline) revert Expired();
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != signer) revert BadSignature();
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    /// @dev Receiving hook for gifts held in escrow by this contract.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }
}
