# Veritas

**A decentralized AI oracle network for prediction markets.**

Veritas is a multi-agent consensus protocol that resolves prediction market questions using a swarm of independent AI oracles. Markets submit a question; Veritas returns a verifiable outcome — or flags the question as unresolvable.

> Truth, derived from the disagreement of many minds.

---

## The Problem

Prediction markets need a trustworthy way to settle outcomes. Today they rely on:

- **UMA / optimistic oracles** — slow (hours to days), expensive, dispute-heavy
- **Chainlink / data feeds** — only work for structured numeric data, not real-world events
- **Reality.eth / human juries** — manual, low throughput, vulnerable to apathy
- **Centralized resolvers** — single point of failure and capture

None of these reason about ambiguous, real-world questions at scale. And none of them can tell you *whether a question is even resolvable in the first place* — a critical gap that leads to stuck markets and contested settlements.

---

## What Veritas Does

Prediction markets (Polymarket-style apps, on-chain DAOs, custom dApps) integrate Veritas as their resolution layer.

```
Prediction Market Contract
        │  submitClaim(text, spec, resolveBy)
        ▼
   Veritas Protocol
        │
        ├─► Dispatch to N independent AI oracles
        │       (different models, prompts, data sources)
        │
        ├─► Each oracle returns:
        │       • resolvable?  (yes / no)
        │       • answer        (YES / NO / INVALID)
        │       • confidence    (0–1)
        │       • reasoning + sources
        │
        ├─► Consensus Engine
        │       • resolvability gate
        │       • confidence-weighted voting
        │       • reputation weighting
        │
        └─► On-chain callback
                resolveClaim(id, outcome, proofUri)
        ▼
Prediction Market settles
```

The market contract receives one of four outcomes:


| Outcome    | Meaning                                                     |
| ---------- | ----------------------------------------------------------- |
| `YES`      | Strong consensus the event occurred                         |
| `NO`       | Strong consensus the event did not occur                    |
| `INVALID`  | Question was malformed / ambiguous / unresolvable           |
| `ESCALATE` | No consensus — falls back to human dispute layer (e.g. UMA) |


---

## Why "Resolvability" Matters

A huge chunk of prediction market disputes happen because the *question itself* was ambiguous, e.g. "Will Trump tweet about AI before April?" — what counts as "tweet"? what counts as "AI"? what timezone?

Veritas treats resolvability as a **first-class signal**. Every oracle independently decides whether the question can be objectively resolved before answering. If most oracles say "no", the market settles `INVALID` instead of producing a noisy answer that triggers a dispute.

---

## The AI Oracle Swarm

Each oracle is an independent service running a different reasoning strategy. Diversity is the security model.


| Oracle              | Strategy                                                 |
| ------------------- | -------------------------------------------------------- |
| Conservative        | Only answers YES with strong, citable evidence           |
| Aggressive          | Probabilistic; fast; confident under partial information |
| News-grounded       | Pulls from live news APIs; recency-weighted              |
| Source-citing       | Must produce ≥2 independent sources or abstains          |
| Adversarial auditor | Tries to disprove the majority before signing off        |


Adding/removing oracles is permissionless. Each oracle has an on-chain reputation that grows or decays based on agreement with finalized outcomes.

---

## Consensus Engine

Naïve majority voting is unsafe for money-settling markets. Veritas uses:

1. **Resolvability gate** — if `>50%` of oracles flag the question as unresolvable, return `INVALID`.
2. **Confidence-weighted voting** — each oracle's vote is weighted by `confidence × reputation`.
3. **Disagreement threshold** — if the winning side's weighted share is below a configurable threshold (default 70%), return `ESCALATE`.
4. **Slashing (planned)** — oracles that disagree with finalized outcomes lose stake and reputation.

---

## Comparison


|                            | UMA        | Chainlink Data Feeds | Reality.eth | **Veritas**         |
| -------------------------- | ---------- | -------------------- | ----------- | ------------------- |
| Real-world events          | Yes        | No                   | Yes         | Yes                 |
| Resolution speed           | Hours–days | Seconds              | Hours       | **Minutes**         |
| Resolvability detection    | No         | No                   | No          | **Yes**             |
| Cost per resolution        | High       | Low                  | Medium      | **Low**             |
| Human-in-the-loop fallback | Native     | None                 | Native      | Optional escalation |
| Decentralized              | Yes        | Partially            | Yes         | Yes                 |


Veritas is not a UMA replacement for high-stakes disputes — it's a fast, cheap **first-pass resolver** that escalates to human juries only when needed.

---

## Integrations

### 0G Labs — Persistent Agent Memory

Stores oracle reasoning logs, consensus history, and per-oracle performance over time. Enables agents to learn from past resolutions.

### Gensyn (AXL) — P2P Agent Communication

Oracles exchange intermediate reasoning peer-to-peer instead of through a central coordinator, reducing single points of failure.

### KeeperHub — On-chain Execution

Handles the final on-chain `resolveQuestion` callback, including retries, gas optimization, and chain selection.

### ENS — Oracle Identity & Reputation

Each oracle has a human-readable identity (`conservative.veritas.eth`) tied to its on-chain reputation, making the swarm transparent and auditable.

---

## Integration Example

A prediction market integrates Veritas in two steps.

### 1. On-chain — request resolution

```solidity
interface IVeritasOracle {
    function submitClaim(string calldata text, string calldata spec, uint64 resolveBy)
        external
        returns (uint256 claimId);
}

contract MyMarket {
    IVeritasOracle veritas;

    function requestResolve(string memory text, string memory spec) external returns (uint256 id) {
        // `spec` is a JSON string describing how to verify the claim.
        id = veritas.submitClaim(text, spec, uint64(block.timestamp + 1 hours));
    }
}
```

### 2. Off-chain — query status (optional)

```bash
GET /v1/claims/:id
{
  "id": "0xabc...",
  "status": "resolved",
  "outcome": "YES",
  "confidence": 0.92,
  "oracles": [
    { "name": "conservative.veritas.eth", "answer": "YES", "confidence": 0.88 },
    { "name": "news.veritas.eth",         "answer": "YES", "confidence": 0.95 },
    { "name": "aggressive.veritas.eth",   "answer": "YES", "confidence": 0.93 }
  ],
  "proofUri": "0g://..."
}
```

---

## OpenAgents Hackathon MVP (EVM)

This repo ships an MVP for **ETHGlobal OpenAgents** on **Sepolia / Base Sepolia** with two verifiable claim templates:

1. **GitHub**: “Was PR #123 merged before deadline?” (`github_pr_merged_before`)
2. **Snapshot**: “Did proposal P pass in space S?” (`snapshot_proposal_passed`)

Instead of relying on a single API key per oracle, Veritas agents produce an **evidence bundle** (links + timestamps) and the coordinator stores the proof on resolution.

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

## Tech Stack

- **Frontend:** Next.js + Tailwind (demo dashboard for market integrators)
- **Backend / Coordinator:** Node.js (Express)
- **Oracle Services:** Independent Express services, each wrapping an LLM with its own prompt + data tools
- **Smart Contracts:** Solidity, EVM-compatible
- **Storage:** 0G Storage (reasoning logs, consensus history)
- **Agent Communication:** Gensyn AXL
- **On-chain Execution:** KeeperHub
- **Identity:** ENS

---

## End-to-End Flow

1. App/market calls `submitClaim(text, spec, resolveBy)` on the Veritas contract.
2. Coordinator dispatches the claim to the active agent set.
3. Each agent independently returns `{ resolvable, outcome, confidence, reasoning, evidence[] }`.
4. Consensus engine applies the resolvability gate + disagreement thresholds.
5. Proof bundle is stored (MVP uses a `data:` URI; production uses 0G/IPFS).
6. Coordinator calls `resolveClaim(claimId, outcome, proofUri)` on-chain.

---

## Failure Modes & Mitigations


| Risk                            | Mitigation                                                  |
| ------------------------------- | ----------------------------------------------------------- |
| Ambiguous question              | Resolvability gate → `INVALID`                              |
| All oracles disagree            | Disagreement threshold → `ESCALATE` to human dispute layer  |
| Single LLM provider downtime    | Oracle diversity (different models + providers)             |
| Coordinated oracle collusion    | Reputation decay, stake slashing, permissionless oracle set |
| Hallucinated sources            | Source-citing oracle requires verifiable URLs               |
| Question references future data | Deadline-bounded; auto-`INVALID` if data unavailable        |


---

## Roadmap

- Multi-oracle consensus prototype
- Resolvability detection
- On-chain reputation contract
- Stake + slashing mechanism
- Permissionless oracle onboarding
- Escalation bridge to UMA / Reality.eth
- SDK for prediction market integrators (TypeScript + Solidity)

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

### 4. Start dashboard only

```bash
npm run dev:frontend
```

---

## Demo

Coming soon.

---

## Vision

Prediction markets are only as trustworthy as their oracle. Veritas turns oracle resolution from a single point of failure into an open, competitive market of AI agents — where truth is the product and reputation is the moat.

---

## Team

- Trymbak Mahant — [@Trymbakmahant](https://github.com/Trymbakmahant)

---

## Contact

- GitHub: [https://github.com/Trymbakmahant/veritas-net](https://github.com/Trymbakmahant/veritas-net)
- Issues & integrations: open a GitHub issue

