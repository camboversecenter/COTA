// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {NokorPoint} from "../src/NokorPoint.sol";

contract NokorPointTest is Base {
    uint256 alicePass;
    uint256 claimKeyPk = 0xC1A1;

    function setUp() public override {
        super.setUp();
        alicePass = issueVisitor(alice, ALICE_DOC);
        vm.prank(operator);
        point.award(alice, 500, "payment:req-1");
    }

    function signGift(uint256 pk, uint256 earnedOnPass, uint256 amount, address claimKey, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        address giver = vm.addr(pk);
        bytes32 h = keccak256(
            abi.encode(
                keccak256(
                    "Gift(address giver,uint256 earnedOnPass,uint256 amount,address claimKey,uint256 nonce,uint256 deadline)"
                ),
                giver,
                earnedOnPass,
                amount,
                claimKey,
                point.nonces(giver),
                deadline
            )
        );
        return sign(pk, point.domainSeparator(), h);
    }

    function signClaim(uint256 giftId, address recipient) internal view returns (bytes memory) {
        bytes32 h = keccak256(abi.encode(keccak256("Claim(uint256 giftId,address recipient)"), giftId, recipient));
        return sign(claimKeyPk, point.domainSeparator(), h);
    }

    function redeem(uint256 pk, uint256 earnedOnPass, uint256 amount, bytes32 offer) internal {
        address holder = vm.addr(pk);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes32 h = keccak256(
            abi.encode(
                keccak256(
                    "RedeemPoints(address holder,uint256 earnedOnPass,uint256 amount,bytes32 offerRef,uint256 nonce,uint256 deadline)"
                ),
                holder,
                earnedOnPass,
                amount,
                offer,
                point.nonces(holder),
                deadline
            )
        );
        bytes memory sig = sign(pk, point.domainSeparator(), h);
        vm.prank(operator);
        point.redeemWithSig(holder, earnedOnPass, amount, offer, deadline, sig);
    }

    function test_points_are_tagged_with_the_pass_they_were_earned_on() public view {
        assertEq(point.balanceOf(alice, alicePass), 500);
    }

    function test_gift_after_departure_then_friend_claims_on_arrival() public {
        // Alice goes home, then gifts 200 points to Bob.
        vm.prank(issuer);
        pass.close(alicePass);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = signGift(alicePk, alicePass, 200, vm.addr(claimKeyPk), deadline);
        uint256 giftId = point.createGiftWithSig(alice, alicePass, 200, vm.addr(claimKeyPk), deadline, sig);
        assertEq(point.balanceOf(alice, alicePass), 300);

        // Bob cannot claim before he has a pass.
        bytes memory claimSig = signClaim(giftId, bob);
        vm.expectRevert(abi.encodeWithSelector(NokorPoint.NoValidPass.selector, bob));
        point.claimGift(giftId, bob, claimSig);

        // Bob arrives, receives his pass, claims.
        uint256 bobPass = issueVisitor(bob, BOB_DOC);
        point.claimGift(giftId, bob, claimSig);
        assertEq(point.balanceOf(bob, alicePass), 200);

        // Bob spends them: a spread, not a return.
        vm.expectEmit(true, true, true, true, address(point));
        emit NokorPoint.PointsRedeemed(bobPass, alicePass, 200, "offer:koh-ker", false, true);
        redeem(bobPk, alicePass, 200, "offer:koh-ker");
    }

    function test_intercepted_claim_cannot_be_redirected() public {
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory sig = signGift(alicePk, alicePass, 100, vm.addr(claimKeyPk), deadline);
        uint256 giftId = point.createGiftWithSig(alice, alicePass, 100, vm.addr(claimKeyPk), deadline, sig);
        issueVisitor(bob, BOB_DOC);
        issueResident(carol, CAROL_DOC);
        bytes memory bobsClaim = signClaim(giftId, bob);
        vm.expectRevert(NokorPoint.BadSignature.selector);
        point.claimGift(giftId, carol, bobsClaim);
        point.claimGift(giftId, bob, bobsClaim);
        vm.expectRevert(abi.encodeWithSelector(NokorPoint.GiftUnavailable.selector, giftId));
        point.claimGift(giftId, bob, bobsClaim);
    }

    function test_returning_visitor_spends_old_points() public {
        vm.prank(issuer);
        pass.close(alicePass);
        vm.warp(block.timestamp + 200 days);
        uint256 secondTrip = issueVisitor(alice, ALICE_DOC);
        assertTrue(secondTrip != alicePass);
        vm.expectEmit(true, true, true, true, address(point));
        emit NokorPoint.PointsRedeemed(secondTrip, alicePass, 100, "offer:angkor", true, false);
        redeem(alicePk, alicePass, 100, "offer:angkor");
    }

    function test_same_trip_redemption_is_neither_return_nor_spread() public {
        vm.expectEmit(true, true, true, true, address(point));
        emit NokorPoint.PointsRedeemed(alicePass, alicePass, 50, "offer:x", false, false);
        redeem(alicePk, alicePass, 50, "offer:x");
    }

    function test_points_expire() public {
        vm.warp(block.timestamp + 3 * 365 days + 1);
        issueVisitor(bob, BOB_DOC);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NokorPoint.PointsExpired.selector, alicePass));
        point.safeTransferFrom(alice, bob, alicePass, 1, "");
    }

    function test_cancel_returns_points_to_giver() public {
        vm.prank(alice);
        uint256 giftId = point.createGift(alicePass, 100, vm.addr(claimKeyPk));
        vm.prank(alice);
        point.cancelGift(giftId);
        assertEq(point.balanceOf(alice, alicePass), 500);
    }

    function test_award_requires_valid_pass() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(NokorPoint.NoValidPass.selector, bob));
        point.award(bob, 10, "x");
    }

    function test_points_cannot_be_sent_into_escrow_directly() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NokorPoint.NoValidPass.selector, address(point)));
        point.safeTransferFrom(alice, address(point), alicePass, 1, "");
    }
}
