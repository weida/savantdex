/**
 * SavantDex Worker - Wallet Intelligence
 * Structured on-chain wallet profiling: holdings, behavior, DeFi exposure, risk.
 * Replaces wallet-analyst-v1 with richer structured output.
 *
 * Handles task type: 'profile-wallet'
 * Input:  { address: '0x...' }
 * Output: { address, ethBalance, tokens, behavior, defi, risk, label, summary }
 *
 * Key model: signer mode (no private key in process)
 * Required env (signer mode):
 *   SIGNER_ADDRESS, SIGNER_PORT
 * Legacy fallback:
 *   KEYSTORE_PATH, KEYSTORE_PASSWORD (or SECRETS_PATH + AGE_IDENTITY_PATH)
 */

import { SavantDex } from '../sdk/index.mjs'
import { RemoteSignerIdentity } from '../sdk/remote-identity.mjs'
import { loadSecrets } from '../sdk/secrets.mjs'
import { loadPrivateKey } from '../sdk/keystore.mjs'
import { registerToRegistry } from '../sdk/registry.mjs'
import OpenAI from 'openai'

const DEEPSEEK_KEY   = process.env.DEEPSEEK_API_KEY
const ETHERSCAN_KEY  = process.env.ETHERSCAN_API_KEY
const EXTERNAL_IP    = process.env.EXTERNAL_IP    || '127.0.0.1'
const SIGNER_ADDRESS = process.env.SIGNER_ADDRESS
const SIGNER_PORT    = Number(process.env.SIGNER_PORT || 17099)

if (!DEEPSEEK_KEY)  { console.error('Missing DEEPSEEK_API_KEY');  process.exit(1) }
if (!ETHERSCAN_KEY) { console.error('Missing ETHERSCAN_API_KEY'); process.exit(1) }

// --- Auth ---
let workerAuth, ownerPrivateKey, registrySignerUrl
if (SIGNER_ADDRESS) {
  console.log(`[wallet-intelligence] Using remote signer: ${SIGNER_ADDRESS} on port ${SIGNER_PORT}`)
  workerAuth = { identity: new RemoteSignerIdentity(SIGNER_ADDRESS, SIGNER_PORT) }
  registrySignerUrl = `http://127.0.0.1:${SIGNER_PORT}`
} else {
  console.warn('[wallet-intelligence] SIGNER_ADDRESS not set — falling back to local keystore (legacy mode)')
  const { KEYSTORE_PASSWORD } = await loadSecrets()
  ownerPrivateKey = await loadPrivateKey(KEYSTORE_PASSWORD)
  workerAuth = { privateKey: ownerPrivateKey }
}

const deepseek = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: 'https://api.deepseek.com' })

// --- Etherscan data layer ---

const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api'

async function etherscan(params) {
  const url = new URL(ETHERSCAN_BASE)
  url.searchParams.set('chainid', '1')
  url.searchParams.set('apikey', ETHERSCAN_KEY)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(12000) })
  const data = await res.json()
  if (data.status === '0' && data.message !== 'No transactions found') {
    throw new Error(`Etherscan: ${data.message} — ${data.result}`)
  }
  return data.result
}

async function fetchWalletData(address) {
  const [ethBalance, txList, tokenTx, nftTx, internalTx] = await Promise.allSettled([
    etherscan({ module: 'account', action: 'balance', address, tag: 'latest' }),
    etherscan({ module: 'account', action: 'txlist', address, startblock: '0', endblock: '99999999', page: '1', offset: '50', sort: 'desc' }),
    etherscan({ module: 'account', action: 'tokentx', address, page: '1', offset: '50', sort: 'desc' }),
    etherscan({ module: 'account', action: 'tokennfttx', address, page: '1', offset: '20', sort: 'desc' }),
    etherscan({ module: 'account', action: 'txlistinternal', address, page: '1', offset: '20', sort: 'desc' }),
  ])

  return {
    ethBalance:  ethBalance.status  === 'fulfilled' ? ethBalance.value  : '0',
    txList:      txList.status      === 'fulfilled' && Array.isArray(txList.value)      ? txList.value      : [],
    tokenTx:     tokenTx.status     === 'fulfilled' && Array.isArray(tokenTx.value)     ? tokenTx.value     : [],
    nftTx:       nftTx.status       === 'fulfilled' && Array.isArray(nftTx.value)       ? nftTx.value       : [],
    internalTx:  internalTx.status  === 'fulfilled' && Array.isArray(internalTx.value)  ? internalTx.value  : [],
  }
}

// --- Structured extraction ---

function extractProfile(address, data) {
  const addr = address.toLowerCase()

  // ETH balance
  const ethWei = BigInt(data.ethBalance || '0')
  const ethBalance = Number(ethWei) / 1e18

  // Token holdings (unique tokens, last seen balance direction)
  const tokenMap = {}
  for (const tx of data.tokenTx) {
    const sym = tx.tokenSymbol || '?'
    if (!tokenMap[sym]) tokenMap[sym] = { symbol: sym, name: tx.tokenName, txCount: 0, lastSeen: 0 }
    tokenMap[sym].txCount++
    const ts = Number(tx.timeStamp)
    if (ts > tokenMap[sym].lastSeen) tokenMap[sym].lastSeen = ts
  }
  const tokens = Object.values(tokenMap)
    .sort((a, b) => b.txCount - a.txCount)
    .slice(0, 15)

  // NFT activity
  const nftContracts = new Set(data.nftTx.map(t => t.contractAddress))
  const nftTxCount = data.nftTx.length

  // Transaction behavior
  const txList = data.txList
  const outTx  = txList.filter(t => t.from?.toLowerCase() === addr)
  const inTx   = txList.filter(t => t.to?.toLowerCase()   === addr)
  const contractCalls = outTx.filter(t => t.input && t.input !== '0x')
  const uniqueContracts = new Set(contractCalls.map(t => t.to?.toLowerCase()).filter(Boolean))

  const firstTs   = txList.length ? Number(txList[txList.length - 1].timeStamp) : null
  const lastTs    = txList.length ? Number(txList[0].timeStamp) : null
  const firstSeen = firstTs ? new Date(firstTs * 1000).toISOString().slice(0, 10) : null
  const lastActive = lastTs ? new Date(lastTs * 1000).toISOString().slice(0, 10) : null

  // Days active
  const daysActive = (firstTs && lastTs && lastTs > firstTs)
    ? Math.ceil((lastTs - firstTs) / 86400)
    : null

  // ETH flow (recent 50 tx)
  let ethIn = 0, ethOut = 0
  for (const tx of txList) {
    const val = Number(tx.value) / 1e18
    if (tx.from?.toLowerCase() === addr) ethOut += val
    else ethIn += val
  }

  // Internal ETH (DeFi protocols often use internal transfers)
  const hasInternalTx = data.internalTx.length > 0

  // Behavior classification
  const behavior = {
    totalTx:         txList.length,
    outgoingTx:      outTx.length,
    incomingTx:      inTx.length,
    contractCalls:   contractCalls.length,
    uniqueContracts: uniqueContracts.size,
    ethInbound:      parseFloat(ethIn.toFixed(4)),
    ethOutbound:     parseFloat(ethOut.toFixed(4)),
    nftTxCount,
    nftContracts:    nftContracts.size,
    hasInternalTx,
    firstSeen,
    lastActive,
    daysActive,
  }

  // DeFi exposure signals (heuristic — no on-chain label lookup)
  const defiSignals = []
  if (uniqueContracts.size > 5)  defiSignals.push('multi-protocol')
  if (hasInternalTx)             defiSignals.push('internal-transfers')
  if (nftContracts.size > 2)     defiSignals.push('nft-active')
  if (tokens.length > 10)        defiSignals.push('token-diverse')
  if (contractCalls.length > 10) defiSignals.push('contract-heavy')

  // Risk signals
  const riskSignals = []
  if (ethBalance === 0 && txList.length === 0) riskSignals.push('empty-wallet')
  if (daysActive !== null && daysActive < 7 && txList.length > 10) riskSignals.push('high-velocity-new')
  if (tokens.some(t => t.txCount > 20 && t.symbol === t.symbol.toUpperCase() && t.symbol.length > 8)) {
    riskSignals.push('possible-spam-token')
  }

  return {
    ethBalance: parseFloat(ethBalance.toFixed(6)),
    tokens,
    behavior,
    defiSignals,
    riskSignals,
  }
}

// --- AI labeling (structured JSON output) ---

async function labelWallet(address, profile) {
  const prompt = `You are a professional blockchain analyst. Based on the following on-chain data, return a JSON object with exactly these fields:

{
  "label": one of: "Newcomer" | "Casual User" | "Active Trader" | "DeFi Power User" | "NFT Collector" | "Institutional" | "Bot/Script",
  "behaviorSummary": string (1 sentence, max 30 words — describe main on-chain activity),
  "defiExposure": "none" | "low" | "medium" | "high",
  "riskNote": string or null (1 sentence if any risk pattern, otherwise null)
}

Wallet: ${address}
ETH Balance: ${profile.ethBalance} ETH
Token types: ${profile.tokens.length} (top: ${profile.tokens.slice(0,5).map(t=>t.symbol).join(', ') || 'none'})
Transactions (sample 50): ${profile.behavior.totalTx} total, ${profile.behavior.contractCalls} contract calls, ${profile.behavior.uniqueContracts} unique contracts
NFT activity: ${profile.behavior.nftTxCount} NFT txns across ${profile.behavior.nftContracts} contracts
Account age: ${profile.behavior.firstSeen || 'unknown'} → ${profile.behavior.lastActive || 'unknown'} (${profile.behavior.daysActive ?? '?'} days)
DeFi signals: ${profile.defiSignals.join(', ') || 'none'}
Risk signals: ${profile.riskSignals.join(', ') || 'none'}

Return only valid JSON, no explanation.`

  const res = await deepseek.chat.completions.create({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'You are a blockchain data analyst. Always respond with valid JSON only.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 200,
    temperature: 0.2,
  })

  const raw = res.choices[0].message.content.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '')

  try {
    return JSON.parse(raw)
  } catch {
    return { label: 'Unknown', behaviorSummary: raw.slice(0, 100), defiExposure: 'unknown', riskNote: null }
  }
}

// --- Agent ---

const agent = new SavantDex({
  ...workerAuth,
  agentId: 'wallet-intelligence-v1',
  network: { websocketPort: 32231, websocketPortMax: 32241, externalIp: EXTERNAL_IP }
})

await agent.register()
await registerToRegistry(agent, ownerPrivateKey || null, {
  registryUrl: process.env.REGISTRY_URL || 'http://localhost:3000',
  capabilities: ['wallet-profiling', 'defi-analysis', 'on-chain-intelligence'],
  description: 'Structured on-chain wallet profiling: ETH/token holdings, behavior classification, DeFi exposure, and risk signals. Returns machine-readable JSON.',
  name: 'Wallet Intelligence',
  category: 'blockchain',
  exampleInput:  { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' },
  exampleOutput: {
    label: 'DeFi Power User',
    behaviorSummary: 'Active multi-protocol DeFi user with diverse token portfolio and frequent contract interactions.',
    defiExposure: 'high',
    ethBalance: 1234.5,
    tokens: [{ symbol: 'USDC', txCount: 42 }],
  },
  inputSchema: [
    { key: 'address', label: 'Ethereum Address', type: 'text', required: true,
      placeholder: '0x...', hint: 'Any EVM-compatible wallet address' }
  ],
  outputSchema: [
    { key: 'address',         type: 'string',  description: 'Queried wallet address' },
    { key: 'ethBalance',      type: 'number',  description: 'ETH balance in ETH units' },
    { key: 'tokens',          type: 'array',   description: 'Top token interactions: [{ symbol, name, txCount, lastSeen }]' },
    { key: 'behavior',        type: 'object',  description: 'On-chain activity metrics: totalTx, contractCalls, uniqueContracts, nftTxCount, firstSeen, lastActive, daysActive, ethInbound, ethOutbound' },
    { key: 'defiSignals',     type: 'array',   description: 'Observed DeFi/NFT activity signals' },
    { key: 'riskSignals',     type: 'array',   description: 'Risk pattern signals (empty = clean)' },
    { key: 'label',           type: 'string',  description: 'Wallet classification: Newcomer | Casual User | Active Trader | DeFi Power User | NFT Collector | Institutional | Bot/Script' },
    { key: 'behaviorSummary', type: 'string',  description: 'One-sentence behavior description' },
    { key: 'defiExposure',    type: 'string',  description: 'none | low | medium | high' },
    { key: 'riskNote',        type: 'string',  description: 'Risk observation or null' },
  ],
  taskType:          'profile-wallet',
  protocolVersion:   '1.0',
  supportsAsync:     false,
  expectedLatencyMs: 15000,
  authType:          'none',
  pricingModel:      { type: 'free' },
  ...(registrySignerUrl ? { signerUrl: registrySignerUrl } : {}),
}).catch(e => console.warn('[registry] Registration skipped:', e.message))

console.log('\n=== SavantDex Worker - Wallet Intelligence ===')
console.log('Stream:', await agent.getStreamId())
console.log('Waiting for tasks...\n')

await agent.onTask(async (task, reply) => {
  if (task.type !== 'profile-wallet') {
    return reply({ error: `Unknown task type: ${task.type}. Use 'profile-wallet'.` })
  }

  const address = task.input?.address?.trim()
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return reply({ error: 'Invalid Ethereum address' })
  }

  console.log(`[wallet-intelligence] Profiling: ${address}`)

  try {
    const data    = await fetchWalletData(address)
    const profile = extractProfile(address, data)
    const ai      = await labelWallet(address, profile)

    console.log(`  Label: ${ai.label} | DeFi: ${ai.defiExposure} | ETH: ${profile.ethBalance}`)
    if (ai.riskNote) console.log(`  Risk: ${ai.riskNote}`)

    await reply({
      address,
      ethBalance:      profile.ethBalance,
      tokens:          profile.tokens,
      behavior:        profile.behavior,
      defiSignals:     profile.defiSignals,
      riskSignals:     profile.riskSignals,
      label:           ai.label,
      behaviorSummary: ai.behaviorSummary,
      defiExposure:    ai.defiExposure,
      riskNote:        ai.riskNote,
    })
  } catch (err) {
    console.error(`[error] ${err.message}`)
    await reply({ error: err.message })
  }
})
