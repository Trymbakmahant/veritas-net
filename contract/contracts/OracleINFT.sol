// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracleINFT} from "./interfaces/IOracleINFT.sol";

/// @title OracleINFT
/// @notice ERC-7857-style intelligent NFT for Veritas oracles.
///         The token IS the agent: identity, encrypted bundle pointer (on 0G Storage),
///         version, reputation, and on-chain royalty splits.
///
///         This is a pragmatic ERC-7857 implementation: it follows the encrypted-pointer
///         pattern (dataHash + sealedURI) but skips the full TEE/ZKP transfer-validity
///         proof system. Ownership transfer triggers a re-key request emitted as an event;
///         an off-chain TEE prover would generate the new sealed key and call
///         `applyTransferProof` (omitted here for hackathon scope).
contract OracleINFT is IOracleINFT {
    // ---- ERC-7857 metadata ---------------------------------------------------

    string public name;
    string public symbol;

    struct IntelligentData {
        string dataDescription;
        bytes32 dataHash;
    }

    /// @notice Per-token metadata blob hashes (ERC-7857 intelligentDataOf shape).
    mapping(uint256 => IntelligentData[]) private _intelligentData;

    // ---- Identity + ownership -----------------------------------------------

    struct Oracle {
        string ens;            // e.g. "conservative.veritas.eth"
        string bundleUri;      // 0G content URI of encrypted skill+policy+memory bundle
        bytes32 bundleHash;    // hash of the (encrypted) bundle
        uint64 version;        // bumped on every upgrade
        bytes capabilities;    // packed list of capability tags (e.g. "github,snapshot")
    }

    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => Oracle)  public oracles;
    mapping(uint256 => int256)  private _reputation;

    /// @notice ENS string -> tokenId, for fast lookups from the coordinator.
    mapping(bytes32 => uint256) public tokenIdByEnsHash;

    // ---- Royalty splits ------------------------------------------------------

    struct Splits {
        address[] recipients;
        uint16[]  bps; // basis points; sum must be 10000
    }
    mapping(uint256 => Splits) private _splits;

    // ---- Permissions ---------------------------------------------------------

    address public deployer;
    address public veritasOracle; // only contract allowed to call bumpReputation

    uint256 public nextTokenId = 1;

    // ---- Events --------------------------------------------------------------

    event Minted(uint256 indexed tokenId, address indexed owner, string ens, string bundleUri, bytes32 bundleHash);
    event Upgraded(uint256 indexed tokenId, uint64 newVersion, string newBundleUri, bytes32 newBundleHash);
    event ReputationBumped(uint256 indexed tokenId, int256 delta, int256 newScore, uint256 indexed claimId);
    event SplitsUpdated(uint256 indexed tokenId);
    event TransferRequested(uint256 indexed tokenId, address indexed from, address indexed to);
    event Transferred(uint256 indexed tokenId, address indexed from, address indexed to);
    event VeritasOracleUpdated(address indexed veritasOracle);

    // ---- Errors --------------------------------------------------------------

    error NotDeployer();
    error NotOwnerOf();
    error NotResolver();
    error EnsTaken();
    error UnknownToken();
    error BadSplits();

    constructor(string memory _name, string memory _symbol) {
        name = _name;
        symbol = _symbol;
        deployer = msg.sender;
    }

    modifier onlyDeployer() {
        if (msg.sender != deployer) revert NotDeployer();
        _;
    }

    function setVeritasOracle(address _v) external onlyDeployer {
        veritasOracle = _v;
        emit VeritasOracleUpdated(_v);
    }

    // ---- Mint / upgrade ------------------------------------------------------

    function mint(
        address to,
        string calldata ens,
        string calldata bundleUri,
        bytes32 bundleHash,
        bytes calldata capabilities,
        address[] calldata recipients,
        uint16[]  calldata bps
    ) external onlyDeployer returns (uint256 tokenId) {
        bytes32 ensHash = keccak256(bytes(ens));
        if (tokenIdByEnsHash[ensHash] != 0) revert EnsTaken();
        _validateSplits(recipients, bps);

        tokenId = nextTokenId++;
        ownerOf[tokenId] = to;
        oracles[tokenId] = Oracle({
            ens: ens,
            bundleUri: bundleUri,
            bundleHash: bundleHash,
            version: 1,
            capabilities: capabilities
        });
        tokenIdByEnsHash[ensHash] = tokenId;

        _intelligentData[tokenId].push(IntelligentData({
            dataDescription: "veritas-oracle-bundle",
            dataHash: bundleHash
        }));

        _splits[tokenId] = Splits({recipients: recipients, bps: bps});

        emit Minted(tokenId, to, ens, bundleUri, bundleHash);
        emit SplitsUpdated(tokenId);
    }

    /// @notice Owner-gated upgrade of the encrypted bundle (skill / policy / memory).
    function upgradeBundle(uint256 tokenId, string calldata newBundleUri, bytes32 newBundleHash) external {
        if (ownerOf[tokenId] != msg.sender) revert NotOwnerOf();
        Oracle storage o = oracles[tokenId];
        o.version += 1;
        o.bundleUri = newBundleUri;
        o.bundleHash = newBundleHash;

        _intelligentData[tokenId].push(IntelligentData({
            dataDescription: "veritas-oracle-bundle",
            dataHash: newBundleHash
        }));

        emit Upgraded(tokenId, o.version, newBundleUri, newBundleHash);
    }

    function setSplits(uint256 tokenId, address[] calldata recipients, uint16[] calldata bps) external {
        if (ownerOf[tokenId] != msg.sender) revert NotOwnerOf();
        _validateSplits(recipients, bps);
        _splits[tokenId] = Splits({recipients: recipients, bps: bps});
        emit SplitsUpdated(tokenId);
    }

    function _validateSplits(address[] calldata recipients, uint16[] calldata bps) internal pure {
        if (recipients.length == 0 || recipients.length != bps.length) revert BadSplits();
        uint256 total;
        for (uint256 i = 0; i < bps.length; i++) total += bps[i];
        if (total != 10_000) revert BadSplits();
    }

    // ---- Transfer (simplified ERC-7857) -------------------------------------
    //
    // Real ERC-7857 requires a TransferValidityProof from a TEE/ZKP prover so the
    // new owner gets a re-encrypted data key. For the hackathon we expose a 2-step
    // transfer that emits TransferRequested; an off-chain prover would call
    // applyTransferProof. We keep the second step lightweight (deployer-attested).

    mapping(uint256 => address) public pendingTo;

    function requestTransfer(uint256 tokenId, address to) external {
        if (ownerOf[tokenId] != msg.sender) revert NotOwnerOf();
        pendingTo[tokenId] = to;
        emit TransferRequested(tokenId, msg.sender, to);
    }

    function applyTransferProof(uint256 tokenId, bytes32 newBundleHash, string calldata newBundleUri) external onlyDeployer {
        address to = pendingTo[tokenId];
        if (to == address(0)) revert UnknownToken();
        address from = ownerOf[tokenId];
        ownerOf[tokenId] = to;
        delete pendingTo[tokenId];

        Oracle storage o = oracles[tokenId];
        o.bundleUri = newBundleUri;
        o.bundleHash = newBundleHash;
        _intelligentData[tokenId].push(IntelligentData({
            dataDescription: "veritas-oracle-bundle",
            dataHash: newBundleHash
        }));

        emit Transferred(tokenId, from, to);
    }

    // ---- Reputation (called by VeritasOracle) -------------------------------

    function bumpReputation(uint256 tokenId, int256 delta, uint256 claimId) external override {
        if (msg.sender != veritasOracle) revert NotResolver();
        if (ownerOf[tokenId] == address(0)) revert UnknownToken();
        _reputation[tokenId] += delta;
        emit ReputationBumped(tokenId, delta, _reputation[tokenId], claimId);
    }

    function reputationOf(uint256 tokenId) external view override returns (int256) {
        return _reputation[tokenId];
    }

    function splitsOf(uint256 tokenId)
        external
        view
        override
        returns (address[] memory recipients, uint16[] memory bps)
    {
        Splits storage s = _splits[tokenId];
        return (s.recipients, s.bps);
    }

    // ---- ERC-7857 metadata views --------------------------------------------

    function intelligentDataOf(uint256 tokenId) external view returns (IntelligentData[] memory) {
        return _intelligentData[tokenId];
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return oracles[tokenId].bundleUri;
    }
}
