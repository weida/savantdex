/**
 * SavantDex Worker — Wallet × Token Exposure Composer (A2A reference agent)
 *
 * This is the canonical A2A reference implementation for SavantDex.
 *
 * Unlike the other demo workers, this worker is BOTH a provider and a
 * requester: it exposes one composed capability (`assess-exposure`) and,
 * while handling each task, it calls two other workers through the public
 * gateway using `GatewayRequester` — the same SDK a third-party A2A caller
 * would use.
 *
 * Why it exists:
 *   1. Validates the worker→GatewayRequester→worker path end to end in a
 *      non-browser process. Without this, everything in the wallet/session
 *      auth stack is only exercised by curl and the main-site demo.
 *   2. Generates real `wallet-signature` traffic in `/admin/auth-stats`,
 *      which is the only way to tell whether the session/retry/auto re-auth
 *      loops actually work in a long-running server-side caller.
 *   3. Serves as a copy-paste template for the next team (internal or
 *      external) who wants to build a worker that consumes other workers.
 *
 * Design choices:
 *   - Provider identity uses the existing signer-worker process (same wallet
 *     as the other demo workers), because the stream owner convention is
 *     already fixed. This worker registers under that ownerAddress in the
 *     registry.
 *   - Requester identity uses a SEPARATE wallet (loaded from an ethers
 *     private key) and is bound to `wallet-token-exposure-v1` via the admin
 *     `/admin/requesters/:id/auth-methods` endpoint as a one-time ops step.
 *     This split is deliberate: we want the code path "worker wallet talks
 *     to gateway wallet/session auth" to be exercised independently of the
 *     stream-owner wallet.
 *   - PricingModel is `free` on purpose. Payment of the composer itself is
 *     not what this reference is validating — the A2A chain is.
 *   - Sub-workers called here: wallet-intelligence-v1 (fixed, 1 DATA/task) and
 *     token-risk-screener-v1 (free). The composer's requester budget must cover
 *     at least 1 DATA per task. Each call writes an InvocationRecord with
 *     `authMethodUsed='wallet-signature'`, which is the adoption signal.
 *
 * Required env (provider-side, Streamr):
 *   SIGNER_ADDRESS, SIGNER_PORT       — same as other workers
 *   EXTERNAL_IP, REGISTRY_URL         — standard
 *
 * Required env (requester-side, gateway A2A call):
 *   GATEWAY_URL                       — e.g. http://127.0.0.1:4000
 *   COMPOSER_REQUESTER_AGENT_ID       — the requesterAgentId registered in payment.db
 *                                       (default: wallet-token-exposure-v1)
 *   COMPOSER_REQUESTER_PRIVATE_KEY    — 0x-prefixed private key whose address is
 *                                       bound to COMPOSER_REQUESTER_AGENT_ID
 *                                       as a wallet-signature method
 *
 * Deployment checklist (one-time):
 *   1. Generate a fresh wallet for the requester side (`node -e "console.log(new (require('ethers')).Wallet.createRandom().privateKey)"`)
 *   2. Seed the requester identity:
 *        seedRequester({
 *          rawKey: null,
 *          requesterAgentId: 'wallet-token-exposure-v1',
 *          ownerAddress:     '<new wallet address>',
 *          remainingBaseUnits:  '0',
 *          maxPerTaskBaseUnits: '0',
 *          dailyLimitBaseUnits: '0',
 *        })
 *      (wallet-intelligence-v1 charges 1 DATA/task; set ≥10 DATA for basic validation)
 *   3. Bind the wallet:
 *        POST /admin/requesters/wallet-token-exposure-v1/auth-methods
 *        { methodType: 'wallet-signature', ownerAddress: '<new wallet address>' }
 *   4. Set COMPOSER_REQUESTER_PRIVATE_KEY and start the worker
 */

import { Wallet } from 'ethers'
import { SavantDex } from '../sdk/index.mjs'
import { GatewayRequester } from '../sdk/gateway-requester.mjs'
import { RemoteSignerIdentity } from '../sdk/remote-identity.mjs'
import { loadSecrets } from '../sdk/secrets.mjs'
import { loadPrivateKey } from '../sdk/keystore.mjs'
import { registerToRegistry } from '../sdk/registry.mjs'

const EXTERNAL_IP                  = process.env.EXTERNAL_IP    || '127.0.0.1'
const SIGNER_ADDRESS               = process.env.SIGNER_ADDRESS
const SIGNER_PORT                  = Number(process.env.SIGNER_PORT || 17100)
const GATEWAY_URL                  = process.env.GATEWAY_URL || 'http://127.0.0.1:4000'
const COMPOSER_REQUESTER_AGENT_ID  = process.env.COMPOSER_REQUESTER_AGENT_ID || 'wallet-token-exposure-v1'
const COMPOSER_REQUESTER_PRIVATE_KEY = process.env.COMPOSER_REQUESTER_PRIVATE_KEY

if (!COMPOSER_REQUESTER_PRIVATE_KEY) {
  console.error('[exposure-composer] COMPOSER_REQUESTER_PRIVATE_KEY is required — see deployment checklist in this file')
  process.exit(1)
}

// ── Provider-side identity (Streamr) ──────────────────────────────────────────

let workerAuth, ownerPrivateKey, registrySignerUrl
if (SIGNER_ADDRESS) {
  console.log(`[exposure-composer] Provider signer: ${SIGNER_ADDRESS} on port ${SIGNER_PORT}`)
  workerAuth = { identity: new RemoteSignerIdentity(SIGNER_ADDRESS, SIGNER_PORT) }
  registrySignerUrl = `http://127.0.0.1:${SIGNER_PORT}`
} else {
  console.warn('[exposure-composer] SIGNER_ADDRESS not set — falling back to local keystore (dev mode)')
  const { KEYSTORE_PASSWORD } = await loadSecrets()
  ownerPrivateKey = await loadPrivateKey(KEYSTORE_PASSWORD)
  workerAuth = { privateKey: ownerPrivateKey }
}

// ── Requester-side identity (Gateway wallet/session) ──────────────────────────
//
// Dedicated wallet, different from the stream owner. The whole point of this
// worker is to exercise the public wallet/session path end to end.

const requesterSigner = new Wallet(COMPOSER_REQUESTER_PRIVATE_KEY)
console.log(`[exposure-composer] Requester wallet: ${requesterSigner.address}`)
console.log(`[exposure-composer] Gateway:          ${GATEWAY_URL}`)

const gateway = GatewayRequester.create({
  gatewayUrl:       GATEWAY_URL,
  signer:           requesterSigner,
  requesterAgentId: COMPOSER_REQUESTER_AGENT_ID,
  ownerAddress:     requesterSigner.address,
})

// ── Exposure assessment logic ─────────────────────────────────────────────────

const SUB_TIMEOUT_MS = 25_000

function deriveExposure({ tokenScreen, walletProfile }) {
  const reasons = []

  const tokenRisk = tokenScreen?.riskLevel || 'UNKNOWN'
  const tokenFlags = Array.isArray(tokenScreen?.riskFlags) ? tokenScreen.riskFlags : []
  const walletRisk = walletProfile?.riskLevel || walletProfile?.risk?.level || 'UNKNOWN'

  if (['CRITICAL', 'HIGH'].includes(tokenRisk)) {
    reasons.push(`token screen rated ${tokenRisk}`)
  }
  for (const f of tokenFlags) {
    if (f.severity === 'CRITICAL' || f.severity === 'HIGH') {
      reasons.push(`token flag: ${f.flag}`)
    }
  }
  if (['CRITICAL', 'HIGH'].includes(walletRisk)) {
    reasons.push(`wallet profile rated ${walletRisk}`)
  }

  // Combined risk level: take the worst of the two inputs, elevate if both are elevated
  const LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
  const maxOf = (a, b) => LEVELS[Math.max(LEVELS.indexOf(a), LEVELS.indexOf(b))] || 'UNKNOWN'
  let riskLevel = maxOf(tokenRisk, walletRisk)

  // If both sides are at or above MEDIUM, escalate one notch (still capped at CRITICAL)
  if (LEVELS.indexOf(tokenRisk) >= 1 && LEVELS.indexOf(walletRisk) >= 1) {
    const idx = LEVELS.indexOf(riskLevel)
    if (idx >= 0 && idx < LEVELS.length - 1) riskLevel = LEVELS[idx + 1]
    reasons.push('both token and wallet show elevated risk — combined exposure escalated')
  }

  const summary = [
    `Token risk: ${tokenRisk}`,
    `Wallet risk: ${walletRisk}`,
    `Combined exposure: ${riskLevel}`,
    reasons.length ? `Reasons: ${reasons.join('; ')}` : 'No elevated risk signals detected.',
  ].join('\n')

  return { riskLevel, reasons, summary }
}

// ── Register as provider ──────────────────────────────────────────────────────

const agent = new SavantDex({
  ...workerAuth,
  agentId: 'wallet-token-exposure-v1',
  network: { websocketPort: 32240, websocketPortMax: 32250, externalIp: EXTERNAL_IP },
})

await agent.register()
await registerToRegistry(agent, ownerPrivateKey || null, {
  registryUrl: process.env.REGISTRY_URL || 'http://localhost:3000',
  capabilities: ['composition', 'exposure-assessment', 'a2a-reference'],
  description: 'Composes wallet-intelligence and token-risk-screener into a single wallet×token exposure assessment. Reference implementation for A2A composition patterns.',
  name: 'Wallet × Token Exposure',
  category: 'blockchain',
  exampleInput: {
    wallet: '0x0000000000000000000000000000000000000000',
    token:  '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
  },
  exampleOutput: {
    exposure: {
      riskLevel: 'MEDIUM',
      reasons:   ['token screen rated MEDIUM'],
      summary:   'Token risk: MEDIUM\nWallet risk: LOW\nCombined exposure: MEDIUM',
    },
  },
  inputSchema: [
    { key: 'wallet', label: 'Wallet Address', type: 'text', required: true,
      placeholder: '0x...', hint: 'EVM wallet address to profile' },
    { key: 'token',  label: 'Token Address',  type: 'text', required: true,
      placeholder: '0x...', hint: 'EVM token contract address to screen' },
  ],
  outputSchema: [
    { key: 'status',     type: 'string', description: 'completed | failed' },
    { key: 'exposure',   type: 'object', description: 'riskLevel, reasons[], summary' },
    { key: 'components', type: 'object', description: 'raw sub-agent outputs keyed by subAgentId' },
  ],
  taskType:          'assess-exposure',
  protocolVersion:   '1.0',
  supportsAsync:     false,
  expectedLatencyMs: 10_000,
  authType:          'none',
  pricingModel:      { type: 'free' },
  ...(registrySignerUrl ? { signerUrl: registrySignerUrl } : {}),
}).catch(e => console.warn('[registry] Registration skipped:', e.message))

console.log('\n=== SavantDex Worker — Wallet × Token Exposure (A2A composer) ===')
console.log('Stream:', await agent.getStreamId())
console.log('Waiting for tasks...\n')

// ── Task handler ──────────────────────────────────────────────────────────────

await agent.onTask(async (task, reply) => {
  if (task.type !== 'assess-exposure') {
    return reply({ error: `Unknown task type: ${task.type}` })
  }

  const wallet = task.input?.wallet?.trim()
  const token  = task.input?.token?.trim()
  if (!wallet) return reply({ error: 'wallet is required' })
  if (!token)  return reply({ error: 'token is required' })
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return reply({ error: 'wallet must be a 0x-prefixed 40-hex EVM address' })
  }
  // token can be address or symbol — token-risk-screener accepts both

  console.log(`[exposure-composer] Task: wallet=${wallet} token=${token}`)

  // Parallel A2A calls. Errors from one sub-call must not take down the
  // composer entirely — we still want to report partial data.
  const started = Date.now()
  const [walletSettled, tokenSettled] = await Promise.allSettled([
    gateway.run('wallet-intelligence-v1', { address: wallet }, { timeout: SUB_TIMEOUT_MS }),
    gateway.run('token-risk-screener-v1', { token },           { timeout: SUB_TIMEOUT_MS }),
  ])
  const elapsed = Date.now() - started

  const walletResult = walletSettled.status === 'fulfilled' ? walletSettled.value : null
  const tokenResult  = tokenSettled.status  === 'fulfilled' ? tokenSettled.value  : null

  const walletError = walletSettled.status === 'rejected'
    ? (walletSettled.reason?.message || String(walletSettled.reason))
    : (walletResult?.error || null)
  const tokenError  = tokenSettled.status === 'rejected'
    ? (tokenSettled.reason?.message || String(tokenSettled.reason))
    : (tokenResult?.error || null)

  console.log(`[exposure-composer]   sub-calls done in ${elapsed}ms (wallet=${walletError ? 'err' : 'ok'}, token=${tokenError ? 'err' : 'ok'})`)

  if (walletError && tokenError) {
    return reply({
      status: 'failed',
      error:  `Both sub-calls failed — wallet: ${walletError}; token: ${tokenError}`,
    })
  }

  const exposure = deriveExposure({
    tokenScreen:   tokenResult?.output  || null,
    walletProfile: walletResult?.output || null,
  })

  await reply({
    exposure,
    components: {
      'wallet-intelligence-v1': walletResult?.output || { error: walletError },
      'token-risk-screener-v1': tokenResult?.output  || { error: tokenError  },
    },
    meta: {
      subCallLatencyMs: elapsed,
      composerRequesterAgentId: COMPOSER_REQUESTER_AGENT_ID,
      authMethod: 'wallet-signature',
    },
  })
})
