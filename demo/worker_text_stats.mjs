/**
 * Third-party onboarding dry run — text-stats-v1
 *
 * Written following agent-registration.md only.
 * Purpose: validate that the onboarding docs are complete and accurate.
 *
 * taskType:   analyze-text
 * Input:      { text: string }
 * Output:     { charCount, wordCount, sentenceCount, avgWordLength, readingTimeSec }
 *
 * Zero external dependencies — pure Node.js logic.
 *
 * Run (signer mode):
 *   SIGNER_ADDRESS=0x... SIGNER_PORT=17099 EXTERNAL_IP=... \
 *   REGISTRY_URL=http://localhost:3000 \
 *   node savantdex/demo/worker_text_stats.mjs
 */

import { SavantDex } from '../sdk/index.mjs'
import { RemoteSignerIdentity } from '../sdk/remote-identity.mjs'
import { registerToRegistry } from '../sdk/registry.mjs'

const EXTERNAL_IP    = process.env.EXTERNAL_IP    || '127.0.0.1'
const SIGNER_ADDRESS = process.env.SIGNER_ADDRESS
const SIGNER_PORT    = Number(process.env.SIGNER_PORT || 17099)
const REGISTRY_URL   = process.env.REGISTRY_URL   || 'http://localhost:3000'

if (!SIGNER_ADDRESS && !process.env.PRIVATE_KEY) {
  console.error('[text-stats] Set SIGNER_ADDRESS or PRIVATE_KEY')
  process.exit(1)
}

const workerAuth = SIGNER_ADDRESS
  ? { identity: new RemoteSignerIdentity(SIGNER_ADDRESS, SIGNER_PORT) }
  : { privateKey: process.env.PRIVATE_KEY }

// ── Text analysis logic ───────────────────────────────────────────────────────

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
  // Average reading speed: 200 words/min
  const readingTimeSec = Math.ceil(wordCount / 200 * 60)

  return { charCount, wordCount, sentenceCount, avgWordLength, readingTimeSec }
}

// ── Agent setup ───────────────────────────────────────────────────────────────

const agent = new SavantDex({
  ...workerAuth,
  agentId: 'text-stats-v1',
  network: { websocketPort: 32208, externalIp: EXTERNAL_IP },
})

await agent.register()

await registerToRegistry(agent, process.env.PRIVATE_KEY || null, {
  registryUrl:  REGISTRY_URL,
  capabilities: ['text-analysis', 'nlp'],
  description:  'Counts words, sentences, and characters in any text. Returns reading time estimate.',
  name:         'Text Stats',
  category:     'nlp',
  taskType:     'analyze-text',
  protocolVersion:   '1.0',
  supportsAsync:     false,
  expectedLatencyMs: 200,
  authType:          'none',
  pricingModel:      { type: 'free' },
  inputSchema: [
    { key: 'text', label: 'Text', type: 'textarea', required: true,
      placeholder: 'Paste any text here', hint: 'Plain text, any length' },
  ],
  outputSchema: [
    { key: 'charCount',     type: 'number', description: 'Total character count' },
    { key: 'wordCount',     type: 'number', description: 'Total word count' },
    { key: 'sentenceCount', type: 'number', description: 'Number of sentences' },
    { key: 'avgWordLength', type: 'number', description: 'Average word length in characters' },
    { key: 'readingTimeSec',type: 'number', description: 'Estimated reading time in seconds (200 wpm)' },
  ],
  exampleInput:  { text: 'The quick brown fox jumps over the lazy dog.' },
  exampleOutput: { charCount: 44, wordCount: 9, sentenceCount: 1, avgWordLength: 3.9, readingTimeSec: 3 },
  ...(SIGNER_ADDRESS ? { signerUrl: `http://127.0.0.1:${SIGNER_PORT}` } : {}),
}).catch(e => console.warn('[registry] Registration warning:', e.message))

console.log('\n=== SavantDex Worker - Text Stats ===')
console.log('Stream:', await agent.getStreamId())
console.log('Waiting for tasks...\n')

await agent.onTask(async (task, reply) => {
  if (task.type !== 'analyze-text') {
    return reply({ error: `Unknown task type: ${task.type}` })
  }

  const text = task.input?.text
  if (typeof text !== 'string' || !text.trim()) {
    return reply({ error: 'text is required and must be a non-empty string' })
  }

  const result = analyzeText(text)
  console.log(`[text-stats] analyzed: ${result.wordCount} words, ${result.sentenceCount} sentences`)
  await reply(result)
})
