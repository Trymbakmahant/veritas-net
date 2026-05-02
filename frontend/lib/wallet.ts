"use client";

import { BrowserProvider, Contract, getBytes, hexlify, toUtf8Bytes } from "ethers";

declare global {
  interface Window { ethereum?: any }
}

export const INFT_ABI = [
  "function registrationFee() view returns (uint256)",
  "function registerOracle(string ens,string manifestUri,bytes32 manifestHash,bytes capabilities,address[] recipients,uint16[] bps) payable returns (uint256)",
  "function tokenIdByEnsHash(bytes32) view returns (uint256)",
  "event Registered(uint256 indexed tokenId,address indexed owner,string ens,string manifestUri,bytes32 manifestHash)",
];

export type RegisterArgs = {
  inftAddress: string;
  ens: string;
  manifestUri: string;
  manifestHash: `0x${string}`;
  capabilities: string[];
};

/** Connect MetaMask, ensure correct chainId, return a signer. */
export async function connect(opts: { chainId: number; chainName: string; rpcUrl: string; explorerUrl?: string }) {
  if (typeof window === "undefined" || !window.ethereum) {
    throw new Error("MetaMask not detected. Install it or open this page in a wallet browser.");
  }
  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== opts.chainId) {
    const hex = "0x" + opts.chainId.toString(16);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e: any) {
      if (e?.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: hex,
            chainName: opts.chainName,
            rpcUrls: [opts.rpcUrl],
            nativeCurrency: { name: "OG", symbol: "OG", decimals: 18 },
            blockExplorerUrls: opts.explorerUrl ? [opts.explorerUrl] : [],
          }],
        });
      } else {
        throw e;
      }
    }
  }
  const signer = await provider.getSigner();
  return { provider, signer, address: await signer.getAddress() };
}

export async function registerOnChain(args: RegisterArgs) {
  if (typeof window === "undefined" || !window.ethereum) throw new Error("MetaMask not detected");
  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  const inft = new Contract(args.inftAddress, INFT_ABI, signer);
  const fee: bigint = await inft.registrationFee();
  const capsPacked = hexlify(toUtf8Bytes(args.capabilities.join(",")));

  const tx = await inft.registerOracle(
    args.ens,
    args.manifestUri,
    args.manifestHash,
    capsPacked,
    [],
    [],
    { value: fee },
  );
  const rcpt = await tx.wait();
  let tokenId: bigint | undefined;
  for (const log of rcpt?.logs ?? []) {
    try {
      const parsed = inft.interface.parseLog(log);
      if (parsed?.name === "Registered") {
        tokenId = parsed.args[0] as bigint;
        break;
      }
    } catch { /* not our log */ }
  }
  return { txHash: tx.hash as `0x${string}`, tokenId };
}

/** Stable signer-address helper used for the manifest signer field default. */
export async function whoami(): Promise<string | null> {
  if (typeof window === "undefined" || !window.ethereum) return null;
  try {
    const provider = new BrowserProvider(window.ethereum);
    const accounts: string[] = await provider.send("eth_accounts", []);
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}

/** Convenience: useful for evidence dumps. */
export const _bytes = getBytes;
