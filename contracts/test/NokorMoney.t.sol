// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {NokorPass} from "../src/NokorPass.sol";
import {Base} from "./Base.t.sol";
import {NokorMoney} from "../src/NokorMoney.sol";
import {NokorRegistry} from "../src/NokorRegistry.sol";

contract NokorMoneyTest is Base {
    function setUp() public override {
        super.setUp();
        issueVisitor(alice, ALICE_DOC);
        issueVisitor(bob, BOB_DOC);
        topUp(kUSD, alice, 100_00); // $100.00
    }

    // ------------------------------------------------------------------ top-up

    function test_mint_only_to_pass_holders() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(NokorMoney.NotParticipant.selector, tuktuk));
        kUSD.mint(tuktuk, 1, "ref");
        assertEq(kUSD.balanceOf(alice), 100_00);
    }

    // ------------------------------------------------------------------ paying

    function test_payment_goes_to_escrow_then_releases() public {
        uint256 id = payAs(alicePk, kUSD, tuktuk, 5_00, "req-1");
        assertEq(kUSD.balanceOf(alice), 95_00);
        assertEq(kUSD.balanceOf(address(kUSD)), 5_00);
        assertEq(kUSD.balanceOf(tuktuk), 0);

        NokorMoney.Payment memory p = kUSD.paymentInfo(id);
        assertEq(uint8(p.status), uint8(NokorMoney.Status.Escrowed));
        assertEq(p.releaseAt, block.timestamp + DISPUTE_WINDOW);

        vm.expectRevert(abi.encodeWithSelector(NokorMoney.NotYetReleasable.selector, id, p.releaseAt));
        kUSD.release(id);

        vm.warp(p.releaseAt);
        kUSD.release(id); // anyone may call
        assertEq(kUSD.balanceOf(tuktuk), 5_00);
    }

    function test_new_merchant_waits_longer() public {
        uint256 id = payAs(alicePk, kUSD, restaurant, 20_00, "req-2");
        assertEq(kUSD.paymentInfo(id).releaseAt, block.timestamp + DISPUTE_WINDOW + 2 days);
    }

    function test_payment_ref_cannot_be_reused() public {
        payAs(alicePk, kUSD, tuktuk, 1_00, "req-1");
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = signPay(alicePk, kUSD, tuktuk, 1_00, "req-1", deadline);
        vm.expectRevert(abi.encodeWithSelector(NokorMoney.RefUsed.selector, bytes32("req-1")));
        kUSD.payWithSig(alice, tuktuk, 1_00, "req-1", deadline, sig);
    }

    function test_signature_must_match_terms() public {
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = signPay(alicePk, kUSD, tuktuk, 1_00, "req-9", deadline);
        // A relayer cannot change the amount (the riel/dollar substitution attack).
        vm.expectRevert(NokorMoney.BadSignature.selector);
        kUSD.payWithSig(alice, tuktuk, 72_00, "req-9", deadline, sig);
        // Nor redirect it to another merchant.
        vm.expectRevert(NokorMoney.BadSignature.selector);
        kUSD.payWithSig(alice, restaurant, 1_00, "req-9", deadline, sig);
        // Nor submit it late.
        vm.warp(deadline + 1);
        vm.expectRevert(NokorMoney.Expired.selector);
        kUSD.payWithSig(alice, tuktuk, 1_00, "req-9", deadline, sig);
    }

    function test_only_registered_merchants_receive_payments() public {
        address stranger = makeAddr("stranger");
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = signPay(alicePk, kUSD, stranger, 1_00, "req-x", deadline);
        vm.expectRevert(abi.encodeWithSelector(NokorMoney.NotMerchant.selector, stranger));
        kUSD.payWithSig(alice, stranger, 1_00, "req-x", deadline, sig);
    }

    // ------------------------------------------------------------------ disputes

    function test_dispute_and_refund() public {
        uint256 id = payAs(alicePk, kUSD, tuktuk, 72_00, "overcharge");
        vm.prank(alice);
        kUSD.dispute(id);
        assertEq(uint8(kUSD.paymentInfo(id).status), uint8(NokorMoney.Status.Disputed));

        // A disputed payment never releases on its own.
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(abi.encodeWithSelector(NokorMoney.WrongStatus.selector, id, NokorMoney.Status.Disputed));
        kUSD.release(id);

        vm.prank(operator);
        kUSD.resolve(id, true);
        assertEq(kUSD.balanceOf(alice), 100_00);
        assertEq(kUSD.balanceOf(tuktuk), 0);
    }

    function test_dispute_with_signature() public {
        uint256 id = payAs(alicePk, kUSD, tuktuk, 5_00, "r");
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 h = keccak256(
            abi.encode(
                keccak256("Dispute(address payer,uint256 paymentId,uint256 nonce,uint256 deadline)"),
                alice,
                id,
                kUSD.nonces(alice),
                deadline
            )
        );
        bytes memory sig = sign(alicePk, kUSD.domainSeparator(), h);
        kUSD.disputeWithSig(alice, id, deadline, sig);
        assertEq(uint8(kUSD.paymentInfo(id).status), uint8(NokorMoney.Status.Disputed));
    }

    function test_dispute_window_closes() public {
        uint256 id = payAs(alicePk, kUSD, tuktuk, 5_00, "r");
        vm.warp(block.timestamp + DISPUTE_WINDOW + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NokorMoney.WindowClosed.selector, id));
        kUSD.dispute(id);
    }

    function test_only_payer_disputes() public {
        uint256 id = payAs(alicePk, kUSD, tuktuk, 5_00, "r");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(NokorMoney.NotPayer.selector, id));
        kUSD.dispute(id);
    }

    function test_refund_reaches_departed_visitor() public {
        uint256 id = payAs(alicePk, kUSD, tuktuk, 10_00, "r");
        vm.prank(alice);
        kUSD.dispute(id);
        uint256 alicePass = pass.passOf(alice);
        vm.prank(issuer);
        pass.close(alicePass); // alice leaves before the decision
        vm.prank(operator);
        kUSD.resolve(id, true);
        assertEq(kUSD.balanceOf(alice), 100_00);
        vm.prank(alice);
        kUSD.redeem(100_00, "card-refund"); // converted back to her card
        assertEq(kUSD.balanceOf(alice), 0);
    }

    function test_operator_claws_back_escrowed_fraud() public {
        uint256 id = payAs(alicePk, kUSD, restaurant, 50_00, "fraud");
        vm.prank(operator);
        kUSD.resolve(id, true);
        assertEq(kUSD.balanceOf(alice), 100_00);
    }

    // ------------------------------------------------------------------ the loop

    function test_merchants_cannot_transfer_only_cash_out() public {
        uint256 id = payAs(alicePk, kUSD, tuktuk, 5_00, "r");
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        kUSD.release(id);
        vm.prank(tuktuk);
        vm.expectRevert(abi.encodeWithSelector(NokorMoney.NotParticipant.selector, tuktuk));
        kUSD.transfer(bob, 1_00);
        vm.prank(tuktuk);
        kUSD.cashOut(5_00, "bakong:123");
        assertEq(kUSD.balanceOf(tuktuk), 0);
        assertEq(kUSD.totalSupply(), 95_00);
    }

    function test_merchant_cannot_redeem_around_the_cap() public {
        uint256 id = payAs(alicePk, kUSD, tuktuk, 5_00, "r");
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        kUSD.release(id);
        vm.prank(tuktuk);
        vm.expectRevert(abi.encodeWithSelector(NokorMoney.NotParticipant.selector, tuktuk));
        kUSD.redeem(5_00, "payout");
    }

    function test_merchant_with_a_pass_still_cannot_transfer() public {
        uint256 id = payAs(alicePk, kUSD, tuktuk, 5_00, "r");
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        kUSD.release(id);
        vm.prank(issuer);
        pass.issue(tuktuk, NokorPass.Category.Resident, keccak256("driver-id"), 0);
        vm.prank(tuktuk);
        vm.expectRevert(abi.encodeWithSelector(NokorMoney.NotParticipant.selector, tuktuk));
        kUSD.transfer(bob, 1_00);
    }

    function test_direct_transfer_to_merchant_is_blocked() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NokorMoney.NotParticipant.selector, tuktuk));
        kUSD.transfer(tuktuk, 1_00);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NokorMoney.NotParticipant.selector, address(kUSD)));
        kUSD.transfer(address(kUSD), 1_00);
    }

    function test_holders_can_send_to_each_other() public {
        vm.prank(alice);
        kUSD.transfer(bob, 10_00);
        assertEq(kUSD.balanceOf(bob), 10_00);
    }

    function test_cash_out_cap_for_new_merchants() public {
        topUp(kUSD, bob, 1000_00);
        uint256 id = payAs(bobPk, kUSD, restaurant, 800_00, "big");
        vm.warp(block.timestamp + DISPUTE_WINDOW + 2 days);
        kUSD.release(id);
        vm.startPrank(restaurant);
        kUSD.cashOut(500_00, "b1");
        vm.expectRevert(abi.encodeWithSelector(NokorMoney.CashOutCapExceeded.selector, 300_00, 0));
        kUSD.cashOut(300_00, "b2");
        vm.warp(block.timestamp + 1 days);
        kUSD.cashOut(300_00, "b2");
        vm.stopPrank();
    }

    function test_frozen_account_cannot_move() public {
        vm.prank(operator);
        kUSD.setFrozen(alice, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NokorMoney.AccountFrozen.selector, alice));
        kUSD.transfer(bob, 1_00);
    }

    function test_redeem_with_signature_at_departure() public {
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 h = keccak256(
            abi.encode(
                keccak256("Redeem(address holder,uint256 amount,bytes32 payoutRef,uint256 nonce,uint256 deadline)"),
                alice,
                uint256(40_00),
                bytes32("airport-cash"),
                kUSD.nonces(alice),
                deadline
            )
        );
        bytes memory sig = sign(alicePk, kUSD.domainSeparator(), h);
        kUSD.redeemWithSig(alice, 40_00, "airport-cash", deadline, sig);
        assertEq(kUSD.balanceOf(alice), 60_00);
    }

    function test_kriel_has_no_decimals() public view {
        assertEq(kRIEL.decimals(), 0);
        assertEq(kUSD.decimals(), 2);
    }

    function test_cash_out_with_merchant_signature() public {
        uint256 tuktukPk = 0x7070;
        address driver = vm.addr(tuktukPk);
        vm.prank(operator);
        registry.register(driver, "tuktuk", "phnom-penh", NokorRegistry.RiskClass.Standard);
        uint256 id = payAs(alicePk, kUSD, driver, 7_00, "fare");
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        kUSD.release(id);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 h = keccak256(
            abi.encode(
                keccak256("CashOut(address merchant,uint256 amount,bytes32 bankRef,uint256 nonce,uint256 deadline)"),
                driver,
                uint256(7_00),
                bytes32("bakong:aba-001"),
                kUSD.nonces(driver),
                deadline
            )
        );
        bytes memory sig = sign(tuktukPk, kUSD.domainSeparator(), h);
        vm.prank(operator);
        kUSD.cashOutWithSig(driver, 7_00, "bakong:aba-001", deadline, sig);
        assertEq(kUSD.balanceOf(driver), 0);
    }
}
