// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Nokor merchant registry
/// @notice Registered merchants are the only accounts that may receive payments.
///         Each merchant has a risk class, which sets how long its proceeds are
///         held before release and how much it may cash out per day (SPEC §5).
contract NokorRegistry is AccessControl {
    bytes32 public constant MERCHANT_ADMIN_ROLE = keccak256("MERCHANT_ADMIN_ROLE");

    /// @dev Established merchants carry no extra hold; new ones carry the most.
    enum RiskClass {
        Established,
        Standard,
        New
    }

    struct Merchant {
        bool active;
        RiskClass riskClass;
        bytes32 category; // e.g. "tuktuk", "restaurant", "site"
        bytes32 province; // e.g. "siem-reap"
        uint64 registeredAt;
    }

    mapping(address => Merchant) private _merchants;

    event MerchantRegistered(address indexed merchant, bytes32 category, bytes32 province, RiskClass riskClass);
    event MerchantUpdated(address indexed merchant, bool active, RiskClass riskClass);

    error AlreadyRegistered(address merchant);
    error NotRegistered(address merchant);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function register(address merchant, bytes32 category, bytes32 province, RiskClass riskClass)
        external
        onlyRole(MERCHANT_ADMIN_ROLE)
    {
        if (_merchants[merchant].registeredAt != 0) revert AlreadyRegistered(merchant);
        _merchants[merchant] = Merchant(true, riskClass, category, province, uint64(block.timestamp));
        emit MerchantRegistered(merchant, category, province, riskClass);
    }

    function update(address merchant, bool active, RiskClass riskClass) external onlyRole(MERCHANT_ADMIN_ROLE) {
        Merchant storage m = _merchants[merchant];
        if (m.registeredAt == 0) revert NotRegistered(merchant);
        m.active = active;
        m.riskClass = riskClass;
        emit MerchantUpdated(merchant, active, riskClass);
    }

    function isMerchant(address account) external view returns (bool) {
        return _merchants[account].active;
    }

    function merchantInfo(address merchant) external view returns (Merchant memory) {
        return _merchants[merchant];
    }

    function riskClassOf(address merchant) external view returns (RiskClass) {
        return _merchants[merchant].riskClass;
    }
}
