/**
 * Wallet Intelligence — Relay Mode
 *
 * Same business logic as worker_wallet_intelligence.mjs but connects via
 * WebSocket relay instead of running a Streamr P2P node.
 *
 * Required env:
 *   PRIVATE_KEY         Owner private key for the registered agent
 *   ETHERSCAN_API_KEY   Etherscan v2 API key
 *   DEEPSEEK_API_KEY    Deepseek API key (for structured labeling)
 *
 * Optional env:
 *   GATEWAY_WS_URL      Default: wss://savantdex.weicao.dev/ws/agent
 *   AGENT_ID            Default: wallet-intelligence-v1
 */

import { RelayAgent } from '../sdk/relay-agent.mjs'
import { Wallet } from 'ethers'
import OpenAI from 'openai'
import { loadSecrets } from '../sdk/secrets.mjs'

const GATEWAY_WS_URL   = process.env.GATEWAY_WS_URL || 'wss://savantdex.weicao.dev/ws/agent'
const AGENT_ID         = process.env.AGENT_ID || 'wallet-intelligence-v1'

let _secrets = {}
try { _secrets = await loadSecrets() } catch { /* env-only mode */ }
const PRIVATE_KEY   = _secrets.PRIVATE_KEYS?.[AGENT_ID] || process.env.PRIVATE_KEY
const ETHERSCAN_KEY = _secrets.ETHERSCAN_API_KEY        || process.env.ETHERSCAN_API_KEY
const DEEPSEEK_KEY  = _secrets.DEEPSEEK_API_KEY         || process.env.DEEPSEEK_API_KEY

if (!PRIVATE_KEY)   { console.error(`[wallet-intelligence-relay] No key for ${AGENT_ID}: set PRIVATE_KEYS.${AGENT_ID} in secrets or PRIVATE_KEY env`); process.exit(1) }
if (!ETHERSCAN_KEY) { console.error('[wallet-intelligence-relay] ETHERSCAN_API_KEY required (secrets or env)'); process.exit(1) }
if (!DEEPSEEK_KEY)  { console.error('[wallet-intelligence-relay] DEEPSEEK_API_KEY required (secrets or env)'); process.exit(1) }

const deepseek = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: 'https://api.deepseek.com' })

// ── Etherscan data layer ─────────────────────────────────────────────────────

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

// ── Structured extraction ───────────────────────────────────────────────────

function extractProfile(address, data) {
  const addr = address.toLowerCase()

  const ethWei = BigInt(data.ethBalance || '0')
  const ethBalance = Number(ethWei) / 1e18

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

  const nftContracts = new Set(data.nftTx.map(t => t.contractAddress))
  const nftTxCount = data.nftTx.length

  const txList = data.txList
  const outTx  = txList.filter(t => t.from?.toLowerCase() === addr)
  const inTx   = txList.filter(t => t.to?.toLowerCase()   === addr)
  const contractCalls = outTx.filter(t => t.input && t.input !== '0x')
  const uniqueContracts = new Set(contractCalls.map(t => t.to?.toLowerCase()).filter(Boolean))

  const firstTs   = txList.length ? Number(txList[txList.length - 1].timeStamp) : null
  const lastTs    = txList.length ? Number(txList[0].timeStamp) : null
  const firstSeen = firstTs ? new Date(firstTs * 1000).toISOString().slice(0, 10) : null
  const lastActive = lastTs ? new Date(lastTs * 1000).toISOString().slice(0, 10) : null

  const daysActive = (firstTs && lastTs && lastTs > firstTs)
    ? Math.ceil((lastTs - firstTs) / 86400)
    : null

  let ethIn = 0, ethOut = 0
  for (const tx of txList) {
    const val = Number(tx.value) / 1e18
    if (tx.from?.toLowerCase() === addr) ethOut += val
    else ethIn += val
  }

  const hasInternalTx = data.internalTx.length > 0

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

  const defiSignals = []
  if (uniqueContracts.size > 5)  defiSignals.push('multi-protocol')
  if (hasInternalTx)             defiSignals.push('internal-transfers')
  if (nftContracts.size > 2)     defiSignals.push('nft-active')
  if (tokens.length > 10)        defiSignals.push('token-diverse')
  if (contractCalls.length > 10) defiSignals.push('contract-heavy')

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

// ── Agent setup ──────────────────────────────────────────────────────────────

const signer = new Wallet(PRIVATE_KEY)
console.log(`[wallet-intelligence-relay] Owner address: ${signer.address}`)

const agent = new RelayAgent({
  gatewayUrl: GATEWAY_WS_URL,
  signer,
  agentId: AGENT_ID,
})

agent.onTask(async (task) => {
  if (task.taskType !== 'profile-wallet') {
    return { error: `Unknown task type: ${task.taskType}` }
  }

  const address = task.input?.address?.trim()
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { error: 'Invalid Ethereum address' }
  }

  console.log(`[wallet-intelligence-relay] Profiling: ${address}`)

  try {
    const data    = await fetchWalletData(address)
    const profile = extractProfile(address, data)
    const ai      = await labelWallet(address, profile)

    console.log(`  Label: ${ai.label} | DeFi: ${ai.defiExposure} | ETH: ${profile.ethBalance}`)
    if (ai.riskNote) console.log(`  Risk: ${ai.riskNote}`)

    return {
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
    }
  } catch (err) {
    console.error(`[error] ${err.message}`)
    return { error: err.message }
  }
})

await agent.connect()
console.log(`\n=== SavantDex Worker - Wallet Intelligence (Relay Mode) ===`)
console.log(`Gateway: ${GATEWAY_WS_URL}`)
console.log(`Agent:   ${AGENT_ID}`)
console.log('Waiting for tasks...\n')
