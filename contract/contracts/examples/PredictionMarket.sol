// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVeritasConsumer} from "../interfaces/IVeritasConsumer.sol";

/// @notice Minimal `VeritasOracle` interface used by this example market.
interface IVeritasOracleSubmit {
    function submitClaimWithConsumer(
        string calldata text,
        string calldata spec,
        uint64 resolveBy,
        address consumer
    ) external returns (uint256 claimId);
}

/// @title PredictionMarket
/// @notice Example consumer of VeritasOracle. Each market is a binary YES/NO
///         pool: traders stake ETH on either side; once Veritas resolves the
///         underlying claim via `onClaimResolved`, the winning side splits the
///         entire pot pro-rata and the losing side gets nothing.
///
///         Outcome encoding (matches VeritasOracle.Outcome):
///           0 = NO, 1 = YES, 2 = INVALID, 3 = ESCALATE
///         INVALID and ESCALATE -> the market is voided and stakes are refundable
///         via `claimRefund`.
contract PredictionMarket is IVeritasConsumer {
    enum Status { Open, Resolved, Voided }
    enum Side   { NO, YES }

    struct Market {
        uint256 claimId;        // Veritas claim id
        uint64  closesAt;       // last second to place a bet
        uint64  resolveBy;      // Veritas resolveBy
        Status  status;
        uint8   outcome;        // copied from VeritasOracle on callback
        string  proofUri;       // 0G content URI of the ProofBundle
        uint256 stakeYes;
        uint256 stakeNo;
    }

    address public immutable veritas;

    uint256 public nextMarketId = 1;

    mapping(uint256 => Market) public markets;
    /// @notice marketId => trader => (yesStake, noStake)
    mapping(uint256 => mapping(address => uint256[2])) public stakes;
    /// @notice marketId => trader => already paid?
    mapping(uint256 => mapping(address => bool)) public paid;

    event MarketCreated(uint256 indexed marketId, uint256 indexed claimId, uint64 closesAt, uint64 resolveBy, string text);
    event Bet(uint256 indexed marketId, address indexed trader, Side side, uint256 amount);
    event MarketResolved(uint256 indexed marketId, uint8 outcome, string proofUri);
    event MarketVoided(uint256 indexed marketId, uint8 outcome);
    event Paid(uint256 indexed marketId, address indexed trader, uint256 amount);

    error NotVeritas();
    error MarketClosed();
    error MarketNotResolved();
    error AlreadyPaid();
    error NothingToPay();
    error InvalidArgs();

    constructor(address _veritas) {
        veritas = _veritas;
    }

    // ---- Create market -----------------------------------------------------

    function createMarket(
        string calldata text,
        string calldata spec,
        uint64 closesAt,
        uint64 resolveBy
    ) external returns (uint256 marketId) {
        if (closesAt <= block.timestamp || resolveBy < closesAt) revert InvalidArgs();
        uint256 claimId = IVeritasOracleSubmit(veritas)
            .submitClaimWithConsumer(text, spec, resolveBy, address(this));

        marketId = nextMarketId++;
        markets[marketId] = Market({
            claimId: claimId,
            closesAt: closesAt,
            resolveBy: resolveBy,
            status: Status.Open,
            outcome: 0,
            proofUri: "",
            stakeYes: 0,
            stakeNo: 0
        });
        emit MarketCreated(marketId, claimId, closesAt, resolveBy, text);
    }

    // ---- Trading -----------------------------------------------------------

    function bet(uint256 marketId, Side side) external payable {
        Market storage m = markets[marketId];
        if (m.claimId == 0) revert InvalidArgs();
        if (m.status != Status.Open) revert MarketClosed();
        if (block.timestamp >= m.closesAt) revert MarketClosed();
        if (msg.value == 0) revert InvalidArgs();

        if (side == Side.YES) {
            m.stakeYes += msg.value;
            stakes[marketId][msg.sender][1] += msg.value;
        } else {
            m.stakeNo += msg.value;
            stakes[marketId][msg.sender][0] += msg.value;
        }
        emit Bet(marketId, msg.sender, side, msg.value);
    }

    // ---- Veritas callback --------------------------------------------------

    function onClaimResolved(uint256 claimId, uint8 outcome, string calldata proofUri) external {
        if (msg.sender != veritas) revert NotVeritas();

        // Find the market for this claim. (One-to-one in this example.)
        // O(n) scan is fine for an example contract; production should index.
        for (uint256 id = 1; id < nextMarketId; id++) {
            Market storage m = markets[id];
            if (m.claimId == claimId && m.status == Status.Open) {
                m.outcome = outcome;
                m.proofUri = proofUri;
                if (outcome == uint8(0) || outcome == uint8(1)) {
                    m.status = Status.Resolved;
                    emit MarketResolved(id, outcome, proofUri);
                } else {
                    m.status = Status.Voided;
                    emit MarketVoided(id, outcome);
                }
                return;
            }
        }
    }

    // ---- Payouts -----------------------------------------------------------

    /// @notice After resolution, each trader on the winning side claims their pro-rata payout.
    function claimPayout(uint256 marketId) external {
        Market storage m = markets[marketId];
        if (m.status != Status.Resolved) revert MarketNotResolved();
        if (paid[marketId][msg.sender]) revert AlreadyPaid();

        uint256 winningStake = m.outcome == 1 ? stakes[marketId][msg.sender][1] : stakes[marketId][msg.sender][0];
        if (winningStake == 0) revert NothingToPay();

        uint256 winningPool = m.outcome == 1 ? m.stakeYes : m.stakeNo;
        uint256 totalPool   = m.stakeYes + m.stakeNo;
        uint256 amount      = (totalPool * winningStake) / winningPool;

        paid[marketId][msg.sender] = true;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "payout failed");
        emit Paid(marketId, msg.sender, amount);
    }

    /// @notice For voided markets (INVALID / ESCALATE), refund both sides.
    function claimRefund(uint256 marketId) external {
        Market storage m = markets[marketId];
        if (m.status != Status.Voided) revert MarketNotResolved();
        if (paid[marketId][msg.sender]) revert AlreadyPaid();

        uint256 amount = stakes[marketId][msg.sender][0] + stakes[marketId][msg.sender][1];
        if (amount == 0) revert NothingToPay();

        paid[marketId][msg.sender] = true;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "refund failed");
        emit Paid(marketId, msg.sender, amount);
    }

    receive() external payable {}
}
