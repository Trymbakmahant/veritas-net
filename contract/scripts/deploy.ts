import * as fs from "node:fs";
import * as path from "node:path";
import { ethers } from "hardhat";
import type { Log, LogDescription } from "ethers";

/**
 * Full Veritas deploy:
 *   1. OracleINFT       (ERC-7857-style)
 *   2. VeritasOracle    (claim registry + resolver)
 *   3. RoyaltyRouter    (per-claim fee splitter)
 *   4. Wire VeritasOracle <-> OracleINFT
 *   5. Mint a starter swarm of iNFTs (one per known agent)
 *
 * Outputs `contract/deployments/<network>.json` so the backend can pick up addresses.
 */

type AddressBook = {
  network: string;
  chainId: number;
  deployer: string;
  resolver: string;
  contracts: Record<string, string>;
  oracles: { ens: string; tokenId: number; bundleUri: string }[];
  deployedAtIso: string;
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const resolverEnv = process.env.RESOLVER_ADDRESS;
  const resolver =
    resolverEnv && ethers.isAddress(resolverEnv) ? resolverEnv : deployer.address;

  const { name: netName, chainId } = await deployer.provider!.getNetwork();
  console.log(`\nDeploying to ${netName} (chainId=${chainId.toString()}) as ${deployer.address}`);
  console.log(`Resolver:   ${resolver}\n`);

  // ---- 1. OracleINFT ------------------------------------------------------
  const INFT = await ethers.getContractFactory("OracleINFT");
  const inft = await INFT.deploy("Veritas Oracle iNFT", "VRTS");
  await inft.waitForDeployment();
  const inftAddr = await inft.getAddress();
  console.log(`OracleINFT:     ${inftAddr}`);

  // ---- 2. VeritasOracle ---------------------------------------------------
  const Oracle = await ethers.getContractFactory("VeritasOracle");
  const oracle = await Oracle.deploy(resolver);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log(`VeritasOracle:  ${oracleAddr}`);

  // ---- 3. RoyaltyRouter ---------------------------------------------------
  const Router = await ethers.getContractFactory("RoyaltyRouter");
  const router = await Router.deploy(inftAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log(`RoyaltyRouter:  ${routerAddr}`);

  // ---- 4. Wire ------------------------------------------------------------
  await (await oracle.setINFT(inftAddr)).wait();
  await (await inft.setVeritasOracle(oracleAddr)).wait();
  console.log("Wired VeritasOracle <-> OracleINFT");

  // ---- 5. Mint starter swarm ---------------------------------------------
  const starterSwarm = [
    {
      ens: "github.veritas.eth",
      bundleUri: "0g://placeholder/github-agent-v1",
      capabilities: "github_pr_merged_before",
    },
    {
      ens: "snapshot.veritas.eth",
      bundleUri: "0g://placeholder/snapshot-agent-v1",
      capabilities: "snapshot_proposal_passed",
    },
    {
      ens: "auditor.veritas.eth",
      bundleUri: "0g://placeholder/adversarial-auditor-v1",
      capabilities: "critic",
    },
  ];

  const minted: AddressBook["oracles"] = [];
  for (const o of starterSwarm) {
    const bundleHash = ethers.keccak256(ethers.toUtf8Bytes(o.bundleUri));
    const tx = await inft.mint(
      deployer.address,
      o.ens,
      o.bundleUri,
      bundleHash,
      ethers.toUtf8Bytes(o.capabilities),
      [deployer.address],
      [10_000],
    );
    const rcpt = await tx.wait();
    const ev = rcpt!.logs
      .map((l: Log): LogDescription | null => {
        try {
          return inft.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: LogDescription | null): p is LogDescription => !!p && p.name === "Minted");
    const tokenId = ev ? Number(ev.args[0]) : 0;
    console.log(`  minted #${tokenId}  ${o.ens}`);
    minted.push({ ens: o.ens, tokenId, bundleUri: o.bundleUri });
  }

  // ---- Persist address book ----------------------------------------------
  const out: AddressBook = {
    network: netName,
    chainId: Number(chainId),
    deployer: deployer.address,
    resolver,
    contracts: {
      OracleINFT: inftAddr,
      VeritasOracle: oracleAddr,
      RoyaltyRouter: routerAddr,
    },
    oracles: minted,
    deployedAtIso: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${netName}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log("\nCopy these into backend/.env:");
  console.log(`  VERITAS_ORACLE_ADDRESS=${oracleAddr}`);
  console.log(`  ORACLE_INFT_ADDRESS=${inftAddr}`);
  console.log(`  ROYALTY_ROUTER_ADDRESS=${routerAddr}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
