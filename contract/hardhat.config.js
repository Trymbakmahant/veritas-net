require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

const ZG_GALILEO_RPC_URL =
  process.env.ZG_GALILEO_RPC_URL || "https://evmrpc-testnet.0g.ai";
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || "";
const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "";

const networks = {
  // 0G Galileo testnet (primary deployment target).
  zgGalileo: {
    url: ZG_GALILEO_RPC_URL,
    chainId: 16602,
    accounts,
  },
};
if (SEPOLIA_RPC_URL) {
  networks.sepolia = { url: SEPOLIA_RPC_URL, accounts };
}
if (BASE_SEPOLIA_RPC_URL) {
  networks.baseSepolia = { url: BASE_SEPOLIA_RPC_URL, accounts };
}

/** @type {import("hardhat/config").HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks,
  etherscan: {
    // 0G chain explorer is not Etherscan-style yet; harmless placeholder.
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
};
