// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {NokorPass} from "./NokorPass.sol";
import {NokorMoney} from "./NokorMoney.sol";

/// @title Nokor Access
/// @notice Site access as entitlements on the pass. A site authority publishes
///         products (a day at Angkor, a bundle of lesser-known sites); a holder buys
///         one with an ordinary escrowed payment to the authority; the grant is
///         checked against that payment on-chain. At the gate the site's device
///         starts the check and the holder confirms with a signature; each entry is
///         recorded as a visit (SPEC §6).
contract NokorAccess is AccessControl, EIP712, Nonces {
    bytes32 public constant SITE_ADMIN_ROLE = keccak256("SITE_ADMIN_ROLE");
    bytes32 public constant GATE_ROLE = keccak256("GATE_ROLE");

    bytes32 private constant ENTER_TYPEHASH = keccak256(
        "Enter(address holder,uint256 productId,bytes32 siteId,bytes32 gateRef,uint256 nonce,uint256 deadline)"
    );

    uint32 public constant UNLIMITED = type(uint32).max;

    struct Product {
        bool active;
        address payee; // the site authority's merchant account
        uint256 priceKUSD;
        uint256 priceKRIEL;
        uint64 validitySeconds;
        uint32 entries; // UNLIMITED for no limit
        bytes32 name;
    }

    struct Entitlement {
        uint64 expiresAt;
        uint32 entriesLeft;
    }

    NokorPass public immutable pass;
    NokorMoney public immutable kUSD;
    NokorMoney public immutable kRIEL;

    uint256 public nextProductId = 1;
    mapping(uint256 => Product) private _products;
    mapping(uint256 => mapping(bytes32 => bool)) public productCoversSite;
    mapping(address => mapping(uint256 => Entitlement)) private _entitlements;
    /// @notice Payment ref already used for a grant (one payment, one grant).
    mapping(bytes32 => bool) public grantRefUsed;

    event ProductCreated(uint256 indexed productId, bytes32 name, address payee, uint64 validitySeconds, uint32 entries);
    event ProductSite(uint256 indexed productId, bytes32 indexed siteId, bool covered);
    event ProductStatus(uint256 indexed productId, bool active);
    event Granted(uint256 indexed passId, address indexed holder, uint256 indexed productId, bytes32 paymentRef, uint64 expiresAt);
    event Visit(
        uint256 indexed passId,
        address indexed holder,
        bytes32 indexed siteId,
        uint256 productId,
        bytes32 gateRef,
        uint64 at
    );

    error UnknownProduct(uint256 productId);
    error ProductInactive(uint256 productId);
    error NoValidPass(address holder);
    error PaymentMismatch(bytes32 ref);
    error RefUsed(bytes32 ref);
    error SiteNotCovered(uint256 productId, bytes32 siteId);
    error NotEntitled(address holder, uint256 productId);
    error Expired();
    error BadSignature();
    error NotPayer(bytes32 ref);

    constructor(address admin, NokorPass pass_, NokorMoney kUSD_, NokorMoney kRIEL_) EIP712("Nokor Access", "1") {
        pass = pass_;
        kUSD = kUSD_;
        kRIEL = kRIEL_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ products

    function createProduct(
        bytes32 name,
        address payee,
        uint256 priceKUSD,
        uint256 priceKRIEL,
        uint64 validitySeconds,
        uint32 entries,
        bytes32[] calldata siteIds
    ) external onlyRole(SITE_ADMIN_ROLE) returns (uint256 productId) {
        productId = nextProductId++;
        _products[productId] = Product(true, payee, priceKUSD, priceKRIEL, validitySeconds, entries, name);
        emit ProductCreated(productId, name, payee, validitySeconds, entries);
        for (uint256 i; i < siteIds.length; ++i) {
            productCoversSite[productId][siteIds[i]] = true;
            emit ProductSite(productId, siteIds[i], true);
        }
    }

    function setProductActive(uint256 productId, bool active) external onlyRole(SITE_ADMIN_ROLE) {
        _product(productId).active = active;
        emit ProductStatus(productId, active);
    }

    function productInfo(uint256 productId) external view returns (Product memory) {
        return _products[productId];
    }

    // ------------------------------------------------------------------ purchase

    /// @notice Grant an entitlement against a payment already made to the product's
    ///         payee. Only the payer, or the site admin relaying for them, may claim,
    ///         so nobody else can spend the payment on a different product first.
    function claim(uint256 productId, NokorMoney currency, bytes32 paymentRef) external returns (uint64 expiresAt) {
        Product storage pr = _product(productId);
        if (!pr.active) revert ProductInactive(productId);
        if (grantRefUsed[paymentRef]) revert RefUsed(paymentRef);
        uint256 price;
        if (address(currency) == address(kUSD)) price = pr.priceKUSD;
        else if (address(currency) == address(kRIEL)) price = pr.priceKRIEL;
        else revert PaymentMismatch(paymentRef);

        uint256 pid = currency.paymentIdByRef(paymentRef);
        NokorMoney.Payment memory p = currency.paymentInfo(pid);
        bool paid = p.status == NokorMoney.Status.Escrowed || p.status == NokorMoney.Status.Released;
        if (pid == 0 || !paid || p.merchant != pr.payee || p.amount < price || price == 0) {
            revert PaymentMismatch(paymentRef);
        }
        if (msg.sender != p.payer && !hasRole(SITE_ADMIN_ROLE, msg.sender)) revert NotPayer(paymentRef);
        uint256 passId = pass.validPassOf(p.payer);
        if (passId == 0) revert NoValidPass(p.payer);

        grantRefUsed[paymentRef] = true;
        Entitlement storage e = _entitlements[p.payer][productId];
        expiresAt = uint64(block.timestamp) + pr.validitySeconds;
        e.expiresAt = expiresAt;
        if (pr.entries == UNLIMITED || e.entriesLeft == UNLIMITED) e.entriesLeft = UNLIMITED;
        else e.entriesLeft += pr.entries;
        emit Granted(passId, p.payer, productId, paymentRef, expiresAt);
    }

    function entitlementOf(address holder, uint256 productId) external view returns (Entitlement memory) {
        return _entitlements[holder][productId];
    }

    // ------------------------------------------------------------------ gate

    /// @notice Record an entry. Called by a site gate; the holder's signature proves
    ///         the holder was present and agreed.
    function enterWithSig(
        address holder,
        uint256 productId,
        bytes32 siteId,
        bytes32 gateRef,
        uint256 deadline,
        bytes calldata signature
    ) external onlyRole(GATE_ROLE) {
        if (block.timestamp > deadline) revert Expired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(ENTER_TYPEHASH, holder, productId, siteId, gateRef, _useNonce(holder), deadline))
        );
        if (ECDSA.recover(digest, signature) != holder) revert BadSignature();

        uint256 passId = pass.validPassOf(holder);
        if (passId == 0) revert NoValidPass(holder);
        if (!productCoversSite[productId][siteId]) revert SiteNotCovered(productId, siteId);
        Entitlement storage e = _entitlements[holder][productId];
        if (e.expiresAt < block.timestamp || e.entriesLeft == 0) revert NotEntitled(holder, productId);
        if (e.entriesLeft != UNLIMITED) e.entriesLeft -= 1;
        emit Visit(passId, holder, siteId, productId, gateRef, uint64(block.timestamp));
    }

    /// @notice Withdraw an entitlement, e.g. after the payment behind it was refunded.
    function revokeEntitlement(address holder, uint256 productId) external onlyRole(SITE_ADMIN_ROLE) {
        delete _entitlements[holder][productId];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _product(uint256 productId) private view returns (Product storage pr) {
        pr = _products[productId];
        if (pr.payee == address(0)) revert UnknownProduct(productId);
    }
}
