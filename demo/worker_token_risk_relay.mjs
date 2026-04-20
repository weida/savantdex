/**
 * Token Risk Screener — Relay Mode
 *
 * Same logic as worker_token_risk.mjs but connects via WebSocket relay
 * instead of running a Streamr P2P node.
 *
 * Required env:
 *   PRIVATE_KEY       Owner private key for the registered agent
 *
 * Optional env:
 *   GATEWAY_WS_URL    Default: wss://savantdex.weicao.dev/ws/agent
 *   AGENT_ID          Default: token-risk-screener-v1
 *
 * Setup:
 *   1. Generate a key and register the agent:
 *      node -e "import('ethers').then(e => console.log(e.Wallet.createRandom().privateKey))"
 *      → POST /admin/agents/register with ownerAddress + transport:relay
 *
 *   2. Add to pm2 config and start:
 *      PRIVATE_KEY=0x... node savantdex/demo/worker_token_risk_relay.mjs
 */

import { RelayAgent } from '../sdk/relay-agent.mjs'
import { Wallet } from 'ethers'
import { loadSecrets } from '../sdk/secrets.mjs'

const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'wss://savantdex.weicao.dev/ws/agent'
const AGENT_ID       = process.env.AGENT_ID || 'token-risk-screener-v1'

// Prefer age-encrypted secrets file; fall back to PRIVATE_KEY env for local dev.
let _secrets = {}
try { _secrets = await loadSecrets() } catch { /* env-only mode */ }
const PRIVATE_KEY = _secrets.PRIVATE_KEYS?.[AGENT_ID] || process.env.PRIVATE_KEY

if (!PRIVATE_KEY) {
  console.error(`[token-risk-relay] No key for ${AGENT_ID}: set PRIVATE_KEYS.${AGENT_ID} in secrets file or PRIVATE_KEY env`)
  process.exit(1)
}

// ── DexScreener API ──────────────────────────────────────────────────────────

const DEXSCREENER_BASE = 'https://api.dexscreener.com'

const EVM_CHAINS = new Set([
  'ethereum', 'bsc', 'polygon', 'arbitrum', 'optimism', 'avalanche',
  'base', 'fantom', 'cronos', 'gnosis', 'celo', 'moonbeam', 'metis',
  'zksync', 'linea', 'scroll', 'blast', 'mantle', 'mode', 'manta',
])

async function fetchPairs(token) {
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(token)
  const url = isAddress
    ? `${DEXSCREENER_BASE}/latest/dex/tokens/${token}`
    : `${DEXSCREENER_BASE}/latest/dex/search?q=${encodeURIComponent(token)}`

  const res = await fetch(url, {
    headers: { 'User-Agent': 'SavantDex/0.6' },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`DexScreener API error: ${res.status}`)
  const data = await res.json()
  return data.pairs || []
}

function selectBestPair(pairs) {
  if (!pairs.length) return null
  return pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0]
}

function getEvmCandidates(pairs) {
  const evmPairs = pairs.filter(p => EVM_CHAINS.has(p.chainId?.toLowerCase()))
  const seen = new Map()
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

  if (liquidityUsd < 10_000)       flags.push({ flag: 'VERY_LOW_LIQUIDITY',    severity: 'CRITICAL', detail: `$${liquidityUsd.toLocaleString()} liquidity` })
  else if (liquidityUsd < 50_000)  flags.push({ flag: 'LOW_LIQUIDITY',         severity: 'HIGH',     detail: `$${liquidityUsd.toLocaleString()} liquidity` })
  else if (liquidityUsd < 200_000) flags.push({ flag: 'MODERATE_LIQUIDITY',    severity: 'MEDIUM',   detail: `$${liquidityUsd.toLocaleString()} liquidity` })

  if (liquidityUsd > 0 && volumeH24 / liquidityUsd > 50)
    flags.push({ flag: 'ABNORMAL_VOLUME_RATIO', severity: 'HIGH', detail: `Volume/liquidity ratio: ${(volumeH24 / liquidityUsd).toFixed(1)}x` })

  if (Math.abs(priceChange24) > 50)       flags.push({ flag: 'EXTREME_PRICE_MOVE',    severity: 'HIGH',   detail: `${priceChange24 > 0 ? '+' : ''}${priceChange24.toFixed(1)}% in 24h` })
  else if (Math.abs(priceChange24) > 20)  flags.push({ flag: 'HIGH_PRICE_VOLATILITY', severity: 'MEDIUM', detail: `${priceChange24 > 0 ? '+' : ''}${priceChange24.toFixed(1)}% in 24h` })

  if (pairAge !== null && pairAge < 7)       flags.push({ flag: 'NEW_TOKEN',    severity: 'HIGH',   detail: `Pair created ${pairAge} day(s) ago` })
  else if (pairAge !== null && pairAge < 30) flags.push({ flag: 'RECENT_TOKEN', severity: 'MEDIUM', detail: `Pair created ${pairAge} day(s) ago` })

  if (txns24h < 10 && liquidityUsd > 0)
    flags.push({ flag: 'LOW_ACTIVITY', severity: 'MEDIUM', detail: `Only ${txns24h} transactions in 24h` })

  if (marketCap > 0 && fdv / marketCap > 10)
    flags.push({ flag: 'HIGH_FDV_RATIO', severity: 'MEDIUM', detail: `FDV is ${(fdv / marketCap).toFixed(1)}x market cap — large unreleased supply` })

  const sameChainPairs = allPairs.filter(p => p.chainId === pair.chainId)
  if (sameChainPairs.length > 5)
    flags.push({ flag: 'FRAGMENTED_LIQUIDITY', severity: 'LOW', detail: `${sameChainPairs.length} pairs on ${pair.chainId}` })

  const hasCritical = flags.some(f => f.severity === 'CRITICAL')
  const highCount   = flags.filter(f => f.severity === 'HIGH').length
  const mediumCount = flags.filter(f => f.severity === 'MEDIUM').length

  let riskLevel
  if (hasCritical || highCount >= 2)           riskLevel = 'CRITICAL'
  else if (highCount >= 1 || mediumCount >= 3) riskLevel = 'HIGH'
  else if (mediumCount >= 1)                   riskLevel = 'MEDIUM'
  else                                         riskLevel = 'LOW'

  return { flags, riskLevel }
}

function buildSummary(pair, riskLevel, flags) {
  const name     = pair.baseToken?.name   || 'Unknown'
  const symbol   = pair.baseToken?.symbol || '?'
  const chain    = pair.chainId  || 'unknown'
  const dex      = pair.dexId    || 'unknown'
  const price    = pair.priceUsd ? `$${Number(pair.priceUsd).toPrecision(4)}` : 'N/A'
  const liq      = pair.liquidity?.usd ? `$${Math.round(pair.liquidity.usd).toLocaleString()}` : 'N/A'
  const vol24    = pair.volume?.h24      ? `$${Math.round(pair.volume.h24).toLocaleString()}` : 'N/A'
  const mc       = pair.marketCap        ? `$${Math.round(pair.marketCap).toLocaleString()}` : 'N/A'
  const change24 = pair.priceChange?.h24 != null ? `${pair.priceChange.h24 > 0 ? '+' : ''}${pair.priceChange.h24.toFixed(2)}%` : 'N/A'
  const topFlags = flags.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH').map(f => f.flag)
  return [
    `${name} (${symbol}) on ${chain}/${dex}`,
    `Price: ${price} | 24h: ${change24} | Liquidity: ${liq} | Volume 24h: ${vol24} | MCap: ${mc}`,
    `Risk: ${riskLevel}${topFlags.length ? ` — ${topFlags.join(', ')}` : ''}`,
  ].join('\n')
}

// ── Agent setup ──────────────────────────────────────────────────────────────

const signer = new Wallet(PRIVATE_KEY)
console.log(`[token-risk-relay] Owner address: ${signer.address}`)

const agent = new RelayAgent({
  gatewayUrl: GATEWAY_WS_URL,
  signer,
  agentId: AGENT_ID,
})

agent.onTask(async (task) => {
  if (task.taskType !== 'screen-token') {
    return { error: `Unknown task type: ${task.taskType}` }
  }

  const token = task.input?.token?.trim()
  if (!token) return { error: 'token is required' }

  if (!/^0x[0-9a-fA-F]{40}$/.test(token) && !/^[A-Za-z0-9]{2,20}$/.test(token)) {
    return { error: 'token must be a contract address (0x...) or symbol (2-20 chars)' }
  }

  console.log(`[token-risk-relay] Screening: ${token}`)
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(token)

  try {
    const pairs = await fetchPairs(token)
    if (!pairs.length) {
      return { status: 'failed', error: `No pairs found for: ${token}` }
    }

    let best, allPairs

    if (isAddress) {
      allPairs = pairs
      best = selectBestPair(allPairs)
    } else {
      const { evmPairs, uniqueTokens } = getEvmCandidates(pairs)

      if (uniqueTokens.length === 0) {
        return { status: 'failed', error: `No EVM token pairs found for symbol: ${token}. Try using the contract address.` }
      }

      if (uniqueTokens.length > 1) {
        return {
          status: 'needs_disambiguation',
          error: `Multiple EVM token matches found for "${token}". Provide a contract address.`,
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
        }
      }

      const tokenAddr = uniqueTokens[0].baseToken?.address?.toLowerCase()
      allPairs = evmPairs.filter(p => p.baseToken?.address?.toLowerCase() === tokenAddr)
      best = selectBestPair(allPairs)
    }

    const { flags, riskLevel } = analyzeRisk(best, allPairs)
    const summary = buildSummary(best, riskLevel, flags)

    console.log(`  Risk: ${riskLevel} | Flags: ${flags.map(f => f.flag).join(', ') || 'none'}`)

    return {
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
    }
  } catch (err) {
    console.error(`[error] ${err.message}`)
    return { error: err.message }
  }
})

await agent.connect()
console.log(`\n=== SavantDex Worker - Token Risk Screener (Relay Mode) ===`)
console.log(`Gateway: ${GATEWAY_WS_URL}`)
console.log(`Agent:   ${AGENT_ID}`)
console.log('Waiting for tasks...\n')
