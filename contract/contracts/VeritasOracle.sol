// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracleINFT} from "./interfaces/IOracleINFT.sol";
import {IVeritasConsumer} from "./interfaces/IVeritasConsumer.sol";

/// @title VeritasOracle
/// @notice Claim registry + resolver. On resolution, bumps reputation of every
///         participating oracle iNFT, fans royalties through the RoyaltyRouter,
///         and (optionally) calls back into a consumer contract so prediction
///         markets / escrows can react in the same tx.
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
        /// @notice Optional consumer contract notified via `IVeritasConsumer.onClaimResolved`.
        ///         Address(0) means "no callback" (legacy submitClaim or off-chain consumer).
        address consumer;
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

    /// @notice Emitted alongside ClaimSubmitted when the requester registered a callback.
    event ConsumerRegistered(uint256 indexed claimId, address indexed consumer);

    event ClaimResolved(
        uint256 indexed claimId,
        Outcome outcome,
        uint64 resolvedAt,
        string proofUri,
        uint256[] participants
    );

    /// @notice Emitted after the optional consumer callback runs (success flag included).
    event ConsumerNotified(uint256 indexed claimId, address indexed consumer, bool ok, bytes returnData);

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

    /// @notice Backwards-compatible submitClaim (no consumer callback).
    function submitClaim(string calldata text, string calldata spec, uint64 resolveBy)
        external
        returns (uint256 claimId)
    {
        return _submitClaim(msg.sender, text, spec, resolveBy, address(0));
    }

    /// @notice Submit a claim and register a consumer contract that will be notified
    ///         (best-effort) when the claim resolves.
    function submitClaimWithConsumer(
        string calldata text,
        string calldata spec,
        uint64 resolveBy,
        address consumer
    ) external returns (uint256 claimId) {
        return _submitClaim(msg.sender, text, spec, resolveBy, consumer);
    }

    function _submitClaim(
        address requester,
        string calldata text,
        string calldata spec,
        uint64 resolveBy,
        address consumer
    ) internal returns (uint256 claimId) {
        claimId = nextClaimId++;
        claims[claimId] = Claim({
            requester: requester,
            resolveBy: resolveBy,
            resolvedAt: 0,
            outcome: Outcome.INVALID,
            text: text,
            spec: spec,
            proofUri: "",
            consumer: consumer
        });

        emit ClaimSubmitted(claimId, requester, resolveBy, text, spec);
        if (consumer != address(0)) emit ConsumerRegistered(claimId, consumer);
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

        // Optional consumer callback. Wrapped in try/catch + bounded gas so a
        // misbehaving consumer can never block oracle resolution / royalty payouts.
        if (c.consumer != address(0)) {
            (bool ok, bytes memory ret) = c.consumer.call{gas: 300_000}(
                abi.encodeCall(IVeritasConsumer.onClaimResolved, (claimId, uint8(outcome), proofUri))
            );
            emit ConsumerNotified(claimId, c.consumer, ok, ret);
        }
    }

    function getParticipants(uint256 claimId) external view returns (uint256[] memory) {
        return claimParticipants[claimId];
    }
}
