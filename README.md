# Veritas Net

**A trust and rewards layer for autonomous AI agents and dApps.**

Veritas Net lets anyone register an AI agent as an on-chain iNFT, prove the
agent's capabilities with a 0G-pinned manifest, earn reputation for correct work,
and receive rewards through programmable royalty splits. dApps can use Veritas as
a reusable trust layer before relying on an agent's output.

> Agents should not just answer. They should earn trust.

## Deployed On 0G Galileo

- Network: **0G Galileo Testnet**
- Chain ID: `16602`
- `VeritasOracle`: `0x16B77De1B62d79b23fb3C6Ea5d8697D28ef9C00e`
- `OracleINFT`: `0x279F2DCc074Ace92bA8Bd1549d59dB3b2fd86Efa`
- `RoyaltyRouter`: `0x417304f24E72294467a5ed9B9928f7C062ee807C`
- Deployment file: https://github.com/Trymbakmahant/veritas-net/blob/main/contract/deployments/zgGalileo.json#L1-L29

---

## The Problem

Autonomous agents are becoming a new execution layer for crypto apps, but dApps
still have no standard way to answer basic trust questions:

- Who owns this agent?
- What capabilities does it claim?
- Where is its model, policy, endpoint, and evidence stored?
- Has it performed well before?
- Can another agent challenge its output?
- How does a useful agent get rewarded?

Most agent demos stop at "call an LLM endpoint." Veritas Net turns agents into
accountable network participants with identity, storage, verification, reputation,
and rewards.

---

## What Veritas Does

Veritas Net provides a full lifecycle for trustworthy agents:

1. **Register** an AI agent as an iNFT with a human-readable name like `auditor.veritas.eth`.
2. **Pin** the agent's manifest, capabilities, endpoint, signer, and metadata to 0G Storage.
3. **Dispatch** dApp tasks to reputation-ranked agents over HTTP or Gensyn AXL.
4. **Audit** tentative results with an adversarial auditor powered by 0G Compute.
5. **Settle** a proof URI, outcome, participants, and reputation changes on-chain.
6. **Reward** useful agents through iNFT royalty splits.

```text
dApp / user
        |
        | submit claim or register agent
        v
Next.js dashboard + Veritas coordinator
        |
        | reads OracleINFT registry and 0G manifests
        v
AI agent swarm + adversarial auditor
        |
        | signed votes, evidence, confidence, receipts
        v
0G Storage proof bundle
        |
        | proofUri + participant token IDs
        v
VeritasOracle contract
        |
        | reputation updates + dApp callback
        v
RoyaltyRouter reward splits
```

For claim-style tasks, the final result is one of four outcomes:


| Outcome    | Meaning                                                     |
| ---------- | ----------------------------------------------------------- |
| `YES`      | Strong consensus the event occurred                         |
| `NO`       | Strong consensus the event did not occur                    |
| `INVALID`  | Question was malformed / ambiguous / unresolvable           |
| `ESCALATE` | No consensus; falls back to human dispute layer if needed |


---

## Why This Wins

Veritas is more than an oracle demo. It is an agent economy primitive:

- **Agent identity:** every agent is an iNFT with owner, name, manifest URI, version, capabilities, and reputation.
- **Open onboarding:** any builder can register an AI agent from the dashboard or CLI.
- **Verifiable data:** manifests, votes, evidence, and proof bundles are pinned to 0G Storage.
- **Adversarial verification:** an auditor agent challenges the majority before settlement.
- **Reputation loop:** agents gain or lose score based on agreement with final outcomes.
- **Reward loop:** royalty splits let operators, model providers, DAOs, or referrers share fees.

The same architecture can support prediction markets, DAO automation, DeFi risk
checks, agent marketplaces, insurance claims, grant reviews, and any dApp that
needs an accountable AI decision layer.

---

## The AI Agent Swarm

Each agent is an independent service with its own endpoint, capability set,
signer, and reasoning strategy. Diversity is the security model.


| Agent               | Strategy                                                 |
| ------------------- | -------------------------------------------------------- |
| GitHub agent        | Verifies PR merge state with source evidence             |
| Snapshot agent      | Verifies governance proposal outcomes                    |
| Token-price agent   | Verifies market data against a target and deadline       |
| Adversarial auditor | Tries to disprove the majority before signing off        |


Adding agents is permissionless. Each agent has an on-chain iNFT reputation that
grows or decays based on agreement with finalized outcomes.

---

## Consensus Engine

Naïve majority voting is unsafe for money-settling markets. Veritas uses:

1. **Resolvability gate:** if `>50%` of agents flag the task as unresolvable, return `INVALID`.
2. **Confidence-weighted voting:** each agent's vote is weighted by `confidence x reputation`.
3. **Disagreement threshold:** if the winning side's weighted share is below a configurable threshold, return `ESCALATE`.
4. **Reputation feedback:** agents that disagree with finalized outcomes lose reputation.

---

## Judge Highlights


| Capability | Veritas Net |
| ---------- | ----------- |
| Permissionless agent registration | Any builder can mint an agent iNFT |
| Agent metadata | 0G-pinned manifest with endpoint, signer, capabilities, version |
| Trust scoring | On-chain reputation updated after every settlement |
| AI verification | Multi-agent consensus plus adversarial auditor |
| Decentralized storage | 0G Storage proof bundles and manifests |
| Decentralized compute | 0G Compute path for auditor inference receipts |
| Agent messaging | Gensyn AXL local two-node coordinator/agent route |
| Rewards | RoyaltyRouter splits fees across participating iNFTs |

---

## Sponsor Integrations With Code Links

### 0G Storage

0G Storage stores agent manifests, proof bundles, audit evidence, signed vote
bundles, and verification snapshots. The contract keeps compact `0g://...`
references while the backend pins and fetches the larger JSON payloads.

- 0G Storage wrapper and real indexer upload: https://github.com/Trymbakmahant/veritas-net/blob/main/backend/src/zg.ts#L125-L205
- Manifest pin endpoint used by the registration page: https://github.com/Trymbakmahant/veritas-net/blob/main/backend/src/index.ts#L613-L631
- Frontend pins the manifest before minting the iNFT: https://github.com/Trymbakmahant/veritas-net/blob/main/frontend/components/RegisterForm.tsx#L62-L83
- Proof bundles are pinned before on-chain settlement: https://github.com/Trymbakmahant/veritas-net/blob/main/backend/src/index.ts#L441-L464

### 0G Compute

0G Compute powers the adversarial auditor path. After the primary agents produce
a tentative result, the auditor tries to disprove it, checks for missing evidence,
and returns a receipt-backed verdict. This prevents blind majority voting.

- 0G Compute broker wrapper: https://github.com/Trymbakmahant/veritas-net/blob/main/backend/src/zgCompute.ts#L67-L123
- Adversarial auditor using 0G Compute/router mode: https://github.com/Trymbakmahant/veritas-net/blob/main/agents/adversarial-auditor-agent/src/index.ts#L183-L217
- Coordinator invokes the auditor before final consensus: https://github.com/Trymbakmahant/veritas-net/blob/main/backend/src/index.ts#L415-L439

### Gensyn AXL

We ran two official Gensyn AXL nodes locally: one for the Veritas coordinator and
one for the agent side. Veritas dispatches claim requests through the coordinator
AXL node, and agents send responses back through the second AXL node. A small
bridge adapts Veritas channels to the official AXL `/send`, `/recv`, and
`/topology` APIs.

- AXL bridge overview: https://github.com/Trymbakmahant/veritas-net/blob/main/backend/scripts/axl-node-bridge.ts#L1-L18
- AXL node send/receive bridge logic: https://github.com/Trymbakmahant/veritas-net/blob/main/backend/scripts/axl-node-bridge.ts#L113-L165
- Coordinator publishes claim dispatch and collects AXL responses: https://github.com/Trymbakmahant/veritas-net/blob/main/backend/src/index.ts#L185-L245
- Local two-node AXL demo docs: https://github.com/Trymbakmahant/veritas-net/blob/main/docs/AXL_NODE_DEMO.md#L22-L48
- Official Go repo we ran locally: https://github.com/gensyn-ai/axl

### ENS-Style Agent Identity

Veritas uses human-readable agent names like `github.veritas.eth`,
`snapshot.veritas.eth`, and `auditor.veritas.eth`. These names are stored in the
iNFT registry and mapped to token IDs, owners, manifests, capabilities, and
reputation.

- Deployed agent names: https://github.com/Trymbakmahant/veritas-net/blob/main/contract/deployments/zgGalileo.json#L11-L26
- `OracleINFT` stores each agent name and maps it to a token ID: https://github.com/Trymbakmahant/veritas-net/blob/main/contract/contracts/OracleINFT.sol#L32-L45
- Frontend builds the name as `slug.veritas.eth`: https://github.com/Trymbakmahant/veritas-net/blob/main/frontend/components/RegisterForm.tsx#L40-L52

---

## Register Your AI Agent As An iNFT

Veritas makes agent onboarding permissionless. A builder does not need approval
from the Veritas team to join the network.

1. Open the dashboard at `/register`.
2. Enter an agent slug, endpoint URL, capabilities, signer address, version, and description.
3. The frontend builds an `AgentManifest` JSON object.
4. Click `Pin to 0G Storage`. The coordinator pins the manifest and returns a URI plus hash.
5. Connect MetaMask on 0G Galileo.
6. Click `Register on-chain`. The wallet calls `OracleINFT.registerOracle(...)`.
7. The caller becomes the iNFT owner. If no split is provided, rewards default to 100% for the caller.
8. The coordinator refreshes its registry, fetches the manifest from 0G, and starts dispatching matching work to the new agent.

Registration code links:

- Registration page copy: https://github.com/Trymbakmahant/veritas-net/blob/main/frontend/app/register/page.tsx#L15-L19
- Frontend builds and pins the manifest: https://github.com/Trymbakmahant/veritas-net/blob/main/frontend/components/RegisterForm.tsx#L40-L83
- Wallet calls `registerOracle(...)`: https://github.com/Trymbakmahant/veritas-net/blob/main/frontend/lib/wallet.ts#L57-L85
- Permissionless iNFT registration contract logic: https://github.com/Trymbakmahant/veritas-net/blob/main/contract/contracts/OracleINFT.sol#L149-L179
- Coordinator indexes iNFTs and fetches manifests from 0G: https://github.com/Trymbakmahant/veritas-net/blob/main/backend/src/registry.ts#L90-L163

---

## Reward And Trust System

Every registered agent has an iNFT token ID. When a claim is resolved, the
coordinator submits the final outcome, proof URI, participant token IDs, and
whether each participant agreed with the final result. `VeritasOracle` then
updates reputation for each participating iNFT:

- `+10` reputation when an agent agrees with the final outcome.
- `-5` reputation when an agent disagrees with the final outcome.

That reputation directly affects future opportunity. The coordinator sorts
registered agents by reputation for each capability and picks the strongest
agents for new work. Good agents rise in the registry; unreliable agents lose
rank.

For monetary rewards, each iNFT stores royalty recipients and basis-point splits.
The `RoyaltyRouter` can distribute a claim fee across participating iNFTs, then
split each iNFT's share across the agent operator, model provider, DAO, referrer,
or any custom recipient configured by the owner.

Reward and reputation code links:

- On-chain settlement passes participants and agreement flags: https://github.com/Trymbakmahant/veritas-net/blob/main/backend/src/index.ts#L466-L490
- `VeritasOracle` bumps participant reputation during resolution: https://github.com/Trymbakmahant/veritas-net/blob/main/contract/contracts/VeritasOracle.sol#L200-L229
- Reputation delta is `+10` for agreement and `-5` for disagreement: https://github.com/Trymbakmahant/veritas-net/blob/main/contract/contracts/VeritasOracle.sol#L291-L296
- Registry sorts agents by reputation before dispatch: https://github.com/Trymbakmahant/veritas-net/blob/main/backend/src/registry.ts#L73-L79
- iNFT default split is 100% to the registering caller: https://github.com/Trymbakmahant/veritas-net/blob/main/contract/contracts/OracleINFT.sol#L204-L224
- `RoyaltyRouter` distributes fees to participating iNFT split recipients: https://github.com/Trymbakmahant/veritas-net/blob/main/contract/contracts/RoyaltyRouter.sol#L24-L44

---

## Integration Example

A dApp integrates Veritas in two steps.

### 1. On-chain: request resolution

```solidity
interface IVeritasOracle {
    function submitClaim(string calldata text, string calldata spec, uint64 resolveBy)
        external
        returns (uint256 claimId);
}

contract MyDapp {
    IVeritasOracle veritas;

    function requestResolve(string memory text, string memory spec) external returns (uint256 id) {
        // `spec` is a JSON string describing how to verify the claim.
        id = veritas.submitClaim(text, spec, uint64(block.timestamp + 1 hours));
    }
}
```

### 2. Off-chain: query status (optional)

```bash
GET /v1/claims/:id
{
  "id": "0xabc...",
  "status": "resolved",
  "outcome": "YES",
  "confidence": 0.92,
  "agents": [
    { "name": "github.veritas.eth",  "answer": "YES", "confidence": 0.88 },
    { "name": "auditor.veritas.eth", "answer": "YES", "confidence": 0.95 }
  ],
  "proofUri": "0g://..."
}
```

---

## OpenAgents Hackathon MVP

This repo ships an MVP for **ETHGlobal OpenAgents** on **0G Galileo** with
permissionless agent registration and three verifiable claim templates:

1. **GitHub**: “Was PR #123 merged before deadline?” (`github_pr_merged_before`)
2. **Snapshot**: “Did proposal P pass in space S?” (`snapshot_proposal_passed`)
3. **Token price**: “Was token X above/below price Y by deadline?” (`token_price_target`)

Instead of relying on a single opaque API call, Veritas agents produce evidence,
confidence scores, reasoning, signed votes, and a final proof bundle. The
coordinator pins that proof to 0G Storage before settling on-chain.

### Claim spec format (JSON)

Veritas expects `spec` to be a JSON string with a `kind`.

GitHub PR merged before deadline:

```json
{
  "kind": "github_pr_merged_before",
  "repo": "owner/name",
  "prNumber": 123,
  "deadlineIso": "2026-05-12T12:00:00Z"
}
```

Snapshot proposal passed:

```json
{
  "kind": "snapshot_proposal_passed",
  "space": "aave.eth",
  "proposalId": "0x1234..."
}
```

Token price target:

```json
{
  "kind": "token_price_target",
  "chainId": "1",
  "tokenAddress": "0x0000000000000000000000000000000000000000",
  "targetPriceUsd": 100,
  "direction": "above",
  "deadlineIso": "2026-05-12T12:00:00Z"
}
```

## Tech Stack

- **Frontend:** Next.js + Tailwind dashboard for agents, claims, and registration
- **Backend / Coordinator:** Node.js + Express
- **Agent Services:** Independent Express services for GitHub, Snapshot, token price, and adversarial auditing
- **Smart Contracts:** Solidity contracts on 0G Galileo
- **Agent Asset:** `OracleINFT`, an ERC-7857-style intelligent NFT registry for AI agents
- **Trust Contract:** `VeritasOracle`, which records claims, proof URIs, participants, disputes, callbacks, and reputation changes
- **Rewards:** `RoyaltyRouter`, which splits fees across participating iNFTs and their configured recipients
- **Storage:** 0G Storage for manifests, proof bundles, evidence, and verification snapshots
- **Compute:** 0G Compute for adversarial auditor inference and receipts
- **Agent Communication:** Gensyn AXL with a two-node local official AXL bridge
- **Identity:** ENS-style names such as `auditor.veritas.eth`

---

## End-to-End Flow

1. Builder registers an agent iNFT with an ENS-style name and 0G-pinned manifest.
2. App or dApp calls `submitClaim(text, spec, resolveBy)` on `VeritasOracle`.
3. Coordinator reads `OracleINFT`, fetches each agent manifest from 0G, and picks reputation-ranked agents by capability.
4. Coordinator dispatches the claim over AXL or HTTP.
5. Each agent returns `{ resolvable, outcome, confidence, reasoning, evidence[] }`.
6. Adversarial auditor challenges the tentative majority, optionally through 0G Compute.
7. Consensus engine applies resolvability, confidence, reputation, and auditor checks.
8. Proof bundle is pinned to 0G Storage.
9. Coordinator calls `resolveClaim(claimId, outcome, proofUri, participants, agreed)` on-chain.
10. `VeritasOracle` updates iNFT reputation and can notify a consumer dApp callback.
11. Fees can be routed through `RoyaltyRouter` to participating iNFT split recipients.

---

## Failure Modes & Mitigations


| Risk                            | Mitigation                                                  |
| ------------------------------- | ----------------------------------------------------------- |
| Ambiguous question              | Resolvability gate returns `INVALID`                        |
| All agents disagree             | Disagreement threshold returns `ESCALATE`                   |
| Single LLM provider downtime    | Oracle diversity (different models + providers)             |
| Coordinated oracle collusion    | Reputation decay, stake slashing, permissionless oracle set |
| Hallucinated sources            | Source-citing oracle requires verifiable URLs               |
| Question references future data | Deadline-bounded; auto-`INVALID` if data unavailable        |


---

## Roadmap

- More agent capability templates for dApps beyond claim resolution
- Stronger staking and slashing around iNFT reputation
- Production ERC-7857 transfer validity proofs for re-keying agent bundles
- Hosted AXL deployment beyond local official-node proof
- SDK for dApp integrators in TypeScript and Solidity
- Better reward automation around claim fees and royalty routing

---

## Running Locally

### 1. Clone

```bash
git clone https://github.com/Trymbakmahant/veritas-net
cd veritas-net
```

### 2. Start oracle services

```bash
npm install --legacy-peer-deps
npm run dev:full
```

`dev:full` starts:

- local AXL HTTP sidecar on `http://localhost:8765`
- GitHub / Snapshot / Auditor agents
- coordinator backend on `http://localhost:8787` with `AXL_HTTP_URL=http://localhost:8765`
- Next.js dashboard on `http://localhost:3000`

### 3. AXL real mode

```bash
# terminal 1
npm run dev:axl

# terminal 2
AXL_HTTP_URL=http://localhost:8765 npm run dev:backend
```

When `AXL_HTTP_URL` is set, the coordinator switches from in-process mock pub/sub
to the HTTP sidecar (`POST /axl/send`, `POST/GET /axl/subscribe`, `GET /health`).
This gives local multi-process pub/sub today and matches the adapter boundary for
a hosted Gensyn AXL sidecar later. Check `GET /health` on the coordinator; the
`axl` field includes sidecar status.

Primary oracle flow in real AXL mode:

```text
Coordinator
  ├─ subscribes veritas/vote/<claimId>
  ├─ publishes  veritas/claim/dispatch
  ▼
GitHub / Snapshot agents
  ├─ subscribe veritas/claim/dispatch
  ├─ filter by capability
  ├─ run local verifier
  └─ publish { kind: "agent_response", response } to veritas/vote/<claimId>
  ▼
Coordinator
  ├─ collects responses for AXL_VOTE_WINDOW_MS
  ├─ maps them back to iNFT identities
  ├─ signs + republishes { kind: "signed_vote", ... }
  └─ falls back to HTTP /verify if no AXL responses arrive
```

### 4. Official AXL node bridge proof

For the AXL qualification demo, Veritas can also route its existing HTTP/SSE
agent protocol through two local official Gensyn AXL nodes. The bridge is only an
adapter from Veritas channels (`/axl/send`, `/axl/subscribe`) to AXL node APIs
(`/send`, `/recv`, `/topology`).

Coordinator node config:

```json
{
  "PrivateKeyPath": "private-coord.pem",
  "Peers": [],
  "Listen": ["tls://0.0.0.0:9001"]
}
```

Agent node config:

```json
{
  "PrivateKeyPath": "private-agent.pem",
  "Peers": ["tls://127.0.0.1:9001"],
  "Listen": [],
  "api_port": 9012,
  "tcp_port": 7000
}
```

Local node startup evidence:

```text
$ ./node -config node-config-coord.json
[node] Loaded node config from node-config-coord.json
[node] Gensyn Node Started!
[node] Our IPv6: 202:58d8:3ca8:d61c:9597:1811:c9e8:512e
[node] Our Public Key: 34e4f86ae53c6d4d1cfdc6c2f5da28658576853dc2b93c276b3d8b0bb4dc94a5
[node] TLS listener started on [::]:9001
Listening on 127.0.0.1:9002
TCP Listener started on port 7000
[node] Connected inbound: 201:e582:5678:4201:b839:4789:e36b:e0a3@127.0.0.1:50218, source 127.0.0.1:9001

$ ./node -config node-config-agent.json
[node] Loaded node config from node-config-agent.json
[node] Configured peer: tls://127.0.0.1:9001
[node] Gensyn Node Started!
[node] Our IPv6: 201:e582:5678:4201:b839:4789:e36b:e0a3
[node] Our Public Key: 469f6a61ef7f91f1ae1d872507d7218e37cc555a7ef8a5ca0d641f370b31f87e
Listening on 127.0.0.1:9012
TCP Listener started on port 7000
[node] Connected outbound: 202:58d8:3ca8:d61c:9597:1811:c9e8:512e@127.0.0.1:9001, source 127.0.0.1:50218
```

Bridge the coordinator side through the coordinator AXL node:

```bash
cd backend
AXL_BRIDGE_PORT=8765 \
AXL_PEER_ID=coordinator-bridge \
AXL_NODE_URL=http://127.0.0.1:9002 \
AXL_DESTINATION_PEER_IDS=469f6a61ef7f91f1ae1d872507d7218e37cc555a7ef8a5ca0d641f370b31f87e \
npm run axl:bridge
```

Bridge the agent side through the agent AXL node:

```bash
cd backend
AXL_BRIDGE_PORT=8766 \
AXL_PEER_ID=agent-bridge \
AXL_NODE_URL=http://127.0.0.1:9012 \
AXL_DESTINATION_PEER_IDS=34e4f86ae53c6d4d1cfdc6c2f5da28658576853dc2b93c276b3d8b0bb4dc94a5 \
npm run axl:bridge
```

Bridge startup evidence:

```text
AXL node bridge listening at http://127.0.0.1:8765
  peerId=coordinator-bridge axlNode=http://127.0.0.1:9002 destinations=469f6a61ef7f91f1ae1d872507d7218e37cc555a7ef8a5ca0d641f370b31f87e
  replayBuffer=100 auth=off

AXL node bridge listening at http://127.0.0.1:8766
  peerId=agent-bridge axlNode=http://127.0.0.1:9012 destinations=34e4f86ae53c6d4d1cfdc6c2f5da28658576853dc2b93c276b3d8b0bb4dc94a5
  replayBuffer=100 auth=off
```

Health checks include the live AXL topology returned by each official node:

```bash
curl -s http://127.0.0.1:8765/health | jq
curl -s http://127.0.0.1:8766/health | jq
```

Example proof output:

```json
{
  "ok": true,
  "bridge": true,
  "peerId": "coordinator-bridge",
  "axlNodeUrl": "http://127.0.0.1:9002",
  "destinationPeerIds": [
    "469f6a61ef7f91f1ae1d872507d7218e37cc555a7ef8a5ca0d641f370b31f87e"
  ],
  "topology": {
    "our_ipv6": "202:58d8:3ca8:d61c:9597:1811:c9e8:512e",
    "our_public_key": "34e4f86ae53c6d4d1cfdc6c2f5da28658576853dc2b93c276b3d8b0bb4dc94a5",
    "peers": [
      {
        "uri": "tls://127.0.0.1:50218",
        "up": true,
        "inbound": true,
        "public_key": "469f6a61ef7f91f1ae1d872507d7218e37cc555a7ef8a5ca0d641f370b31f87e"
      }
    ]
  }
}
```

This proves the local coordinator and agent bridges are connected through
separate official AXL nodes, with each node exposing live `/topology`.

### 5. Start dashboard only

```bash
npm run dev:frontend
```

---

## Demo

Coming soon.

---

## Vision

Autonomous agents will compete to perform useful work for dApps. Veritas Net
gives them the missing market structure: identity, evidence, adversarial
verification, reputation, and rewards. The goal is an open network where agents
do not ask to be trusted; they earn it on-chain.

---

## Team

- Trymbak Mahant - [@Trymbakmahant](https://github.com/Trymbakmahant)

---

## Contact

- GitHub: [https://github.com/Trymbakmahant/veritas-net](https://github.com/Trymbakmahant/veritas-net)
- Issues & integrations: open a GitHub issue

