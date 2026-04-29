// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOracleINFT {
    /// @notice Bump the reputation of an oracle iNFT after a claim resolves.
    /// @dev    Only callable by the configured VeritasOracle resolver contract.
    function bumpReputation(uint256 tokenId, int256 delta, uint256 claimId) external;

    /// @notice Read the live reputation score for a token.
    function reputationOf(uint256 tokenId) external view returns (int256);

    /// @notice Royalty splits table for a token.
    function splitsOf(uint256 tokenId)
        external
        view
        returns (address[] memory recipients, uint16[] memory bps);
}
