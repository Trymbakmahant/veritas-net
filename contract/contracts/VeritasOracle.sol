// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracleINFT} from "./interfaces/IOracleINFT.sol";

/// @title VeritasOracle
/// @notice Claim registry + resolver. On resolution, bumps reputation of every
///         participating oracle iNFT and fans royalties through the RoyaltyRouter.
contract VeritasOracle {
    enum Outcome {
        NO,
        YES,
        INVALID,
        ESCALATE
    }

    struct Claim {
        address requester;
        uint64 resolveBy;
        uint64 resolvedAt;
        Outcome outcome;
        string text;
        string spec;
        string proofUri;
    }

    uint256 public nextClaimId = 1;
    address public resolver;
    address public owner;

    /// @notice OracleINFT contract (per-oracle reputation registry).
    IOracleINFT public inft;

    mapping(uint256 => Claim) public claims;

    /// @notice Per-claim list of participating iNFT token ids (set on resolution).
    mapping(uint256 => uint256[]) public claimParticipants;

    event ClaimSubmitted(
        uint256 indexed claimId,
        address indexed requester,
        uint64 resolveBy,
        string text,
        string spec
    );

    event ClaimResolved(
        uint256 indexed claimId,
        Outcome outcome,
        uint64 resolvedAt,
        string proofUri,
        uint256[] participants
    );

    event ResolverUpdated(address indexed resolver);
    event INFTUpdated(address indexed inft);

    error NotResolver();
    error NotOwner();
    error AlreadyResolved();
    error TooEarly();
    error UnknownClaim();

    constructor(address _resolver) {
        owner = msg.sender;
        resolver = _resolver;
        emit ResolverUpdated(_resolver);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setResolver(address _resolver) external onlyOwner {
        resolver = _resolver;
        emit ResolverUpdated(_resolver);
    }

    function setINFT(address _inft) external onlyOwner {
        inft = IOracleINFT(_inft);
        emit INFTUpdated(_inft);
    }

    function transferOwnership(address _newOwner) external onlyOwner {
        owner = _newOwner;
    }

    function submitClaim(string calldata text, string calldata spec, uint64 resolveBy)
        external
        returns (uint256 claimId)
    {
        claimId = nextClaimId++;
        claims[claimId] = Claim({
            requester: msg.sender,
            resolveBy: resolveBy,
            resolvedAt: 0,
            outcome: Outcome.INVALID,
            text: text,
            spec: spec,
            proofUri: ""
        });

        emit ClaimSubmitted(claimId, msg.sender, resolveBy, text, spec);
    }

    /// @notice Resolve a claim with the swarm's outcome.
    /// @param claimId       Claim id.
    /// @param outcome       Final outcome.
    /// @param proofUri      0G content URI for the ProofBundle.
    /// @param participants  Token ids of iNFTs that contributed; reputation bumped.
    /// @param agreed        Per-participant flag of whether the oracle agreed with the final outcome.
    function resolveClaim(
        uint256 claimId,
        Outcome outcome,
        string calldata proofUri,
        uint256[] calldata participants,
        bool[] calldata agreed
    ) external {
        if (msg.sender != resolver) revert NotResolver();

        Claim storage c = claims[claimId];
        if (c.requester == address(0)) revert UnknownClaim();
        if (c.resolvedAt != 0) revert AlreadyResolved();
        if (block.timestamp < c.resolveBy) revert TooEarly();

        c.outcome = outcome;
        c.resolvedAt = uint64(block.timestamp);
        c.proofUri = proofUri;
        claimParticipants[claimId] = participants;

        if (address(inft) != address(0) && participants.length == agreed.length) {
            for (uint256 i = 0; i < participants.length; i++) {
                int256 delta = agreed[i] ? int256(10) : int256(-5);
                try inft.bumpReputation(participants[i], delta, claimId) {} catch {}
            }
        }

        emit ClaimResolved(claimId, outcome, c.resolvedAt, proofUri, participants);
    }

    function getParticipants(uint256 claimId) external view returns (uint256[] memory) {
        return claimParticipants[claimId];
    }
}
