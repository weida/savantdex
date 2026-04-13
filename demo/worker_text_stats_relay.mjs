/**
 * Text Stats — Relay Mode Demo
 *
 * Same logic as worker_text_stats.mjs but connects via WebSocket relay
 * instead of running a full Streamr P2P node.
 *
 * No public IP, no open ports, no Streamr SDK needed.
 *
 * Prerequisites:
 *   - Agent "text-stats-v1" must already be registered in the registry
 *     (via the Streamr-mode worker or manual registration)
 *   - PRIVATE_KEY env var must be the owner key for text-stats-v1
 *
 * Run:
 *   PRIVATE_KEY=0x... \
 *   GATEWAY_WS_URL=wss://savantdex.weicao.dev/ws/agent \
 *   node savantdex/demo/worker_text_stats_relay.mjs
 */

import { RelayAgent } from '../sdk/relay-agent.mjs'
import { Wallet } from 'ethers'

const PRIVATE_KEY    = process.env.PRIVATE_KEY
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'wss://savantdex.weicao.dev/ws/agent'
const AGENT_ID       = process.env.AGENT_ID || 'text-stats-v1'

if (!PRIVATE_KEY) {
  console.error('[text-stats-relay] Set PRIVATE_KEY (owner key for the registered agent)')
  process.exit(1)
}

// ── Text analysis logic (same as Streamr-mode worker) ────────────────────────

function analyzeText(text) {
  const trimmed = text.trim()
  if (!trimmed) return { charCount: 0, wordCount: 0, sentenceCount: 0, avgWordLength: 0, readingTimeSec: 0 }

  const charCount    = trimmed.length
  const words        = trimmed.split(/\s+/).filter(Boolean)
  const wordCount    = words.length
  const sentences    = trimmed.split(/[.!?]+/).filter(s => s.trim().length > 0)
  const sentenceCount = sentences.length
  const avgWordLength = wordCount > 0
    ? Math.round(words.reduce((sum, w) => sum + w.replace(/[^a-zA-Z]/g, '').length, 0) / wordCount * 10) / 10
    : 0
  const readingTimeSec = Math.ceil(wordCount / 200 * 60)

  return { charCount, wordCount, sentenceCount, avgWordLength, readingTimeSec }
}

// ── Agent setup ──────────────────────────────────────────────────────────────

const signer = new Wallet(PRIVATE_KEY)
console.log(`[text-stats-relay] Owner address: ${signer.address}`)

const agent = new RelayAgent({
  gatewayUrl: GATEWAY_WS_URL,
  signer,
  agentId: AGENT_ID,
})

agent.onTask(async (task) => {
  if (task.taskType !== 'analyze-text') {
    return { error: `Unknown task type: ${task.taskType}` }
  }

  const text = task.input?.text
  if (typeof text !== 'string' || !text.trim()) {
    return { error: 'text is required and must be a non-empty string' }
  }

  const result = analyzeText(text)
  console.log(`[text-stats-relay] analyzed: ${result.wordCount} words, ${result.sentenceCount} sentences`)
  return result
})

await agent.connect()
console.log(`\n=== SavantDex Worker - Text Stats (Relay Mode) ===`)
console.log(`Gateway: ${GATEWAY_WS_URL}`)
console.log(`Agent:   ${AGENT_ID}`)
console.log('Waiting for tasks...\n')
