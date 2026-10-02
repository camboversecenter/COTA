// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {NokorPass} from "./NokorPass.sol";
import {NokorRegistry} from "./NokorRegistry.sol";

/// @title kRIEL / kUSD
/// @notice A fully reserved, closed-loop token. One deployment per currency.
///         - Only pass holders, registered merchants and this contract may hold it.
///         - Every payment goes to escrow first and releases after a dispute window
///           plus a hold set by the merchant's risk class.
///         - A merchant's released balance is a claim; it becomes money only through
///           `cashOut`, which the operator settles to a bank (SPEC §4–5).
///         - Every user action has a signed (EIP-712) variant so the operator can
///           submit it and pay the gas.
contract NokorMoney is ERC20, AccessControl, EIP712, Nonces {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    bytes32 private constant PAY_TYPEHASH = keccak256(
        "Pay(address payer,address merchant,uint256 amount,bytes32 ref,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant DISPUTE_TYPEHASH =
        keccak256("Dispute(address payer,uint256 paymentId,uint256 nonce,uint256 deadline)");
    bytes32 private constant REDEEM_TYPEHASH =
        keccak256("Redeem(address holder,uint256 amount,bytes32 payoutRef,uint256 nonce,uint256 deadline)");
    bytes32 private constant CASHOUT_TYPEHASH =
        keccak256("CashOut(address merchant,uint256 amount,bytes32 bankRef,uint256 nonce,uint256 deadline)");

    enum Status {
        None,
        Escrowed,
        Disputed,
        Released,
        Refunded
    }

    struct Payment {
        address payer;
        address merchant;
        uint256 amount;
        uint64 createdAt;
        uint64 releaseAt;
        Status status;
        bytes32 ref;
    }

    NokorPass public immutable pass;
    NokorRegistry public immutable registry;
    uint8 private immutable _decimals;

    /// @notice Seconds a payer has to dispute a payment.
    uint64 public disputeWindow;
    /// @notice Extra seconds of hold per merchant risk class, after the dispute window.
    mapping(NokorRegistry.RiskClass => uint64) public holdSeconds;
    /// @notice Maximum cash-out per merchant per day, per risk class. 0 = no cap.
    mapping(NokorRegistry.RiskClass => uint256) public dailyCashOutCap;

    uint256 public nextPaymentId = 1;
    mapping(uint256 => Payment) private _payments;
    mapping(bytes32 => uint256) public paymentIdByRef;
    mapping(address => bool) public frozen;
    mapping(address => mapping(uint256 => uint256)) public cashedOutOnDay;

    event Minted(address indexed to, uint256 amount, bytes32 indexed topUpRef);
    event PaymentEscrowed(
        uint256 indexed paymentId,
        address indexed payer,
        address indexed merchant,
        uint256 amount,
        bytes32 ref,
        uint64 releaseAt
    );
    event PaymentDisputed(uint256 indexed paymentId);
    event PaymentReleased(uint256 indexed paymentId);
    event PaymentRefunded(uint256 indexed paymentId);
    event CashOut(address indexed merchant, uint256 amount, bytes32 indexed bankRef);
    event Redeemed(address indexed holder, uint256 amount, bytes32 indexed payoutRef);
    event Frozen(address indexed account, bool frozen);
    event Parameters(uint64 disputeWindow);

    error NotParticipant(address account);
    error AccountFrozen(address account);
    error NotMerchant(address account);
    error ZeroAmount();
    error RefUsed(bytes32 ref);
    error Expired();
    error BadSignature();
    error WrongStatus(uint256 paymentId, Status status);
    error NotPayer(uint256 paymentId);
    error WindowClosed(uint256 paymentId);
    error NotYetReleasable(uint256 paymentId, uint64 releaseAt);
    error CashOutCapExceeded(uint256 requested, uint256 remaining);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address admin,
        NokorPass pass_,
        NokorRegistry registry_,
        uint64 disputeWindow_
    ) ERC20(name_, symbol_) EIP712(name_, "1") {
        _decimals = decimals_;
        pass = pass_;
        registry = registry_;
        disputeWindow = disputeWindow_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // ------------------------------------------------------------------ admin

    function setDisputeWindow(uint64 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        disputeWindow = seconds_;
        emit Parameters(seconds_);
    }

    function setRiskParameters(NokorRegistry.RiskClass rc, uint64 hold, uint256 dailyCap)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        holdSeconds[rc] = hold;
        dailyCashOutCap[rc] = dailyCap;
    }

    function setFrozen(address account, bool value) external onlyRole(OPERATOR_ROLE) {
        frozen[account] = value;
        emit Frozen(account, value);
    }

    // ------------------------------------------------------------------ top-up

    /// @notice Credit a holder after the operator has received card, bank or cash
    ///         funds. Reserves are held one for one off-chain.
    function mint(address to, uint256 amount, bytes32 topUpRef) external onlyRole(MINTER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        _mint(to, amount);
        emit Minted(to, amount, topUpRef);
    }

    // ------------------------------------------------------------------ payments

    function pay(address merchant, uint256 amount, bytes32 ref) external returns (uint256) {
        return _pay(msg.sender, merchant, amount, ref);
    }

    /// @notice Submit a payment the payer approved on their phone.
    function payWithSig(
        address payer,
        address merchant,
        uint256 amount,
        bytes32 ref,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint256) {
        _checkSig(
            payer,
            keccak256(abi.encode(PAY_TYPEHASH, payer, merchant, amount, ref, _useNonce(payer), deadline)),
            deadline,
            signature
        );
        return _pay(payer, merchant, amount, ref);
    }

    function _pay(address payer, address merchant, uint256 amount, bytes32 ref) private returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        if (!registry.isMerchant(merchant)) revert NotMerchant(merchant);
        if (paymentIdByRef[ref] != 0) revert RefUsed(ref);
        _inPay = true;
        _transfer(payer, address(this), amount);
        _inPay = false;
        uint64 releaseAt = uint64(block.timestamp) + disputeWindow + holdSeconds[registry.riskClassOf(merchant)];
        id = nextPaymentId++;
        _payments[id] = Payment(payer, merchant, amount, uint64(block.timestamp), releaseAt, Status.Escrowed, ref);
        paymentIdByRef[ref] = id;
        emit PaymentEscrowed(id, payer, merchant, amount, ref, releaseAt);
    }

    function dispute(uint256 paymentId) external {
        _dispute(msg.sender, paymentId);
    }

    function disputeWithSig(address payer, uint256 paymentId, uint256 deadline, bytes calldata signature) external {
        _checkSig(
            payer,
            keccak256(abi.encode(DISPUTE_TYPEHASH, payer, paymentId, _useNonce(payer), deadline)),
            deadline,
            signature
        );
        _dispute(payer, paymentId);
    }

    function _dispute(address payer, uint256 paymentId) private {
        Payment storage p = _payments[paymentId];
        if (p.status != Status.Escrowed) revert WrongStatus(paymentId, p.status);
        if (p.payer != payer) revert NotPayer(paymentId);
        if (block.timestamp > p.createdAt + disputeWindow) revert WindowClosed(paymentId);
        p.status = Status.Disputed;
        emit PaymentDisputed(paymentId);
    }

    /// @notice Release an undisputed payment once its hold has passed. Anyone may call.
    function release(uint256 paymentId) external {
        Payment storage p = _payments[paymentId];
        if (p.status != Status.Escrowed) revert WrongStatus(paymentId, p.status);
        if (block.timestamp < p.releaseAt) revert NotYetReleasable(paymentId, p.releaseAt);
        p.status = Status.Released;
        _transfer(address(this), p.merchant, p.amount);
        emit PaymentReleased(paymentId);
    }

    /// @notice Decide a disputed payment, or claw back an escrowed one found to be
    ///         fraudulent. Only funds still in escrow can be moved.
    function resolve(uint256 paymentId, bool refundPayer) external onlyRole(OPERATOR_ROLE) {
        Payment storage p = _payments[paymentId];
        if (p.status != Status.Escrowed && p.status != Status.Disputed) revert WrongStatus(paymentId, p.status);
        if (refundPayer) {
            p.status = Status.Refunded;
            _refundTransfer(p.payer, p.amount);
            emit PaymentRefunded(paymentId);
        } else {
            p.status = Status.Released;
            _transfer(address(this), p.merchant, p.amount);
            emit PaymentReleased(paymentId);
        }
    }

    /// @dev A refund must reach a payer whose pass has since closed (a visitor who
    ///      has left); it goes back to them so it can be refunded at departure.
    function _refundTransfer(address to, uint256 amount) private {
        _refunding = true;
        _transfer(address(this), to, amount);
        _refunding = false;
    }

    bool private _refunding;

    function paymentInfo(uint256 paymentId) external view returns (Payment memory) {
        return _payments[paymentId];
    }

    // ------------------------------------------------------------------ exits

    /// @notice A merchant converts released balance to money in its bank account.
    ///         The operator settles `bankRef` off-chain. Capped per day by risk class.
    function cashOut(uint256 amount, bytes32 bankRef) external {
        _cashOut(msg.sender, amount, bankRef);
    }

    /// @notice Cash-out signed on the merchant's device and submitted by the operator.
    function cashOutWithSig(address merchant, uint256 amount, bytes32 bankRef, uint256 deadline, bytes calldata signature)
        external
    {
        _checkSig(
            merchant,
            keccak256(abi.encode(CASHOUT_TYPEHASH, merchant, amount, bankRef, _useNonce(merchant), deadline)),
            deadline,
            signature
        );
        _cashOut(merchant, amount, bankRef);
    }

    function _cashOut(address merchant, uint256 amount, bytes32 bankRef) private {
        if (amount == 0) revert ZeroAmount();
        uint256 cap = dailyCashOutCap[registry.riskClassOf(merchant)];
        uint256 today = block.timestamp / 1 days;
        if (cap != 0) {
            uint256 used = cashedOutOnDay[merchant][today];
            if (used + amount > cap) revert CashOutCapExceeded(amount, cap - used);
        }
        cashedOutOnDay[merchant][today] += amount;
        _burn(merchant, amount);
        emit CashOut(merchant, amount, bankRef);
    }

    /// @notice A holder converts balance back to money: a visitor at departure, or a
    ///         resident at any time. The operator pays `payoutRef` off-chain.
    function redeem(uint256 amount, bytes32 payoutRef) external {
        _redeem(msg.sender, amount, payoutRef);
    }

    function redeemWithSig(address holder, uint256 amount, bytes32 payoutRef, uint256 deadline, bytes calldata signature)
        external
    {
        _checkSig(
            holder,
            keccak256(abi.encode(REDEEM_TYPEHASH, holder, amount, payoutRef, _useNonce(holder), deadline)),
            deadline,
            signature
        );
        _redeem(holder, amount, payoutRef);
    }

    function _redeem(address holder, uint256 amount, bytes32 payoutRef) private {
        if (amount == 0) revert ZeroAmount();
        // Merchants leave only through cashOut, which applies the daily cap.
        if (registry.isMerchant(holder)) revert NotParticipant(holder);
        _burn(holder, amount);
        emit Redeemed(holder, amount, payoutRef);
    }

    // ------------------------------------------------------------------ closed loop

    /// @dev The rules of the loop:
    ///      - mint: only to a holder of a valid pass;
    ///      - into escrow: only through `pay`;
    ///      - out of escrow: to the merchant (release) or back to the payer (refund);
    ///      - between holders: allowed, both with valid passes (family, friends);
    ///      - merchants never transfer; their only exit is `cashOut` (a burn);
    ///      - burns are always allowed to the owner; frozen accounts cannot move.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && frozen[from]) revert AccountFrozen(from);
        if (to != address(0) && frozen[to]) revert AccountFrozen(to);
        if (from == address(0)) {
            if (!pass.hasValidPass(to)) revert NotParticipant(to);
        } else if (to != address(0)) {
            if (from == address(this)) {
                if (!_refunding && !registry.isMerchant(to)) revert NotMerchant(to);
            } else {
                // Merchant balances never move on, even if the address also holds a pass.
                if (!pass.hasValidPass(from) || registry.isMerchant(from)) revert NotParticipant(from);
                if (to == address(this) ? !_inPay : !pass.hasValidPass(to)) revert NotParticipant(to);
            }
        }
        super._update(from, to, value);
    }

    bool private _inPay;

    // ------------------------------------------------------------------ signatures

    function _checkSig(address signer, bytes32 structHash, uint256 deadline, bytes calldata signature) private view {
        if (block.timestamp > deadline) revert Expired();
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != signer) revert BadSignature();
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
