// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IVeritasConsumer
/// @notice Optional callback for contracts (prediction markets, escrows, automation
///         keepers) that want to be notified when their submitted claim resolves.
///
///         The callback is **best-effort**: the resolver wraps the call in
///         `try/catch` so a buggy consumer cannot block resolution. Consumers
///         should keep `onClaimResolved` cheap and side-effect-light; for
///         heavier work, do the read in a separate tx by querying
///         `VeritasOracle.claims(claimId)`.
interface IVeritasConsumer {
    /// @param claimId   The claim id assigned by VeritasOracle.
    /// @param outcome   Final outcome enum (matches VeritasOracle.Outcome order):
    ///                  0=NO, 1=YES, 2=INVALID, 3=ESCALATE.
    /// @param proofUri  0G content URI for the ProofBundle.
    function onClaimResolved(uint256 claimId, uint8 outcome, string calldata proofUri) external;
}
