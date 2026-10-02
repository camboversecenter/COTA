// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Base} from "./Base.t.sol";
import {NokorPass} from "../src/NokorPass.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract NokorPassTest is Base {
    function test_issue_visitor() public {
        uint256 id = issueVisitor(alice, ALICE_DOC);
        assertEq(id, 1);
        assertEq(pass.ownerOf(id), alice);
        assertTrue(pass.hasValidPass(alice));
        NokorPass.Pass memory p = pass.passInfo(id);
        assertEq(uint8(p.category), uint8(NokorPass.Category.Visitor));
        assertEq(p.docHash, ALICE_DOC);
        assertEq(p.previousPassId, 0);
        assertEq(p.issuer, issuer);
    }

    function test_only_issuer_can_issue() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, pass.ISSUER_ROLE())
        );
        vm.prank(alice);
        pass.issue(alice, NokorPass.Category.Visitor, ALICE_DOC, 0);
    }

    function test_soulbound() public {
        uint256 id = issueVisitor(alice, ALICE_DOC);
        vm.prank(alice);
        vm.expectRevert(NokorPass.Soulbound.selector);
        pass.transferFrom(alice, bob, id);
        vm.expectRevert(NokorPass.Soulbound.selector);
        pass.approve(bob, id);
        vm.expectRevert(NokorPass.Soulbound.selector);
        pass.setApprovalForAll(bob, true);
    }

    function test_rejects_empty_doc_and_category() public {
        vm.startPrank(issuer);
        vm.expectRevert(NokorPass.EmptyDocHash.selector);
        pass.issue(alice, NokorPass.Category.Visitor, bytes32(0), 0);
        vm.expectRevert(NokorPass.InvalidCategory.selector);
        pass.issue(alice, NokorPass.Category.None, ALICE_DOC, 0);
        vm.stopPrank();
    }

    function test_one_valid_pass_per_holder() public {
        uint256 id = issueVisitor(alice, ALICE_DOC);
        vm.expectRevert(abi.encodeWithSelector(NokorPass.HolderHasValidPass.selector, alice, id));
        vm.prank(issuer);
        pass.issue(alice, NokorPass.Category.Visitor, BOB_DOC, 0);
    }

    function test_returning_visitor_is_linked_not_identified() public {
        uint256 first = issueVisitor(alice, ALICE_DOC);
        vm.prank(issuer);
        pass.close(first); // departure
        assertFalse(pass.hasValidPass(alice));

        vm.warp(block.timestamp + 365 days);
        // returns a year later with a new phone
        address aliceNewPhone = makeAddr("alice-new-phone");
        uint256 second = issueVisitor(aliceNewPhone, ALICE_DOC);
        assertEq(pass.passInfo(second).previousPassId, first);
        assertTrue(pass.samePerson(first, second));

        uint256 bobs = issueVisitor(bob, BOB_DOC);
        assertFalse(pass.samePerson(first, bobs));
    }

    function test_new_pass_closes_open_pass_for_same_document() public {
        uint256 first = issueVisitor(alice, ALICE_DOC);
        address aliceNewPhone = makeAddr("alice-new-phone");
        uint256 second = issueVisitor(aliceNewPhone, ALICE_DOC);
        assertFalse(pass.isValid(first));
        assertTrue(pass.isValid(second));
    }

    function test_expiry_and_revocation() public {
        uint256 id = issueVisitor(alice, ALICE_DOC);
        vm.warp(block.timestamp + 31 days);
        assertFalse(pass.isValid(id));

        uint256 res = issueResident(carol, CAROL_DOC);
        vm.warp(block.timestamp + 3650 days);
        assertTrue(pass.isValid(res)); // residents do not expire
        vm.prank(issuer);
        pass.revoke(res);
        assertFalse(pass.isValid(res));
    }

    function test_close_twice_reverts() public {
        uint256 id = issueVisitor(alice, ALICE_DOC);
        vm.startPrank(issuer);
        pass.close(id);
        vm.expectRevert(abi.encodeWithSelector(NokorPass.PassNotOpen.selector, id));
        pass.close(id);
        vm.stopPrank();
    }
}
