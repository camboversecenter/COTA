// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {NokorAccess} from "../src/NokorAccess.sol";
import {NokorMoney} from "../src/NokorMoney.sol";

contract NokorAccessTest is Base {
    uint256 dayPass;
    uint256 northBundle;

    function setUp() public override {
        super.setUp();
        issueVisitor(alice, ALICE_DOC);
        issueVisitor(bob, BOB_DOC);
        topUp(kUSD, alice, 200_00);
        topUp(kRIEL, bob, 400_000);

        bytes32[] memory angkorSites = new bytes32[](2);
        angkorSites[0] = SITE_ANGKOR_WAT;
        angkorSites[1] = SITE_BAYON;
        bytes32[] memory northSites = new bytes32[](1);
        northSites[0] = SITE_KOH_KER;

        vm.startPrank(operator);
        dayPass = access.createProduct("Angkor 1-day", angkor, 37_00, 148_000, 1 days, access.UNLIMITED(), angkorSites);
        northBundle = access.createProduct("Northern temples", angkor, 15_00, 60_000, 7 days, 2, northSites);
        vm.stopPrank();
    }

    function buy(uint256 pk, NokorMoney m, uint256 productId, uint256 amount, bytes32 ref) internal {
        payAs(pk, m, angkor, amount, ref);
        vm.prank(operator);
        access.claim(productId, m, ref);
    }

    function signEnter(uint256 pk, uint256 productId, bytes32 siteId, bytes32 gateRef, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        address holder = vm.addr(pk);
        bytes32 h = keccak256(
            abi.encode(
                keccak256(
                    "Enter(address holder,uint256 productId,bytes32 siteId,bytes32 gateRef,uint256 nonce,uint256 deadline)"
                ),
                holder,
                productId,
                siteId,
                gateRef,
                access.nonces(holder),
                deadline
            )
        );
        return sign(pk, access.domainSeparator(), h);
    }

    function enter(uint256 pk, uint256 productId, bytes32 siteId, bytes32 gateRef) internal {
        uint256 deadline = block.timestamp + 2 minutes;
        bytes memory sig = signEnter(pk, productId, siteId, gateRef, deadline);
        vm.prank(gate);
        access.enterWithSig(vm.addr(pk), productId, siteId, gateRef, deadline, sig);
    }

    function test_buy_in_dollars_and_enter_any_covered_site() public {
        buy(alicePk, kUSD, dayPass, 37_00, "buy-1");
        enter(alicePk, dayPass, SITE_ANGKOR_WAT, "g1");
        enter(alicePk, dayPass, SITE_BAYON, "g2");
        enter(alicePk, dayPass, SITE_ANGKOR_WAT, "g3"); // unlimited entries
        assertEq(access.entitlementOf(alice, dayPass).entriesLeft, access.UNLIMITED());
    }

    function test_buy_in_riel_with_limited_entries() public {
        buy(bobPk, kRIEL, northBundle, 60_000, "buy-2");
        enter(bobPk, northBundle, SITE_KOH_KER, "g1");
        enter(bobPk, northBundle, SITE_KOH_KER, "g2");
        uint256 deadline = block.timestamp + 2 minutes;
        bytes memory sig = signEnter(bobPk, northBundle, SITE_KOH_KER, "g3", deadline);
        vm.prank(gate);
        vm.expectRevert(abi.encodeWithSelector(NokorAccess.NotEntitled.selector, bob, northBundle));
        access.enterWithSig(bob, northBundle, SITE_KOH_KER, "g3", deadline, sig);
    }

    function test_entitlement_expires() public {
        buy(alicePk, kUSD, dayPass, 37_00, "buy-1");
        vm.warp(block.timestamp + 1 days + 1);
        uint256 deadline = block.timestamp + 2 minutes;
        bytes memory sig = signEnter(alicePk, dayPass, SITE_BAYON, "g1", deadline);
        vm.prank(gate);
        vm.expectRevert(abi.encodeWithSelector(NokorAccess.NotEntitled.selector, alice, dayPass));
        access.enterWithSig(alice, dayPass, SITE_BAYON, "g1", deadline, sig);
    }

    function test_site_must_be_covered() public {
        buy(alicePk, kUSD, dayPass, 37_00, "buy-1");
        uint256 deadline = block.timestamp + 2 minutes;
        bytes memory sig = signEnter(alicePk, dayPass, SITE_KOH_KER, "g1", deadline);
        vm.prank(gate);
        vm.expectRevert(abi.encodeWithSelector(NokorAccess.SiteNotCovered.selector, dayPass, SITE_KOH_KER));
        access.enterWithSig(alice, dayPass, SITE_KOH_KER, "g1", deadline, sig);
    }

    function test_claim_requires_matching_payment() public {
        payAs(alicePk, kUSD, angkor, 10_00, "too-little");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NokorAccess.PaymentMismatch.selector, bytes32("too-little")));
        access.claim(dayPass, kUSD, "too-little");

        payAs(alicePk, kUSD, tuktuk, 37_00, "wrong-payee");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NokorAccess.PaymentMismatch.selector, bytes32("wrong-payee")));
        access.claim(dayPass, kUSD, "wrong-payee");
    }

    function test_one_payment_one_grant() public {
        buy(alicePk, kUSD, dayPass, 37_00, "buy-1");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NokorAccess.RefUsed.selector, bytes32("buy-1")));
        access.claim(dayPass, kUSD, "buy-1");
    }

    function test_only_payer_or_site_admin_claims() public {
        payAs(alicePk, kUSD, angkor, 37_00, "buy-2");
        vm.prank(bob); // a third party cannot spend Alice's payment on another product
        vm.expectRevert(abi.encodeWithSelector(NokorAccess.NotPayer.selector, bytes32("buy-2")));
        access.claim(northBundle, kUSD, "buy-2");
        vm.prank(alice);
        access.claim(dayPass, kUSD, "buy-2");
        assertGt(access.entitlementOf(alice, dayPass).expiresAt, 0);
    }

    function test_holder_must_sign_entry() public {
        buy(alicePk, kUSD, dayPass, 37_00, "buy-1");
        uint256 deadline = block.timestamp + 2 minutes;
        bytes memory bobSig = signEnter(bobPk, dayPass, SITE_BAYON, "g1", deadline);
        vm.prank(gate);
        vm.expectRevert(NokorAccess.BadSignature.selector);
        access.enterWithSig(alice, dayPass, SITE_BAYON, "g1", deadline, bobSig);
    }

    function test_only_gates_record_entries() public {
        buy(alicePk, kUSD, dayPass, 37_00, "buy-1");
        uint256 deadline = block.timestamp + 2 minutes;
        bytes memory sig = signEnter(alicePk, dayPass, SITE_BAYON, "g1", deadline);
        vm.prank(alice);
        vm.expectRevert();
        access.enterWithSig(alice, dayPass, SITE_BAYON, "g1", deadline, sig);
    }
}
