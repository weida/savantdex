/**
 * SavantDex Worker - Token Risk Screener
 * Fetches on-chain market data via DexScreener, outputs structured risk assessment.
 * No API key required (DexScreener public API).
 *
 * Handles task type: 'screen-token'
 * Input:  { token: '0x...' | 'SYMBOL' }
 * Output: { tokenInfo, marketData, riskFlags, riskLevel, summary }
 *
 * Risk levels: LOW / MEDIUM / HIGH / CRITICAL
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

const EXTERNAL_IP    = process.env.EXTERNAL_IP    || '127.0.0.1'
const SIGNER_ADDRESS = process.env.SIGNER_ADDRESS
const SIGNER_PORT    = Number(process.env.SIGNER_PORT || 17099)

// --- Auth ---
let workerAuth, ownerPrivateKey, registrySignerUrl
if (SIGNER_ADDRESS) {
  console.log(`[token-risk] Using remote signer: ${SIGNER_ADDRESS} on port ${SIGNER_PORT}`)
  workerAuth = { identity: new RemoteSignerIdentity(SIGNER_ADDRESS, SIGNER_PORT) }
  registrySignerUrl = `http://127.0.0.1:${SIGNER_PORT}`
} else {
  console.warn('[token-risk] SIGNER_ADDRESS not set — falling back to local keystore (legacy mode)')
  const { KEYSTORE_PASSWORD } = await loadSecrets()
  ownerPrivateKey = await loadPrivateKey(KEYSTORE_PASSWORD)
  workerAuth = { privateKey: ownerPrivateKey }
}

// --- DexScreener API ---

const DEXSCREENER_BASE = 'https://api.dexscreener.com'

// EVM chain allowlist — excludes Solana, Aptos, Sui, NEAR, Tron, TON, etc.
const EVM_CHAINS = new Set([
  'ethereum', 'bsc', 'polygon', 'arbitrum', 'optimism', 'avalanche',
  'base', 'fantom', 'cronos', 'gnosis', 'celo', 'moonbeam', 'metis',
  'zksync', 'linea', 'scroll', 'blast', 'mantle', 'mode', 'manta',
])

async function fetchPairs(token) {
  // Supports both contract address and symbol search
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(token)
  const url = isAddress
    ? `${DEXSCREENER_BASE}/latest/dex/tokens/${token}`
    : `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(token)}`

  const res = await fetch(url, {
    headers: { 'User-Agent': 'SavantDex/0.4' },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`DexScreener API error: ${res.status}`)
  const data = await res.json()
  return data.pairs || []
}

function selectBestPair(pairs) {
  if (!pairs.length) return null
  // Prefer highest liquidity pair
  return pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
}

// Filter to EVM-only pairs, then deduplicate by base token address.
// Returns unique token representatives (one pair per unique contract address).
function getEvmCandidates(pairs) {
  const evmPairs = pairs.filter(p => EVM_CHAINS.has(p.chainId?.toLowerCase()))
  const seen = new Map() // `chain:address` -> best liquidity pair for that token
  for (const pair of evmPairs) {
    const addr  = pair.baseToken?.address?.toLowerCase()
    const chain = pair.chainId?.toLowerCase()
    if (!addr || !chain) continue
    const key = `${chain}:${addr}`
    if (!seen.has(key) || (pair.liquidity?.usd || 0) > (seen.get(key).liquidity?.usd || 0)) {
      seen.set(key, pair)
    }
  }
  return { evmPairs, uniqueTokens: Array.from(seen.values()) }
}

function analyzeRisk(pair, allPairs) {
  const flags = []

  const liquidityUsd  = pair.liquidity?.usd || 0
  const volumeH24     = pair.volume?.h24 || 0
  const priceChange24 = pair.priceChange?.h24 || 0
  const fdv           = pair.fdv || 0
  const marketCap     = pair.marketCap || 0
  const txns24h       = (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0)
  const pairAge       = pair.pairCreatedAt
    ? Math.floor((Date.now() - pair.pairCreatedAt) / 86400000)
    : null

  // Liquidity checks
  if (liquidityUsd < 10_000)  flags.push({ flag: 'VERY_LOW_LIQUIDITY',  severity: 'CRITICAL', detail: `$${liquidityUsd.toLocaleString()} liquidity` })
  else if (liquidityUsd < 50_000) flags.push({ flag: 'LOW_LIQUIDITY',   severity: 'HIGH',     detail: `$${liquidityUsd.toLocaleString()} liquidity` })
  else if (liquidityUsd < 200_000) flags.push({ flag: 'MODERATE_LIQUIDITY', severity: 'MEDIUM', detail: `$${liquidityUsd.toLocaleString()} liquidity` })

  // Volume / liquidity ratio (wash trading signal)
  if (liquidityUsd > 0 && volumeH24 / liquidityUsd > 50) {
    flags.push({ flag: 'ABNORMAL_VOLUME_RATIO', severity: 'HIGH', detail: `Volume/liquidity ratio: ${(volumeH24 / liquidityUsd).toFixed(1)}x` })
  }

  // Price volatility
  if (Math.abs(priceChange24) > 50)  flags.push({ flag: 'EXTREME_PRICE_MOVE',  severity: 'HIGH',   detail: `${priceChange24 > 0 ? '+' : ''}${priceChange24.toFixed(1)}% in 24h` })
  else if (Math.abs(priceChange24) > 20) flags.push({ flag: 'HIGH_PRICE_VOLATILITY', severity: 'MEDIUM', detail: `${priceChange24 > 0 ? '+' : ''}${priceChange24.toFixed(1)}% in 24h` })

  // New token
  if (pairAge !== null && pairAge < 7)  flags.push({ flag: 'NEW_TOKEN',    severity: 'HIGH',   detail: `Pair created ${pairAge} day(s) ago` })
  else if (pairAge !== null && pairAge < 30) flags.push({ flag: 'RECENT_TOKEN', severity: 'MEDIUM', detail: `Pair created ${pairAge} day(s) ago` })

  // Low transaction activity
  if (txns24h < 10 && liquidityUsd > 0) flags.push({ flag: 'LOW_ACTIVITY', severity: 'MEDIUM', detail: `Only ${txns24h} transactions in 24h` })

  // FDV/MarketCap ratio (high inflation risk)
  if (marketCap > 0 && fdv / marketCap > 10) {
    flags.push({ flag: 'HIGH_FDV_RATIO', severity: 'MEDIUM', detail: `FDV is ${(fdv / marketCap).toFixed(1)}x market cap — large unreleased supply` })
  }

  // Multiple pairs on same chain (fragmented liquidity)
  const sameChainPairs = allPairs.filter(p => p.chainId === pair.chainId)
  if (sameChainPairs.length > 5) {
    flags.push({ flag: 'FRAGMENTED_LIQUIDITY', severity: 'LOW', detail: `${sameChainPairs.length} pairs on ${pair.chainId}` })
  }

  // Determine overall risk level
  const hasCritical = flags.some(f => f.severity === 'CRITICAL')
  const highCount   = flags.filter(f => f.severity === 'HIGH').length
  const mediumCount = flags.filter(f => f.severity === 'MEDIUM').length

  let riskLevel
  if (hasCritical || highCount >= 2)        riskLevel = 'CRITICAL'
  else if (highCount >= 1 || mediumCount >= 3) riskLevel = 'HIGH'
  else if (mediumCount >= 1)                   riskLevel = 'MEDIUM'
  else                                          riskLevel = 'LOW'

  return { flags, riskLevel }
}

function buildSummary(pair, riskLevel, flags) {
  const name     = pair.baseToken?.name  || 'Unknown'
  const symbol   = pair.baseToken?.symbol || '?'
  const chain    = pair.chainId || 'unknown'
  const dex      = pair.dexId   || 'unknown'
  const price    = pair.priceUsd ? `$${Number(pair.priceUsd).toPrecision(4)}` : 'N/A'
  const liq      = pair.liquidity?.usd ? `$${Math.round(pair.liquidity.usd).toLocaleString()}` : 'N/A'
  const vol24    = pair.volume?.h24    ? `$${Math.round(pair.volume.h24).toLocaleString()}` : 'N/A'
  const mc       = pair.marketCap      ? `$${Math.round(pair.marketCap).toLocaleString()}` : 'N/A'
  const change24 = pair.priceChange?.h24 != null ? `${pair.priceChange.h24 > 0 ? '+' : ''}${pair.priceChange.h24.toFixed(2)}%` : 'N/A'

  const topFlags = flags.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH').map(f => f.flag)

  return [
    `${name} (${symbol}) on ${chain}/${dex}`,
    `Price: ${price} | 24h: ${change24} | Liquidity: ${liq} | Volume 24h: ${vol24} | MCap: ${mc}`,
    `Risk: ${riskLevel}${topFlags.length ? ` — ${topFlags.join(', ')}` : ''}`,
  ].join('\n')
}

// --- Agent ---

const agent = new SavantDex({
  ...workerAuth,
  agentId: 'token-risk-screener-v1',
  network: { websocketPort: 32220, websocketPortMax: 32230, externalIp: EXTERNAL_IP }
})

await agent.register()
await registerToRegistry(agent, ownerPrivateKey || null, {
  registryUrl: process.env.REGISTRY_URL || 'http://localhost:3000',
  capabilities: ['token-risk', 'dex-screening', 'defi'],
  description: 'Screens any EVM token for liquidity, volatility, and on-chain risk signals using DexScreener data. No API key required.',
  name: 'Token Risk Screener',
  category: 'blockchain',
  exampleInput:  { token: '0x6982508145454Ce325dDbE47a25d4ec3d2311933' },
  exampleOutput: {
    riskLevel: 'MEDIUM',
    summary: 'PEPE (PEPE) on ethereum/uniswap-v2\nPrice: $0.00001234 | 24h: +5.2% | Liquidity: $2,400,000\nRisk: MEDIUM — MODERATE_LIQUIDITY',
  },
  inputSchema: [
    { key: 'token', label: 'Token Address or Symbol', type: 'text', required: true,
      placeholder: '0x... or PEPE', hint: 'EVM contract address (recommended) or token symbol' }
  ],
  outputSchema: [
    { key: 'status',      type: 'string', description: 'completed | needs_disambiguation | failed (present when not completed)' },
    { key: 'tokenInfo',   type: 'object', description: 'name, symbol, address, chain, dex' },
    { key: 'marketData',  type: 'object', description: 'price, priceChange24h, liquidity, volume24h, marketCap, fdv, txns24h, pairAgeDays' },
    { key: 'riskFlags',   type: 'array',  description: 'array of { flag, severity, detail }' },
    { key: 'riskLevel',   type: 'string', description: 'LOW | MEDIUM | HIGH | CRITICAL' },
    { key: 'summary',     type: 'string', description: 'human-readable one-paragraph summary' },
    { key: 'candidates',  type: 'array',  description: 'present when needs_disambiguation: [{ symbol, name, chain, dex, address, liquidityUsd }]' },
  ],
  taskType:          'screen-token',
  protocolVersion:   '1.0',
  supportsAsync:     false,
  expectedLatencyMs: 5000,
  authType:          'none',
  pricingModel:      { type: 'free' },
  ...(registrySignerUrl ? { signerUrl: registrySignerUrl } : {}),
}).catch(e => console.warn('[registry] Registration skipped:', e.message))

console.log('\n=== SavantDex Worker - Token Risk Screener ===')
console.log('Stream:', await agent.getStreamId())
console.log('Waiting for tasks...\n')

await agent.onTask(async (task, reply) => {
  if (task.type !== 'screen-token') {
    return reply({ error: `Unknown task type: ${task.type}` })
  }

  const token = task.input?.token?.trim()
  if (!token) return reply({ error: 'token is required' })

  // Basic validation: address or 2-20 char symbol
  if (!/^0x[0-9a-fA-F]{40}$/.test(token) && !/^[A-Za-z0-9]{2,20}$/.test(token)) {
    return reply({ error: 'token must be a contract address (0x...) or symbol (2-20 chars)' })
  }

  console.log(`[token-risk] Screening: ${token}`)

  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(token)

  try {
    const pairs = await fetchPairs(token)
    if (!pairs.length) {
      return reply({ status: 'failed', error: `No pairs found for: ${token}` })
    }

    let best, allPairs

    if (isAddress) {
      // Contract address: use all pairs directly (no chain ambiguity)
      allPairs = pairs
      best = selectBestPair(allPairs)
    } else {
      // Symbol: filter to EVM, deduplicate by base token address
      const { evmPairs, uniqueTokens } = getEvmCandidates(pairs)

      if (uniqueTokens.length === 0) {
        return reply({ status: 'failed', error: `No EVM token pairs found for symbol: ${token}. Try using the contract address (token:0x...).` })
      }

      if (uniqueTokens.length > 1) {
        // Ambiguous: multiple distinct EVM tokens share this symbol
        return reply({
          status: 'needs_disambiguation',
          error: `Multiple EVM token matches found for symbol "${token}". Provide a contract address.`,
          candidates: uniqueTokens
            .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
            .map(p => ({
              symbol:       p.baseToken?.symbol,
              name:         p.baseToken?.name,
              chain:        p.chainId,
              dex:          p.dexId,
              address:      p.baseToken?.address,
              liquidityUsd: Math.round(p.liquidity?.usd || 0),
            })),
        })
      }

      // Exactly 1 unique EVM token — use the best pair for that token
      const tokenAddr = uniqueTokens[0].baseToken?.address?.toLowerCase()
      allPairs = evmPairs.filter(p => p.baseToken?.address?.toLowerCase() === tokenAddr)
      best = selectBestPair(allPairs)
    }

    const { flags, riskLevel } = analyzeRisk(best, allPairs)
    const summary = buildSummary(best, riskLevel, flags)

    console.log(`  Risk: ${riskLevel} | Flags: ${flags.map(f => f.flag).join(', ') || 'none'}`)
    console.log(`  Liquidity: $${(best.liquidity?.usd || 0).toLocaleString()}`)

    await reply({
      tokenInfo: {
        name:    best.baseToken?.name,
        symbol:  best.baseToken?.symbol,
        address: best.baseToken?.address,
        chain:   best.chainId,
        dex:     best.dexId,
        pairUrl: best.url,
      },
      marketData: {
        price:          best.priceUsd,
        priceChange24h: best.priceChange?.h24,
        liquidity:      best.liquidity?.usd,
        volume24h:      best.volume?.h24,
        marketCap:      best.marketCap,
        fdv:            best.fdv,
        txns24h:        (best.txns?.h24?.buys || 0) + (best.txns?.h24?.sells || 0),
        pairAgeDays:    best.pairCreatedAt
          ? Math.floor((Date.now() - best.pairCreatedAt) / 86400000)
          : null,
      },
      riskFlags: flags,
      riskLevel,
      summary,
    })
  } catch (err) {
    console.error(`[error] ${err.message}`)
    await reply({ error: err.message })
  }
})
