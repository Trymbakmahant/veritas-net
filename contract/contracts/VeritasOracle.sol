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
        /// @notice Address that opened a dispute (0 if none).
        address disputer;
        /// @notice Bond escrowed by the disputer; refunded if reResolve flips the outcome.
        uint96 disputeBondLocked;
        /// @notice Block timestamp of the most recent ClaimDisputed event (0 if never).
        uint64 disputedAt;
    }

    uint256 public nextClaimId = 1;
    address public resolver;
    address public owner;

    /// @notice Required deposit (wei) to open a dispute. 0 disables disputing.
    uint256 public disputeBond;

    /// @notice Number of seconds after `resolvedAt` during which `disputeClaim` accepts challenges.
    uint64 public disputeWindow;

    /// @notice Forfeited bonds (disputes that did not flip the outcome) accumulate here
    ///         until the owner sweeps them.
    uint256 public forfeitedBonds;

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

    /// @notice Fired when someone opens a dispute on an already-resolved claim.
    event ClaimDisputed(uint256 indexed claimId, address indexed disputer, uint256 bond, uint64 disputedAt);

    /// @notice Fired when the resolver re-resolves a disputed claim. `flipped` is true
    ///         when the outcome changed; bond refund happens in the same tx.
    event ClaimReResolved(
        uint256 indexed claimId,
        Outcome outcome,
        string proofUri,
        bool flipped,
        uint256 bondRefunded,
        uint256[] participants
    );

    event ResolverUpdated(address indexed resolver);
    event INFTUpdated(address indexed inft);
    event DisputeParamsUpdated(uint256 disputeBond, uint64 disputeWindow);
    event ForfeitedBondsSwept(address indexed to, uint256 amount);

    error NotResolver();
    error NotOwner();
    error AlreadyResolved();
    error TooEarly();
    error UnknownClaim();
    error NotResolvedYet();
    error AlreadyDisputed();
    error DisputesDisabled();
    error WindowClosed();
    error InsufficientBond();
    error NotDisputed();
    error TransferFailed();

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

    function setDisputeParams(uint256 _bond, uint64 _windowSeconds) external onlyOwner {
        disputeBond = _bond;
        disputeWindow = _windowSeconds;
        emit DisputeParamsUpdated(_bond, _windowSeconds);
    }

    function sweepForfeitedBonds(address payable to) external onlyOwner {
        uint256 amount = forfeitedBonds;
        if (amount == 0) return;
        forfeitedBonds = 0;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit ForfeitedBondsSwept(to, amount);
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
            consumer: consumer,
            disputer: address(0),
            disputeBondLocked: 0,
            disputedAt: 0
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

        _bumpAll(participants, agreed, claimId);

        emit ClaimResolved(claimId, outcome, c.resolvedAt, proofUri, participants);
        _fireConsumer(c.consumer, claimId, uint8(outcome), proofUri);
    }

    function getParticipants(uint256 claimId) external view returns (uint256[] memory) {
        return claimParticipants[claimId];
    }

    // ---- Dispute window ----------------------------------------------------
    //
    // After a claim is resolved, anyone can challenge the outcome by posting
    // `disputeBond` within `disputeWindow` seconds. The resolver may then run a
    // re-evaluation (typically with stricter thresholds / a wider swarm) and
    // call `reResolve`. If the outcome flips, the disputer's bond is refunded;
    // otherwise it is forfeited to the contract treasury (`forfeitedBonds`).
    //
    // We don't enforce "at most one dispute per claim" — once a claim is
    // disputed the resolver MUST call `reResolve` to clear the disputed flag
    // before another challenge can be opened.

    function disputeClaim(uint256 claimId) external payable {
        if (disputeWindow == 0 || disputeBond == 0) revert DisputesDisabled();
        Claim storage c = claims[claimId];
        if (c.requester == address(0)) revert UnknownClaim();
        if (c.resolvedAt == 0) revert NotResolvedYet();
        if (c.disputer != address(0)) revert AlreadyDisputed();
        if (block.timestamp > uint256(c.resolvedAt) + disputeWindow) revert WindowClosed();
        if (msg.value < disputeBond) revert InsufficientBond();

        c.disputer = msg.sender;
        c.disputeBondLocked = uint96(msg.value);
        c.disputedAt = uint64(block.timestamp);
        emit ClaimDisputed(claimId, msg.sender, msg.value, c.disputedAt);
    }

    /// @notice Resolver re-evaluates a disputed claim. If outcome differs from the
    ///         previously recorded outcome, the disputer's bond is refunded.
    function reResolve(
        uint256 claimId,
        Outcome outcome,
        string calldata proofUri,
        uint256[] calldata participants,
        bool[] calldata agreed
    ) external {
        if (msg.sender != resolver) revert NotResolver();
        Claim storage c = claims[claimId];
        if (c.requester == address(0)) revert UnknownClaim();
        if (c.disputer == address(0)) revert NotDisputed();

        bool flipped = outcome != c.outcome;
        c.outcome = outcome;
        c.proofUri = proofUri;
        c.resolvedAt = uint64(block.timestamp);
        claimParticipants[claimId] = participants;

        _bumpAll(participants, agreed, claimId);
        uint256 refunded = _settleBond(c, flipped);

        emit ClaimReResolved(claimId, outcome, proofUri, flipped, refunded, participants);
        emit ClaimResolved(claimId, outcome, c.resolvedAt, proofUri, participants);

        _fireConsumer(c.consumer, claimId, uint8(outcome), proofUri);
    }

    function _bumpAll(uint256[] calldata participants, bool[] calldata agreed, uint256 claimId) internal {
        if (address(inft) == address(0) || participants.length != agreed.length) return;
        for (uint256 i = 0; i < participants.length; i++) {
            int256 delta = agreed[i] ? int256(10) : int256(-5);
            try inft.bumpReputation(participants[i], delta, claimId) {} catch {}
        }
    }

    function _settleBond(Claim storage c, bool flipped) internal returns (uint256 refunded) {
        uint256 bond = c.disputeBondLocked;
        address disputer = c.disputer;
        c.disputer = address(0);
        c.disputeBondLocked = 0;
        c.disputedAt = 0;
        if (bond == 0) return 0;
        if (flipped) {
            refunded = bond;
            (bool ok, ) = payable(disputer).call{value: bond}("");
            if (!ok) revert TransferFailed();
        } else {
            forfeitedBonds += bond;
        }
    }

    function _fireConsumer(address consumer, uint256 claimId, uint8 outcomeCode, string memory proofUri) internal {
        if (consumer == address(0)) return;
        (bool ok, bytes memory ret) = consumer.call{gas: 300_000}(
            abi.encodeCall(IVeritasConsumer.onClaimResolved, (claimId, outcomeCode, proofUri))
        );
        emit ConsumerNotified(claimId, consumer, ok, ret);
    }

    receive() external payable {}
}
