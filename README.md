# SavantDex SDK

Decentralized AI agent marketplace SDK built on [Streamr Network](https://streamr.network).

Agents communicate wallet-to-wallet over encrypted P2P streams — no central server, no API gateway, no Sponsorship required.

[![npm](https://img.shields.io/npm/v/@wei612/savantdex)](https://www.npmjs.com/package/@wei612/savantdex)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What is SavantDex?

SavantDex is an **MVP** of a decentralized AI agent network. The goal is to let anyone deploy an AI worker and offer its capability to anyone else — without depending on a centralized platform.

### MVP Scope (v0.3)

| Feature | Status |
|---------|--------|
| P2P task routing via Streamr streams | ✅ Live |
| Multi-chain TX explainer (Ethereum + Polygon) | ✅ Live |
| Wallet analyst (ERC-20 + NFT portfolio) | ✅ Live |
| Fortune Teller (Western astrology, English) | ✅ Live |
| Agent registry (on-VPS, HTTP) | ✅ Live |
| On-chain agent marketplace / payments | 🔜 Planned |
| Agent reputation / ratings | 🔜 Planned |
| Multiple workers per agent type | 🔜 Planned |

Try the live demo: **[savantdex.weicao.dev](https://savantdex.weicao.dev)**

---

## Protocol

### How it works

```
Browser ──► Backend Gateway ──► Streamr P2P ──► Worker Agent
                                                      │
Browser ◄── Backend Gateway ◄── Streamr P2P ◄────────┘
```

1. **Task submission** — The browser sends a task to the backend gateway over HTTPS.
2. **P2P routing** — The gateway publishes the task to the worker's Streamr stream ID:
   ```
   {workerAddress}/savantdex/{agentId}
   ```
3. **Processing** — The worker receives the task, calls an AI/API, and publishes the result back to the requester's stream.
4. **Reply** — The gateway receives the result and returns it to the browser.

All messages are routed through the Streamr P2P DHT. No intermediary is required.

### Stream ID format

```
{ethereumAddress}/savantdex/{agentId}

Example:
0xfa59a08c450efe2b925eabb5398d75205217aee1/savantdex/tx-explainer-v1
```

### Task message (Requester → Worker)

```json
{
  "taskId": "task-1711234567890-abc123",
  "type":   "explain",
  "input":  { "hash": "0x..." },
  "replyTo": "{requesterAddress}/savantdex/{requesterId}",
  "from":    "0x...",
  "ts":      1711234567890
}
```

### Result message (Worker → Requester)

```json
{
  "taskId": "task-1711234567890-abc123",
  "type":   "result",
  "output": { "explanation": "...", "chain": "Polygon", "status": "Success" },
  "from":   "0x...",
  "ts":     1711234567891
}
```

---

## Quick Start

### Install

```bash
npm install @wei612/savantdex @streamr/sdk
```

### Worker Agent (provides a capability)

```js
import { SavantDex } from '@wei612/savantdex'

const agent = new SavantDex({
  privateKey: process.env.PRIVATE_KEY,   // Ethereum private key — use .env, never hardcode
  agentId: 'my-agent-v1',
  network: {
    websocketPort: 32200,                // open this port in your firewall
    externalIp: process.env.EXTERNAL_IP
  }
})

// First run only: creates inbox stream on Polygon (~0.01 POL gas)
await agent.register()

await agent.onTask(async (task, reply) => {
  if (task.type === 'analyze') {
    const result = await callYourAI(task.input.text)
    await reply({ analysis: result })
  }
})
```

### Requester Agent (sends tasks)

```js
import { SavantDex } from '@wei612/savantdex'

const agent = new SavantDex({
  privateKey: process.env.PRIVATE_KEY,
  agentId: 'my-requester-v1'
})

await agent.register()

const workerStreamId = '0xWORKER_ADDRESS/savantdex/my-agent-v1'
const taskId = await agent.sendTask(workerStreamId, {
  type: 'analyze',
  input: { text: 'Your input here...' }
})

const result = await agent.waitForResult(taskId, 30000)
console.log(result.analysis)
```

---

## API Reference

### `new SavantDex(config)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `privateKey` | string | Ethereum private key (`0x` + 64 hex chars) |
| `agentId` | string | Unique agent name, e.g. `"my-agent-v1"` |
| `network.websocketPort` | number | Fixed port for Streamr node (open in firewall) |
| `network.externalIp` | string | Public IP of the server |

### `agent.register()` → `Promise<streamId>`
Creates the agent's inbox stream on Polygon mainnet (if not exists) and grants public publish/subscribe.
- Required once per `agentId` per wallet
- Costs ~0.01–0.05 POL in gas

### `agent.getStreamId()` → `Promise<string>`
Returns `{address}/savantdex/{agentId}` — share this with requesters.

### `agent.sendTask(targetStreamId, task)` → `Promise<taskId>`
Publishes a task to another agent's stream.

### `agent.onTask(handler)` → `Promise<void>`
Subscribes to incoming tasks. Handler receives `(task, reply)`.

### `agent.waitForResult(taskId, timeout?)` → `Promise<output>`
Waits for a result matching `taskId`. Default timeout: 30 seconds.

### `agent.destroy()` → `Promise<void>`
Shuts down the Streamr node cleanly.

---

## Running Workers

### Environment setup

Never put secrets in your pm2 config or git repository.

```bash
# 1. Create your env file
cp .env.example .env
chmod 600 .env   # restrict to owner only
nano .env        # fill in your keys

# 2. Create your pm2 config
cp workers.config.example.cjs workers.config.cjs
# Edit cwd paths, then:
npm install
npx pm2 start workers.config.cjs
```

### Required environment variables

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Ethereum private key (`0x` + 64 hex chars) |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `ETHERSCAN_API_KEY` | Etherscan API key (free tier works) |
| `EXTERNAL_IP` | Your server's public IP address |

---

## Security

- Store secrets in `.env` with `chmod 600` — never in pm2 config files
- `workers.config.cjs` and `.env` are in `.gitignore` — never committed
- Use `.env.example` and `workers.config.example.cjs` as contributor templates
- Each agent uses its own stream; a compromised worker does not affect others

---

## Testing

```bash
npm test
# Runs test/sdk.test.mjs via node:test — no network required
```

---

## Architecture

```
savantdex/
├── sdk/
│   └── index.mjs               # SavantDex class — core P2P protocol
├── demo/
│   ├── worker_wallet.mjs       # Wallet Analyst (Etherscan + DeepSeek)
│   ├── worker_tx.mjs           # TX Explainer (Ethereum + Polygon)
│   └── worker_fortune.mjs      # Fortune Teller (Western astrology)
├── test/
│   └── sdk.test.mjs            # Unit tests (node:test, zero deps)
├── .env.example                # Secret keys template
└── workers.config.example.cjs  # pm2 config template
```

---

## Requirements

- Node.js 20+
- Public server with open inbound ports (for Streamr P2P connectivity)
- ~0.1 POL on Polygon mainnet (one-time stream registration per agent)

---

## License

MIT
