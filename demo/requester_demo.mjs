/**
 * SavantDex Demo Requester
 *
 * Demonstrates the full agent-native marketplace flow:
 *   1. Discover agents by capability (findAgents)
 *   2. Inspect the agent card (getCard)
 *   3. Call token-risk-screener  (run)
 *   4. Call wallet-intelligence  (run)
 *   5. Print structured output + timing for each
 *
 * This is the "placing an order on the street" proof-of-concept.
 * The requester is a real P2P agent — no backend gateway involved.
 *
 * Usage:
 *   # Signer mode (recommended — no private key in env):
 *   SIGNER_ADDRESS=0x... SIGNER_PORT=17100 \
 *   EXTERNAL_IP=... REGISTRY_URL=http://localhost:3000 \
 *   node savantdex/demo/requester_demo.mjs
 *
 *   # Direct key mode:
 *   PRIVATE_KEY=0x... EXTERNAL_IP=... \
 *   node savantdex/demo/requester_demo.mjs
 */

import { SavantDexRequester } from '../sdk/requester.mjs'
import { RemoteSignerIdentity } from '../sdk/remote-identity.mjs'

const REGISTRY_URL   = process.env.REGISTRY_URL  || 'http://localhost:3000'
const EXTERNAL_IP    = process.env.EXTERNAL_IP    || '127.0.0.1'
const SIGNER_ADDRESS = process.env.SIGNER_ADDRESS
const SIGNER_PORT    = Number(process.env.SIGNER_PORT || 17100)
const PRIVATE_KEY    = process.env.PRIVATE_KEY

// ── Auth ──────────────────────────────────────────────────────────────────────

let agentConfig
if (SIGNER_ADDRESS) {
  console.log(`[requester] Using remote signer: ${SIGNER_ADDRESS} on port ${SIGNER_PORT}`)
  agentConfig = {
    identity: new RemoteSignerIdentity(SIGNER_ADDRESS, SIGNER_PORT),
    agentId:  'requester-demo-v1',
    network:  { websocketPort: 32210, externalIp: EXTERNAL_IP },
    registryUrl: REGISTRY_URL,
  }
} else if (PRIVATE_KEY) {
  agentConfig = {
    privateKey: PRIVATE_KEY,
    agentId:    'requester-demo-v1',
    network:    { websocketPort: 32210, externalIp: EXTERNAL_IP },
    registryUrl: REGISTRY_URL,
  }
} else {
  console.error('[requester] Set SIGNER_ADDRESS or PRIVATE_KEY')
  process.exit(1)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sep(title) {
  const line = '─'.repeat(60)
  console.log(`\n${line}`)
  if (title) console.log(` ${title}`)
  console.log(line)
}

function printAgent(a) {
  const ch = a.callHint || {}
  console.log(`  agentId:          ${a.agentId}`)
  console.log(`  name:             ${a.name || '—'}`)
  console.log(`  capabilities:     ${a.capabilities?.join(', ')}`)
  console.log(`  taskType:         ${ch.taskType || '—'}`)
  console.log(`  expectedLatency:  ${ch.expectedLatencyMs ? ch.expectedLatencyMs + 'ms' : '—'}`)
  console.log(`  supportsAsync:    ${ch.supportsAsync}`)
  console.log(`  streamId:         ${ch.streamId}`)
}

function printResult(label, result) {
  sep(`Result: ${label}`)
  console.log(`  status:           ${result.status}`)
  console.log(`  durationMs:       ${result.meta.durationMs}`)
  console.log(`  taskId:           ${result.taskId}`)
  if (result.error) {
    console.log(`  error:            ${result.error}`)
  } else {
    console.log(`\n  output:`)
    console.log(JSON.stringify(result.output, null, 4).split('\n').map(l => '  ' + l).join('\n'))
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

sep('SavantDex Demo Requester')
console.log('Registry:', REGISTRY_URL)
console.log('Initializing requester agent...')

// skipRegister: stream already exists; owner key shared with workers so no
// public PUBLISH needed — workers sign as owner and can publish replies.
const requester = await SavantDexRequester.create({ ...agentConfig, skipRegister: true })

// ─── Step 1: Discovery ────────────────────────────────────────────────────────

sep('Step 1 — Discovery')
console.log('findAgents({ capability: "token-risk" })')
const tokenRiskAgents = await requester.findAgents({ capability: 'token-risk' })
console.log(`\nFound ${tokenRiskAgents.length} agent(s):\n`)
tokenRiskAgents.forEach(printAgent)

console.log('\nfindAgents({ capability: "wallet-profiling" })')
const walletAgents = await requester.findAgents({ capability: 'wallet-profiling' })
console.log(`\nFound ${walletAgents.length} agent(s):\n`)
walletAgents.forEach(printAgent)

// ─── Step 2: Agent Card ───────────────────────────────────────────────────────

sep('Step 2 — Agent Card (token-risk-screener-v1)')
const card = await requester.getCard('token-risk-screener-v1')
console.log(`  schemaVersion:  ${card.schemaVersion}`)
console.log(`  id:             ${card.id}`)
console.log(`  version:        ${card.version}`)
console.log(`  provider:       ${card.provider.ownerAddress}`)
console.log(`  capabilities:   streaming=${card.capabilities.streaming} async=${card.capabilities.async}`)
console.log(`  skills[0].id:   ${card.skills[0]?.id}`)
console.log(`  invocation:     protocol=${card.invocation.protocol} taskType=${card.invocation.taskType}`)
console.log(`  inputSchema:`)
card.skills[0]?.inputSchema?.forEach(f =>
  console.log(`    - ${f.key} (${f.type})${f.required ? ' *required' : ''}`)
)

// ─── Step 3: Call token-risk-screener ─────────────────────────────────────────

sep('Step 3 — run token-risk-screener-v1')
const TOKEN = '0x6982508145454Ce325dDbE47a25d4ec3d2311933' // PEPE
console.log(`  input: { token: "${TOKEN}" }`)
console.log('  calling...')

const riskResult = await requester.run(
  tokenRiskAgents[0],
  { token: TOKEN },
  { timeout: 30000 }
)
printResult('token-risk-screener-v1', riskResult)

// ─── Step 4: Call wallet-intelligence ────────────────────────────────────────

sep('Step 4 — run wallet-intelligence-v1')
const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' // vitalik.eth
console.log(`  input: { address: "${WALLET}" }`)
console.log('  calling...')

const walletResult = await requester.run(
  walletAgents[0],
  { address: WALLET },
  { timeout: 45000 }
)
printResult('wallet-intelligence-v1', walletResult)

// ─── Done ─────────────────────────────────────────────────────────────────────

sep('Done')
console.log(`  token-risk:         ${riskResult.status}  (${riskResult.meta.durationMs}ms)`)
console.log(`  wallet-intelligence: ${walletResult.status}  (${walletResult.meta.durationMs}ms)`)

await requester.destroy()
process.exit(0)
