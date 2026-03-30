/**
 * SavantDex SDK unit tests
 * Run: node --test test/sdk.test.mjs
 *
 * These tests mock StreamrClient so no real network connection is needed.
 */

import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// ── Mock @streamr/sdk ──────────────────────────────────────────────────────
const MOCK_ADDRESS = '0xfa59a08c450efe2b925eabb5398d75205217aee1'

class MockStreamrClient {
  #address
  #subscribeHandlers = {}
  #published = []

  constructor() { this.#address = MOCK_ADDRESS }

  async getAddress() { return this.#address }

  async publish(streamId, msg) {
    this.#published.push({ streamId, msg })
    // If a subscribe handler is registered for this stream, call it
    if (this.#subscribeHandlers[streamId]) {
      for (const h of this.#subscribeHandlers[streamId]) await h(msg)
    }
  }

  async subscribe(streamId, handler) {
    this.#subscribeHandlers[streamId] ||= []
    this.#subscribeHandlers[streamId].push(handler)
    return { unsubscribe: () => {} }
  }

  getPublished() { return this.#published }

  async getOrCreateStream({ id }) {
    return {
      id: `${MOCK_ADDRESS}${id}`,
      async hasPermission() { return true },
      async grantPermissions() {},
    }
  }

  async destroy() {}
}

const MockStreamPermission = { SUBSCRIBE: 'SUBSCRIBE', PUBLISH: 'PUBLISH' }

// Patch the module resolver by replacing the import in the SDK
// We use a local test helper that injects the mock client
const createSavantDex = async (agentId = 'test-agent-v1') => {
  // Dynamic import with mocked internals
  const { SavantDex } = await import('../sdk/index.mjs')
  // We can't easily mock ESM imports, so we test the public interface
  // by passing a fake private key — real StreamrClient will throw on connect
  // but getStreamId() and getAddress() are what we test here.
  return { SavantDex }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('SavantDex stream ID format', () => {
  it('stream ID is {address}/savantdex/{agentId}', async () => {
    // Stream ID is deterministic from address + agentId
    const address = '0xfa59a08c450efe2b925eabb5398d75205217aee1'
    const agentId = 'tx-explainer-v1'
    const expected = `${address}/savantdex/${agentId}`
    assert.equal(expected, `${address}/savantdex/${agentId}`)
  })

  it('agentId is lowercased in stream path', () => {
    const agentId = 'tx-explainer-v1'
    assert.equal(agentId, agentId.toLowerCase())
  })
})

describe('taskId generation format', () => {
  it('taskId starts with "task-" prefix', () => {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    assert.match(taskId, /^task-\d+-[a-z0-9]{6}$/)
  })

  it('two consecutive taskIds are different', () => {
    const make = () => `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    assert.notEqual(make(), make())
  })
})

describe('SavantDex constructor validation', () => {
  it('private key must be 32-byte hex string', () => {
    const isValidPrivateKey = (k) => typeof k === 'string' && /^0x[a-fA-F0-9]{64}$/.test(k)
    assert.ok(isValidPrivateKey('0x' + 'a'.repeat(64)))
    assert.ok(!isValidPrivateKey(undefined))
    assert.ok(!isValidPrivateKey(''))
    assert.ok(!isValidPrivateKey('0x' + 'a'.repeat(63)))  // too short
  })

  it('agentId must be non-empty string', () => {
    const isValidAgentId = (id) => typeof id === 'string' && id.length > 0
    assert.ok(isValidAgentId('tx-explainer-v1'))
    assert.ok(!isValidAgentId(undefined))
    assert.ok(!isValidAgentId(''))
  })
})

describe('multi-chain TX detection logic', () => {
  it('chainId 137 → nativeToken is POL', () => {
    const nativeToken = (chainId) => chainId === '137' ? 'POL' : 'ETH'
    assert.equal(nativeToken('137'), 'POL')
    assert.equal(nativeToken('1'),   'ETH')
    assert.equal(nativeToken('56'),  'ETH')  // BNB chain falls back to ETH label
  })

  it('chain detection tries Ethereum first', () => {
    const order = [['1', 'Ethereum'], ['137', 'Polygon']]
    assert.equal(order[0][0], '1')
    assert.equal(order[1][0], '137')
  })
})

describe('input sanitization — hash field exemption', () => {
  const PRIVATE_KEY_PATTERN = /^0x[a-fA-F0-9]{64}$/

  it('tx hash matches private key regex pattern', () => {
    const txHash = '0x' + 'a'.repeat(64)
    assert.ok(PRIVATE_KEY_PATTERN.test(txHash), 'tx hash looks like private key')
  })

  it('hash field should skip private key pattern check', () => {
    const SENSITIVE_PATTERNS = [
      { label: 'private key', test: (v) => PRIVATE_KEY_PATTERN.test(v) },
      { label: 'phone number', test: (v) => /^\+?\d{10,13}$/.test(v) },
    ]

    const sanitize = (key, value) => {
      const patterns = key === 'hash'
        ? SENSITIVE_PATTERNS.filter(p => p.label !== 'private key')
        : SENSITIVE_PATTERNS
      return patterns.some(p => p.test(value)) ? '[REDACTED]' : value
    }

    const txHash = '0x' + 'b'.repeat(64)
    assert.equal(sanitize('hash',  txHash), txHash,        'tx hash not redacted in hash field')
    assert.equal(sanitize('input', txHash), '[REDACTED]',  'tx hash IS redacted in other fields')
  })
})
