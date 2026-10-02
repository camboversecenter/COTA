// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title Nokor Pass
/// @notice One soulbound pass per holder: the identity credential of the Nokor Pass
///         system. No personal data is stored. A pass carries only its category,
///         issuer, validity and a keyed hash of the holder's document number, which
///         the issuer computes off-chain with a secret only it holds (SPEC §3).
/// @dev    A visitor receives a new pass on each arrival; passes issued against the
///         same document hash are linked through `previousPassId`, which is how a
///         returning visitor is recognised without being identified.
contract NokorPass is ERC721, AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    enum Category {
        None,
        Visitor,
        Resident
    }

    struct Pass {
        Category category;
        address issuer;
        uint64 issuedAt;
        uint64 validUntil; // 0 = no expiry (residents)
        uint64 closedAt; // set at departure or when superseded
        bool revoked;
        bytes32 docHash; // keyed hash of the document number, never the number
        uint256 previousPassId; // earlier pass with the same docHash, or 0
    }

    uint256 public nextPassId = 1;
    mapping(uint256 => Pass) private _passes;
    /// @notice The most recently issued pass held by an address.
    mapping(address => uint256) public passOf;
    /// @notice The most recently issued pass for a document hash.
    mapping(bytes32 => uint256) public latestPassOfDoc;

    event PassIssued(
        uint256 indexed passId,
        address indexed holder,
        Category category,
        bytes32 indexed docHash,
        uint256 previousPassId,
        uint64 validUntil
    );
    event PassClosed(uint256 indexed passId, uint64 closedAt);
    event PassRevoked(uint256 indexed passId);

    error Soulbound();
    error InvalidCategory();
    error EmptyDocHash();
    error HolderHasValidPass(address holder, uint256 passId);
    error UnknownPass(uint256 passId);
    error PassNotOpen(uint256 passId);

    constructor(address admin) ERC721("Nokor Pass", "NOKOR") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ issuing

    /// @notice Issue a pass. Called by immigration (visitors) or the Ministry of
    ///         Interior (residents). Any still-open pass for the same document is
    ///         closed, so one person holds at most one open pass.
    function issue(address holder, Category category, bytes32 docHash, uint64 validUntil)
        external
        onlyRole(ISSUER_ROLE)
        returns (uint256 passId)
    {
        if (category == Category.None) revert InvalidCategory();
        if (docHash == bytes32(0)) revert EmptyDocHash();
        uint256 current = passOf[holder];
        if (current != 0 && isValid(current)) revert HolderHasValidPass(holder, current);

        uint256 previous = latestPassOfDoc[docHash];
        if (previous != 0 && _passes[previous].closedAt == 0) {
            _passes[previous].closedAt = uint64(block.timestamp);
            emit PassClosed(previous, uint64(block.timestamp));
        }

        passId = nextPassId++;
        _passes[passId] = Pass({
            category: category,
            issuer: msg.sender,
            issuedAt: uint64(block.timestamp),
            validUntil: validUntil,
            closedAt: 0,
            revoked: false,
            docHash: docHash,
            previousPassId: previous
        });
        latestPassOfDoc[docHash] = passId;
        passOf[holder] = passId;
        _mint(holder, passId);
        emit PassIssued(passId, holder, category, docHash, previous, validUntil);
    }

    /// @notice Close a pass, for example when a visitor departs. The pass remains as
    ///         the record of the trip.
    function close(uint256 passId) external onlyRole(ISSUER_ROLE) {
        Pass storage p = _existing(passId);
        if (p.closedAt != 0 || p.revoked) revert PassNotOpen(passId);
        p.closedAt = uint64(block.timestamp);
        emit PassClosed(passId, uint64(block.timestamp));
    }

    /// @notice Revoke a pass issued in error or fraudulently.
    function revoke(uint256 passId) external onlyRole(ISSUER_ROLE) {
        Pass storage p = _existing(passId);
        p.revoked = true;
        emit PassRevoked(passId);
    }

    // ------------------------------------------------------------------ views

    function isValid(uint256 passId) public view returns (bool) {
        Pass storage p = _passes[passId];
        if (p.category == Category.None || p.revoked || p.closedAt != 0) return false;
        return p.validUntil == 0 || block.timestamp <= p.validUntil;
    }

    function hasValidPass(address holder) public view returns (bool) {
        uint256 id = passOf[holder];
        return id != 0 && isValid(id);
    }

    /// @notice The open pass of a holder, or 0.
    function validPassOf(address holder) external view returns (uint256) {
        uint256 id = passOf[holder];
        return id != 0 && isValid(id) ? id : 0;
    }

    function passInfo(uint256 passId) external view returns (Pass memory) {
        return _passes[passId];
    }

    /// @notice True when two passes were issued against the same document, i.e.
    ///         belong to the same person. Reveals nothing about who that is.
    function samePerson(uint256 a, uint256 b) external view returns (bool) {
        bytes32 ha = _passes[a].docHash;
        return ha != bytes32(0) && ha == _passes[b].docHash;
    }

    // ------------------------------------------------------------------ soulbound

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function approve(address, uint256) public pure override {
        revert Soulbound();
    }

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _existing(uint256 passId) private view returns (Pass storage p) {
        p = _passes[passId];
        if (p.category == Category.None) revert UnknownPass(passId);
    }
}
