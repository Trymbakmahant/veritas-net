# Run Veritas Net Locally

This guide starts Veritas Net on your machine with the official Gensyn AXL Go
node running locally. It is meant for judges and reviewers who want to see the
full agent flow:

```text
Frontend -> Veritas coordinator -> official AXL node -> agent bridge -> AI agent
        -> signed response -> coordinator -> 0G proof URI / on-chain settlement
```

## What You Will Run

- Next.js dashboard at `http://localhost:3000`
- Veritas coordinator backend at `http://localhost:8787`
- GitHub, Snapshot, token price, and adversarial auditor agents
- Two official Gensyn AXL Go nodes:
  - coordinator node API at `http://127.0.0.1:9002`
  - agent node API at `http://127.0.0.1:9012`
- Two Veritas AXL bridges:
  - coordinator bridge at `http://127.0.0.1:8765`
  - agent bridge at `http://127.0.0.1:8766`

## Prerequisites

- Node.js 20+
- npm
- Go
- Git
- `jq`
- MetaMask, if you want to register an agent iNFT from the dashboard

Install dependencies from the repo root:

```bash
npm install --legacy-peer-deps
```

## Fast Local Demo

If you only want the app running with the local mock AXL sidecar:

```bash
npm run dev:full
```

Open:

```text
http://localhost:3000
```

This starts the dashboard, backend, agents, and the local Veritas AXL sidecar.
Use the next sections for the official Gensyn AXL Go node setup.

## 1. Build The Official Gensyn AXL Go Node

Clone AXL outside this repo:

```bash
git clone https://github.com/gensyn-ai/axl.git
cd axl
go build -o node ./cmd/node/
```

Generate two persistent local node identities:

```bash
openssl genpkey -algorithm ed25519 -out private-coord.pem
openssl genpkey -algorithm ed25519 -out private-agent.pem
```

On macOS, if system OpenSSL does not support `ed25519`:

```bash
brew install openssl
/opt/homebrew/opt/openssl/bin/openssl genpkey -algorithm ed25519 -out private-coord.pem
/opt/homebrew/opt/openssl/bin/openssl genpkey -algorithm ed25519 -out private-agent.pem
```

## 2. Configure Two AXL Nodes

Create `node-config-coord.json` in the AXL repo:

```json
{
  "PrivateKeyPath": "private-coord.pem",
  "Peers": [],
  "Listen": ["tls://0.0.0.0:9001"]
}
```

Create `node-config-agent.json` in the AXL repo:

```json
{
  "PrivateKeyPath": "private-agent.pem",
  "Peers": ["tls://127.0.0.1:9001"],
  "Listen": [],
  "api_port": 9012,
  "tcp_port": 7000
}
```

Start both nodes in separate terminals from the AXL repo:

```bash
./node -config node-config-coord.json
```

```bash
./node -config node-config-agent.json
```

The coordinator node exposes HTTP on `127.0.0.1:9002`. The agent node exposes
HTTP on `127.0.0.1:9012`.

## 3. Capture AXL Node Public Keys

In a new terminal:

```bash
export AXL_COORD_NODE_KEY=$(curl -s http://127.0.0.1:9002/topology | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])")
export AXL_AGENT_NODE_KEY=$(curl -s http://127.0.0.1:9012/topology | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])")

echo "coord=$AXL_COORD_NODE_KEY"
echo "agent=$AXL_AGENT_NODE_KEY"
```

Verify both topologies:

```bash
curl -s http://127.0.0.1:9002/topology | jq
curl -s http://127.0.0.1:9012/topology | jq
```

## 4. Start Veritas Bridges For The AXL Nodes

From the Veritas repo root, start the coordinator bridge:

```bash
cd backend
AXL_BRIDGE_PORT=8765 \
AXL_PEER_ID=coordinator-bridge \
AXL_NODE_URL=http://127.0.0.1:9002 \
AXL_DESTINATION_PEER_IDS=$AXL_AGENT_NODE_KEY \
npm run axl:bridge
```

In another terminal, start the agent bridge:

```bash
cd backend
AXL_BRIDGE_PORT=8766 \
AXL_PEER_ID=agent-bridge \
AXL_NODE_URL=http://127.0.0.1:9012 \
AXL_DESTINATION_PEER_IDS=$AXL_COORD_NODE_KEY \
npm run axl:bridge
```

Check both bridges:

```bash
curl -s http://127.0.0.1:8765/health | jq
curl -s http://127.0.0.1:8766/health | jq
```

The bridge is intentionally small. Veritas already speaks:

```text
POST /axl/send
POST /axl/subscribe
GET /health
```

The bridge maps that to the official AXL node API:

```text
POST /send
GET /recv
GET /topology
```

## 5. Start Veritas With Official AXL Routing

From the Veritas repo root, start the backend through the coordinator bridge:

```bash
AXL_HTTP_URL=http://127.0.0.1:8765 \
AXL_PEER_ID=local-coordinator \
npm run dev:backend
```

Start agents through the agent bridge:

```bash
AXL_HTTP_URL=http://127.0.0.1:8766 \
AXL_PEER_ID=github-agent \
npm run dev:github
```

```bash
AXL_HTTP_URL=http://127.0.0.1:8766 \
AXL_PEER_ID=snapshot-agent \
npm run dev:snapshot
```

```bash
AXL_HTTP_URL=http://127.0.0.1:8766 \
AXL_PEER_ID=token-price-agent \
npm run dev:token
```

Start the adversarial auditor:

```bash
npm run dev:auditor
```

Start the frontend:

```bash
npm run dev:frontend
```

Open:

```text
http://localhost:3000
```

## 6. One-Command App After Bridges Are Running

After the two official AXL nodes and two Veritas bridges are already running,
you can start the Veritas app stack with:

```bash
npm run dev:full:bridge
```

This routes coordinator traffic to `http://127.0.0.1:8765` and agent traffic to
`http://127.0.0.1:8766`.

## 7. Verify Message Flow

Check backend health:

```bash
curl -s http://localhost:8787/health | jq
```

Trigger a verification request:

```bash
curl -s http://localhost:8787/v1/verify \
  -H 'content-type: application/json' \
  -d '{
    "text": "Did octocat/Hello-World PR #1 merge before the deadline?",
    "spec": {
      "kind": "github_pr_merged_before",
      "repo": "octocat/Hello-World",
      "prNumber": 1,
      "deadlineIso": "2026-05-03T06:04:26.000Z"
    }
  }' | jq
```

What to show judges:

- `curl http://127.0.0.1:9002/topology` for the coordinator AXL node.
- `curl http://127.0.0.1:9012/topology` for the agent AXL node.
- `curl http://127.0.0.1:8765/health` for the coordinator bridge.
- `curl http://127.0.0.1:8766/health` for the agent bridge.
- Backend logs showing `AXL swarm #... collected ...`.
- Dashboard at `http://localhost:3000` showing agents, claims, and modes.

## 8. Register An Agent iNFT Locally

Open:

```text
http://localhost:3000/register
```

Then:

1. Fill in the agent slug, endpoint, capabilities, signer, and version.
2. Click `Pin to 0G Storage`.
3. Connect MetaMask to 0G Galileo.
4. Click `Register on-chain`.

The flow pins an `AgentManifest`, then calls `OracleINFT.registerOracle(...)`.
The new agent receives an iNFT identity and can earn reputation and rewards when
it participates in future work.

## Demo Wording

Use this if you are explaining it live:

> Veritas routes claim dispatch and agent responses through two separate official
> Gensyn AXL Go nodes running locally. Our bridge only adapts Veritas' HTTP/SSE
> channel API to AXL's `/send` and `/recv`; the actual peer transport is handled
> by the official AXL nodes.
