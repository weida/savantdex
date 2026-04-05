# SavantDex Operations Guide

> How to access, inspect, and maintain the current SavantDex community deployment.

---

## VPS Access

Current host:

- Host: `34.21.184.167`
- User: `streamr`
- SSH key: `~/.ssh/id_ed25519_vultr`

Login:

```bash
ssh -i ~/.ssh/id_ed25519_vultr streamr@34.21.184.167
```

---

## Project Directories

Main paths on the VPS:

- App root: `/home/streamr`
- SavantDex SDK + workers: `/home/streamr/savantdex`
- Registry data file: `/home/streamr/registry/agents.json`
- PM2 logs: `/home/streamr/.pm2/logs`

Useful subpaths:

- Workers: `/home/streamr/savantdex/demo`
- Signer server: `/home/streamr/savantdex/signer/server.mjs`
- Signer pm2 config: `/home/streamr/savantdex/signer.config.cjs`

---

## Current Live Services

The current clean production-like set is:

| Service | PM2 name | Port | Purpose |
|---|---|---:|---|
| Registry | `registry` | `3000` | Agent discovery / cards / registration |
| Signer Gateway | `signer-gateway` | `17099` | Runtime signing for backend gateway |
| Signer Worker | `signer-worker` | `17100` | Runtime signing for worker agents |
| API Gateway | `api-gateway` | `4000` | HTTP bridge into Streamr |
| Web Frontend | `savantdex-web` | `3001` | Human-facing inspection UI |
| Wallet Intelligence | `wallet-intelligence` | `32206` | Worker agent |
| Token Risk Screener | `token-risk-screener` | `32207` | Worker agent |
| TX Forensics | `tx-forensics` | `32208` | Worker agent |

Discovery should currently expose only:

- `token-risk-screener-v1`
- `wallet-intelligence-v1`
- `tx-forensics-v1`

---

## Health Checks

Run these after deploys or restarts:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:4000/health
curl http://127.0.0.1:17099/health
curl http://127.0.0.1:17100/health
curl http://127.0.0.1:3000/agents
```

Single agent checks:

```bash
curl http://127.0.0.1:3000/agents/token-risk-screener-v1
curl http://127.0.0.1:3000/agents/wallet-intelligence-v1
curl http://127.0.0.1:3000/agents/tx-forensics-v1
```

Agent card checks:

```bash
curl http://127.0.0.1:3000/agents/token-risk-screener-v1/card
curl http://127.0.0.1:3000/agents/wallet-intelligence-v1/card
curl http://127.0.0.1:3000/agents/tx-forensics-v1/card
```

End-to-end task check:

```bash
curl -X POST http://127.0.0.1:4000/task \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"token-risk-screener-v1","type":"screen-token","input":{"token":"PEPE"}}'
```

---

## PM2 Commands

List all services:

```bash
pm2 ls
```

Inspect one service:

```bash
pm2 show api-gateway
pm2 show wallet-intelligence
```

Read logs:

```bash
pm2 logs api-gateway --lines 100
pm2 logs wallet-intelligence --lines 100
pm2 logs token-risk-screener --lines 100
pm2 logs tx-forensics --lines 100
```

Restart a service:

```bash
pm2 restart api-gateway
pm2 restart wallet-intelligence
pm2 restart token-risk-screener
pm2 restart tx-forensics
```

Persist process list:

```bash
pm2 save
```

---

## Recommended Start Order

PM2 should restore these automatically, but the dependency order is:

1. `registry`
2. `signer-gateway`
3. `signer-worker`
4. `api-gateway`
5. worker agents
6. `savantdex-web`

---

## Troubleshooting

### 1. Worker is `online` in PM2 but keeps restarting

Check:

```bash
pm2 show wallet-intelligence
pm2 show token-risk-screener
pm2 show tx-forensics
```

If `uptime` stays near `0-2s` and `restarts` keeps increasing, inspect logs:

```bash
pm2 logs wallet-intelligence --lines 100
pm2 logs token-risk-screener --lines 100
```

Common cause:

- Streamr websocket port already occupied by an old hand-started process

Check port usage:

```bash
ss -ltnp | grep -E ':32204|:32205|:32206|:32207|:32208'
```

If you find stray non-PM2 processes, identify them:

```bash
ps -fp <pid>
```

Then stop the stale process and let PM2 reclaim the port.

### 2. `Stream not found in signer mode`

Cause:

- The Streamr stream was never created in setup mode for that agent ID

Fix:

- Run the one-time setup flow with direct key mode to create the stream
- Then return to signer mode

### 3. Signer health is down

Check:

```bash
curl http://127.0.0.1:17099/health
curl http://127.0.0.1:17100/health
pm2 logs signer-gateway --lines 100
pm2 logs signer-worker --lines 100
```

### 4. Registry still shows old demo agents

Inspect:

```bash
curl http://127.0.0.1:3000/agents
```

If stale agents remain, delete them using the owner signature flow or remove them during maintenance if they are legacy test records.

### 5. Backend blocks valid contract addresses as phone numbers

This was previously fixed in `backend/server.mjs` by skipping phone-number checks for address/hash/token fields.

If this reappears, review backend sanitization logic first.

---

## Current Operational Notes

- The current release is the **community Streamr version**.
- Streamr is the current transport implementation, not the long-term mandatory transport.
- Current auth model is still **demo-stage**:
  - `ownerAddress == runtimeAddress` for the live workers
  - full offline owner/runtime separation is planned later
- Do not use `nohup` for long-lived services anymore.
- PM2 is now the source of truth for service lifecycle.

---

## Maintenance Checklist

After any deployment:

1. `pm2 ls`
2. health check registry / backend / signer
3. verify `GET /agents`
4. run one end-to-end `/task` request
5. `pm2 save` if process definitions changed
