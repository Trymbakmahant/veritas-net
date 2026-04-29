# Veritas Technical Guide

This document is a single, implementation-level reference for the current Veritas MVP.
Use this when you want to understand how the system works end-to-end and safely modify it.

## 1) System Overview

Veritas is an EVM claim oracle with:

- On-chain claim registry + resolution contract
- Off-chain coordinator (Express + ethers)
- Verifier agents (currently GitHub and Snapshot)
- Consensus logic that maps agent responses to a final outcome

Current outcomes:

- `NO` = `0`
- `YES` = `1`
- `INVALID` = `2`
- `ESCALATE` = `3`

## 2) Repository Map

- `contract/`
  - `contracts/VeritasOracle.sol`: on-chain claim lifecycle
  - `hardhat.config.js`: Solidity compiler + network config
  - `scripts/deploy.ts`: deploy script
- `backend/`
  - `src/index.ts`: coordinator app entrypoint, chain I/O, HTTP endpoints
  - `src/agents.ts`: HTTP clients for agent calls
  - `src/coordinator.ts`: consensus decision function
  - `src/types.ts`: all shared schemas and type contracts
- `agents/github-agent/src/index.ts`: verifies GitHub PR merge deadline claim
- `agents/snapshot-agent/src/index.ts`: verifies Snapshot proposal pass claim

## 3) On-Chain Contract Architecture

File: `contract/contracts/VeritasOracle.sol`

### 3.1 Core State

- `nextClaimId`: incremental claim ID counter, starts at `1`
- `resolver`: address allowed to call `resolveClaim` (backend/coordinator signer in MVP)
- `claims`: mapping `uint256 => Claim`

`Claim` fields:

- `requester`: address that created the claim
- `resolveBy`: earliest timestamp at which claim can be resolved
- `resolvedAt`: resolution timestamp, `0` if unresolved
- `outcome`: enum (`NO/YES/INVALID/ESCALATE`)
- `text`: human claim text
- `spec`: JSON string describing verification rules/template
- `proofUri`: pointer to verification evidence bundle

### 3.2 Events

- `ClaimSubmitted(claimId, requester, resolveBy, text, spec)`
- `ClaimResolved(claimId, outcome, resolvedAt, proofUri)`

Backend can subscribe to `ClaimSubmitted` for automation.

### 3.3 Functions

#### `constructor(address _resolver)`

- Sets initial resolver.

#### `setResolver(address _resolver)`

- Updates resolver.
- MVP note: currently permissionless for speed.
- Production note: should be governance/timelock-gated.

#### `submitClaim(string text, string spec, uint64 resolveBy) returns (uint256 claimId)`

- Creates new claim.
- Initializes:
  - `resolvedAt = 0`
  - `outcome = INVALID` (default placeholder before final resolution)
  - `proofUri = ""`
- Emits `ClaimSubmitted`.

#### `resolveClaim(uint256 claimId, Outcome outcome, string proofUri)`

- Restricted to `resolver`.
- Guard checks:
  - claim exists (`requester != address(0)`)
  - not already resolved (`resolvedAt == 0`)
  - not before deadline (`block.timestamp >= resolveBy`)
- Writes final outcome + timestamp + proof URI.
- Emits `ClaimResolved`.

## 4) Claim Spec Model

Validation lives in `backend/src/types.ts` as a discriminated union on `kind`.

### 4.1 GitHub Template

```json
{
  "kind": "github_pr_merged_before",
  "repo": "owner/name",
  "prNumber": 123,
  "deadlineIso": "2026-05-12T12:00:00Z"
}
```

### 4.2 Snapshot Template

```json
{
  "kind": "snapshot_proposal_passed",
  "space": "aave.eth",
  "proposalId": "0x1234..."
}
```

## 5) Backend Coordinator Architecture

File: `backend/src/index.ts`

### 5.1 Startup

At startup, backend:

1. Loads env vars
2. Validates required env:
   - `RPC_URL`
   - `COORDINATOR_PRIVATE_KEY`
   - `VERITAS_ORACLE_ADDRESS`
3. Creates:
   - `ethers.JsonRpcProvider`
   - signer wallet from `COORDINATOR_PRIVATE_KEY`
   - contract instance with minimal ABI

### 5.2 Internal Helpers

#### `requireEnv(name, value)`

- Throws if required config missing.
- This is why service exits fast when env is incomplete.

#### `parseSpec(specRaw)`

- Expects raw JSON string.
- `JSON.parse` + Zod validation via `ClaimSpecSchema`.
- Throws `Invalid spec JSON: ...` on malformed input.

#### `runVerification(text, specRaw, claimId?)`

- Parses/validates spec.
- Builds `AgentRequest`.
- Calls relevant agent(s) based on `spec.kind`:
  - GitHub kind -> calls GitHub agent twice (swarm simulation)
  - Snapshot kind -> calls Snapshot agent twice
- Passes all responses into `decide(...)` from `coordinator.ts`.

Important current behavior:

- The "swarm" is currently duplicated agent invocations per template.
- This is intentional for demo shape; replace with diverse agents later.

### 5.3 HTTP API Endpoints

#### `GET /health`

Response:

```json
{ "ok": true }
```

#### `POST /v1/verify`

Purpose:

- Off-chain test of verification + consensus without writing on-chain.

Request body:

```json
{
  "text": "Was PR #123 merged before deadline?",
  "spec": {
    "kind": "github_pr_merged_before",
    "repo": "owner/name",
    "prNumber": 123,
    "deadlineIso": "2026-05-12T12:00:00Z"
  }
}
```

`spec` can also be a JSON string.

Response:

- Full `CoordinatorDecision`:
  - `outcome`
  - `confidence`
  - `resolvable`
  - `proof` bundle with request, agent responses, notes

#### `POST /v1/resolve/:claimId`

Purpose:

- Read claim from contract and commit final resolution on-chain.

Flow:

1. Parse `claimId`
2. Call `contract.claims(claimId)` to fetch `text` + `spec`
3. Run `runVerification(...)`
4. Build proof payload as a `data:application/json,...` URI
5. Call `contract.resolveClaim(...)` with mapped enum outcome
6. Wait tx receipt and return `txHash`

Response:

```json
{
  "claimId": 1,
  "outcome": "YES",
  "txHash": "0x..."
}
```

### 5.4 Event Listener

`contract.on("ClaimSubmitted", ...)` currently logs events only.

To make fully automatic resolution, replace log with:

1. fetch claim
2. wait until `resolveBy` if needed
3. run verification
4. submit `resolveClaim`

## 6) Agent Client Layer

File: `backend/src/agents.ts`

### Functions

#### `postJson(url, body, headers?)`

- Generic POST helper.
- Throws rich error on non-2xx with status + response text.

#### `callGithubAgent(agentUrl, req, githubToken?)`

- Calls `POST {agentUrl}/verify`
- If token present, sends `Authorization: Bearer <token>`
- Validates response via `AgentResponseSchema`

#### `callSnapshotAgent(agentUrl, req)`

- Calls `POST {agentUrl}/verify`
- Validates response via `AgentResponseSchema`

## 7) Consensus Engine

File: `backend/src/coordinator.ts`

Main function: `decide(agentResponses, request)`

### Decision Algorithm (Current MVP)

1. **Resolvability gate**
   - If less than half of agents mark resolvable -> return `INVALID`.

2. **Outcome majority**
   - Count votes across `YES/NO/INVALID/ESCALATE`.

3. **Tie handling**
   - If top two counts equal -> `ESCALATE`.

4. **Agreement threshold**
   - Compute `agreement = topCount / total`.
   - If `agreement < 0.67` -> `ESCALATE`.

5. **Confidence calculation**
   - Uses weighted formula with agreement + average confidence among winning responders.

6. **Proof bundle**
   - Returns structured trace:
     - original request
     - all agent responses
     - outcome
     - confidence
     - notes
     - timestamp

## 8) Shared Type Contracts

File: `backend/src/types.ts`

### Key Schemas

- `OutcomeSchema`: `NO | YES | INVALID | ESCALATE`
- `ClaimSpecSchema`: discriminated union by `kind`
- `AgentRequestSchema`: payload sent to agents
- `AgentResponseSchema`: strict shape each agent must return

### Enum Mapping

`outcomeToEnum(outcome)` maps string outcome to Solidity enum index:

- `NO` -> `0`
- `YES` -> `1`
- `INVALID` -> `2`
- `ESCALATE` -> `3`

This mapping must stay in sync with `VeritasOracle.Outcome`.

## 9) GitHub Agent Internals

File: `agents/github-agent/src/index.ts`

### Endpoint

- `GET /health`
- `POST /verify`

### Verify Logic

1. Validate request with Zod (`kind` must be `github_pr_merged_before`)
2. Parse `repo` into `owner/name`
3. Fetch PR from GitHub API:
   - `GET /repos/{owner}/{repo}/pulls/{prNumber}`
4. Parse `deadlineIso`
5. Read `merged_at`
6. Decision:
   - `YES` if `merged_at` exists and `merged_at <= deadline`
   - otherwise `NO`
7. Return evidence:
   - GitHub API endpoint URL
   - PR HTML URL

### Auth

- If backend passes token, agent forwards it as Authorization header.

## 10) Snapshot Agent Internals

File: `agents/snapshot-agent/src/index.ts`

### Endpoint

- `GET /health`
- `POST /verify`

### Verify Logic

1. Validate request with Zod (`kind` must be `snapshot_proposal_passed`)
2. Query Snapshot GraphQL `proposal(id: ...)`
3. If proposal missing -> `INVALID`, `resolvable=false`
4. If `space` mismatch -> `INVALID`, `resolvable=false`
5. If not finalized (`state` not `closed|final`) -> `ESCALATE`
6. Determine winner by max score (`argMax(scores)`)
7. Heuristic pass labels:
   - yes/for/approve/accept -> `YES`
   - anything else -> `NO`

### External Dependency

- `SNAPSHOT_GRAPHQL` env controls endpoint
- default: `https://hub.snapshot.org/graphql`

## 11) API Call Flow (End-to-End)

### A) Manual verification only (no chain write)

1. Client -> `backend POST /v1/verify`
2. Backend validates + routes by `spec.kind`
3. Backend -> agent `/verify` calls
4. Agents -> external data APIs (GitHub/Snapshot)
5. Backend consensus computes final decision
6. Backend returns `CoordinatorDecision`

### B) On-chain resolution flow

1. User/app calls `submitClaim(...)` on contract
2. Later call backend `POST /v1/resolve/:claimId`
3. Backend reads claim from chain
4. Backend calls agents and computes decision
5. Backend writes `resolveClaim(...)` tx
6. Contract stores outcome + proof URI and emits `ClaimResolved`

## 12) Environment Variables

### Backend (`backend/.env`)

- `PORT`: backend API port (default `8787`)
- `RPC_URL`: chain RPC for contract read/write
- `COORDINATOR_PRIVATE_KEY`: signer used as resolver
- `VERITAS_ORACLE_ADDRESS`: deployed contract
- `GITHUB_AGENT_URL`: default `http://localhost:8801`
- `SNAPSHOT_AGENT_URL`: default `http://localhost:8802`
- `GITHUB_TOKEN`: optional, improves rate limits

### Contract deploy (`contract/.env`)

- `DEPLOYER_PRIVATE_KEY`
- `SEPOLIA_RPC_URL`
- `BASE_SEPOLIA_RPC_URL`
- `RESOLVER_ADDRESS` (optional; defaults to deployer in script)

### Agent env

- GitHub agent:
  - `PORT` (default `8801`)
- Snapshot agent:
  - `PORT` (default `8802`)
  - `SNAPSHOT_GRAPHQL` (optional override)

## 13) Runtime Commands (Bun-first)

From repo root:

```bash
npm install
```

Start services:

```bash
cd agents/github-agent && bun run dev
cd agents/snapshot-agent && bun run dev
cd backend && bun run dev
```

Compile contract:

```bash
cd contract && npx hardhat compile
```

Deploy:

```bash
cd contract
npm run deploy:sepolia
# or
npm run deploy:baseSepolia
```

## 14) Typical Errors and Fixes

### `Missing env RPC_URL` (or other env)

Cause:

- Backend startup guard in `requireEnv`.

Fix:

- Fill `backend/.env` from `backend/.env.example`.

### `ERR_MODULE_NOT_FOUND ... types.js`

Cause:

- Running old `ts-node` ESM path.

Fix:

- Use Bun dev scripts (`bun run dev`) as currently configured.

### `NotResolver` revert on `resolveClaim`

Cause:

- Coordinator signer address != contract `resolver`.

Fix:

- Set resolver correctly at deploy, or call `setResolver`.

### `TooEarly` revert on `resolveClaim`

Cause:

- Attempted resolution before `resolveBy`.

Fix:

- Wait until deadline or set shorter resolveBy in tests.

### Agent call failed 400/500

Cause:

- Invalid spec schema, upstream API failures, bad IDs.

Fix:

- Validate request against templates in section 4.
- Check agent logs and test each `/verify` endpoint directly.

## 15) Extending the System

### Add a new claim template

1. Add new variant in `ClaimSpecSchema` (`backend/src/types.ts`)
2. Add agent request schema for that template in target agent
3. Add backend routing in `runVerification(...)`
4. Update docs and README examples

### Add a new agent

1. Create `agents/<new-agent>/src/index.ts` with `/verify`
2. Ensure response matches `AgentResponseSchema`
3. Add URL env var in backend
4. Call new agent from `runVerification(...)`
5. Update `decide(...)` thresholds if needed

### Replace demo swarm with real heterogeneous swarm

Current behavior duplicates one agent call per template.
Upgrade path:

- run multiple different implementations per template
- add weighted reputation per agent
- sign responses and include signatures in proof

## 16) Security and Production Notes

Current MVP intentionally prioritizes speed.
Before production:

- Gate `setResolver` (governance/multisig/timelock)
- Replace `data:` proof URI with durable storage (0G/IPFS)
- Add auth/rate-limits to backend endpoints
- Add replay protection/idempotency for resolution jobs
- Add richer resolvability policy and source allowlists
- Add integration tests for chain + agent + backend flows

## 17) Quick Self-Debug Checklist

1. Are all three services running and healthy?
2. Does `spec.kind` match exactly one supported template?
3. Can each agent verify the claim independently?
4. Is backend using the correct resolver private key?
5. Is contract `resolver` set to that signer?
6. Is current time >= `resolveBy` before resolving?
7. Does `outcomeToEnum` match Solidity enum order?

If all seven are true, end-to-end resolution should work.

