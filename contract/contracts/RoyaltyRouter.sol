// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracleINFT} from "./interfaces/IOracleINFT.sol";

/// @title RoyaltyRouter
/// @notice Splits an incoming fee across each participating oracle iNFT's `splits[]`
///         table. Every iNFT distributes its share again across its on-chain recipients
///         (operator / model provider / DAO / referrer).
contract RoyaltyRouter {
    IOracleINFT public immutable inft;

    event Distributed(uint256 indexed claimId, uint256 totalWei, uint256 perOracleWei);
    event PaidOracle(uint256 indexed tokenId, address indexed recipient, uint256 amount);

    error NoOracles();
    error LengthMismatch();
    error PaymentFailed();

    constructor(address _inft) {
        inft = IOracleINFT(_inft);
    }

    /// @notice Distribute msg.value across `tokenIds`, then across each token's splits.
    function distribute(uint256 claimId, uint256[] calldata tokenIds) external payable {
        uint256 n = tokenIds.length;
        if (n == 0) revert NoOracles();
        uint256 perOracle = msg.value / n;

        for (uint256 i = 0; i < n; i++) {
            (address[] memory recipients, uint16[] memory bps) = inft.splitsOf(tokenIds[i]);
            if (recipients.length != bps.length) revert LengthMismatch();

            for (uint256 j = 0; j < recipients.length; j++) {
                uint256 amount = (perOracle * bps[j]) / 10_000;
                if (amount == 0) continue;
                (bool ok, ) = recipients[j].call{value: amount}("");
                if (!ok) revert PaymentFailed();
                emit PaidOracle(tokenIds[i], recipients[j], amount);
            }
        }

        emit Distributed(claimId, msg.value, perOracle);
    }

    receive() external payable {}
}
