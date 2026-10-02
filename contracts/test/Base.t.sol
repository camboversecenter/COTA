// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {NokorPass} from "../src/NokorPass.sol";
import {NokorRegistry} from "../src/NokorRegistry.sol";
import {NokorMoney} from "../src/NokorMoney.sol";
import {NokorAccess} from "../src/NokorAccess.sol";
import {NokorPoint} from "../src/NokorPoint.sol";

/// Shared deployment: one admin, one operator, two visitors, one resident,
/// a tuk-tuk driver, a new restaurant and the Angkor site authority.
abstract contract Base is Test {
    NokorPass pass;
    NokorRegistry registry;
    NokorMoney kUSD;
    NokorMoney kRIEL;
    NokorAccess access;
    NokorPoint point;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address issuer = makeAddr("immigration");
    address gate = makeAddr("gate");

    uint256 alicePk = 0xA11CE;
    uint256 bobPk = 0xB0B;
    uint256 carolPk = 0xCA201;
    address alice; // visitor
    address bob; // visitor, friend of alice
    address carol; // resident

    address tuktuk = makeAddr("tuktuk");
    address restaurant = makeAddr("restaurant");
    address angkor = makeAddr("angkor-enterprise");

    bytes32 constant ALICE_DOC = keccak256("hmac:alice-passport");
    bytes32 constant BOB_DOC = keccak256("hmac:bob-passport");
    bytes32 constant CAROL_DOC = keccak256("hmac:carol-id-card");
    bytes32 constant SITE_ANGKOR_WAT = "angkor-wat";
    bytes32 constant SITE_BAYON = "bayon";
    bytes32 constant SITE_KOH_KER = "koh-ker";

    uint64 constant DISPUTE_WINDOW = 1 days;

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        alice = vm.addr(alicePk);
        bob = vm.addr(bobPk);
        carol = vm.addr(carolPk);

        vm.startPrank(admin);
        pass = new NokorPass(admin);
        registry = new NokorRegistry(admin);
        kUSD = new NokorMoney("Khmer USD", "kUSD", 2, admin, pass, registry, DISPUTE_WINDOW);
        kRIEL = new NokorMoney("Khmer Riel", "kRIEL", 0, admin, pass, registry, DISPUTE_WINDOW);
        access = new NokorAccess(admin, pass, kUSD, kRIEL);
        point = new NokorPoint(admin, pass, 3 * 365 days);

        pass.grantRole(pass.ISSUER_ROLE(), issuer);
        registry.grantRole(registry.MERCHANT_ADMIN_ROLE(), operator);
        kUSD.grantRole(kUSD.MINTER_ROLE(), operator);
        kUSD.grantRole(kUSD.OPERATOR_ROLE(), operator);
        kRIEL.grantRole(kRIEL.MINTER_ROLE(), operator);
        kRIEL.grantRole(kRIEL.OPERATOR_ROLE(), operator);
        access.grantRole(access.SITE_ADMIN_ROLE(), operator);
        access.grantRole(access.GATE_ROLE(), gate);
        point.grantRole(point.MINTER_ROLE(), operator);
        point.grantRole(point.REDEEMER_ROLE(), operator);

        // New merchants wait two extra days; daily cash-out capped at $500.
        kUSD.setRiskParameters(NokorRegistry.RiskClass.New, 2 days, 500_00);
        kUSD.setRiskParameters(NokorRegistry.RiskClass.Standard, 0, 0);
        vm.stopPrank();

        vm.startPrank(operator);
        registry.register(tuktuk, "tuktuk", "siem-reap", NokorRegistry.RiskClass.Standard);
        registry.register(restaurant, "restaurant", "siem-reap", NokorRegistry.RiskClass.New);
        registry.register(angkor, "site", "siem-reap", NokorRegistry.RiskClass.Established);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function issueVisitor(address who, bytes32 doc) internal returns (uint256) {
        vm.prank(issuer);
        return pass.issue(who, NokorPass.Category.Visitor, doc, uint64(block.timestamp + 30 days));
    }

    function issueResident(address who, bytes32 doc) internal returns (uint256) {
        vm.prank(issuer);
        return pass.issue(who, NokorPass.Category.Resident, doc, 0);
    }

    function topUp(NokorMoney m, address who, uint256 amount) internal {
        vm.prank(operator);
        m.mint(who, amount, keccak256(abi.encode("topup", who, amount, block.timestamp)));
    }

    function digest(bytes32 domain, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function sign(uint256 pk, bytes32 domain, bytes32 structHash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest(domain, structHash));
        return abi.encodePacked(r, s, v);
    }

    function signPay(uint256 pk, NokorMoney m, address merchant, uint256 amount, bytes32 ref, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        address payer = vm.addr(pk);
        bytes32 h = keccak256(
            abi.encode(
                keccak256(
                    "Pay(address payer,address merchant,uint256 amount,bytes32 ref,uint256 nonce,uint256 deadline)"
                ),
                payer,
                merchant,
                amount,
                ref,
                m.nonces(payer),
                deadline
            )
        );
        return sign(pk, m.domainSeparator(), h);
    }

    function payAs(uint256 pk, NokorMoney m, address merchant, uint256 amount, bytes32 ref) internal returns (uint256) {
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = signPay(pk, m, merchant, amount, ref, deadline);
        vm.prank(operator); // the relayer pays gas; anyone may submit
        return m.payWithSig(vm.addr(pk), merchant, amount, ref, deadline, sig);
    }
}
