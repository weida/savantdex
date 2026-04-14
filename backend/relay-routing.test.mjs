/**
 * Relay routing integration test
 *
 * Run: node backend/relay-routing.test.mjs
 *
 * Verifies the transport routing decision logic that server.mjs uses:
 *   1. When relay agent is connected → relayTask is used → result returned
 *   2. When relay agent is offline → getRelayStatus returns false
 *   3. Relay result flows through same payment/evidence path shape
 *   4. Task error via relay propagates correctly
 *   5. Concurrent tasks to same relay agent
 *
 * This does NOT spin up the full server.mjs (which requires Streamr P2P).
 * Instead it exercises the relay module functions in the same order and
 * pattern that handleTask uses, confirming the routing contract.
 */

import http from 'http'
import assert from 'assert/strict'
import { Wallet } from 'ethers'
import WebSocket from 'ws'
import { randomBytes } from 'crypto'
import {
  initRelay, getRelayStatus, relayTask, relayAgentCount,
} from './ws-relay.mjs'

const AGENT_ID = 'routing-test-v1'
const wallet = Wallet.createRandom()
const OWNER = wallet.address.toLowerCase()

// ── Fake registry ────────────────────────────────────────────────────────────

const registryServer = http.createServer((req, res) => {
  if (req.url.includes(AGENT_ID)) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ownerAddress: OWNER }))
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  }
})
await new Promise(r => registryServer.listen(0, '127.0.0.1', r))
const REGISTRY_URL = `http://127.0.0.1:${registryServer.address().port}`

// ── Gateway with relay ───────────────────────────────────────────────────────

const gwServer = http.createServer((req, res) => { res.writeHead(404); res.end() })
await new Promise(r => gwServer.listen(0, '127.0.0.1', r))
const GW_PORT = gwServer.address().port
const WS_URL = `ws://127.0.0.1:${GW_PORT}/ws/agent`

initRelay(gwServer, { registryUrl: REGISTRY_URL, heartbeatMs: 5000, authTimeoutMs: 3000 })

// ── Helpers ──────────────────────────────────────────────────────────────────

async function connectAgent(handler) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.on('open', async () => {
      const ts = Date.now()
      const nonce = randomBytes(16).toString('hex')
      const message = `savantdex-relay:${AGENT_ID}:${OWNER}:${ts}:${nonce}`
      const signature = await wallet.signMessage(message)
      ws.send(JSON.stringify({ type: 'auth', agentId: AGENT_ID, ownerAddress: OWNER, timestamp: ts, nonce, signature }))
    })
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'auth_ok') resolve(ws)
      if (msg.type === 'auth_error') reject(new Error(msg.error))
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }))
      if (msg.type === 'task' && handler) handler(msg, ws)
    })
    ws.on('error', reject)
    setTimeout(() => reject(new Error('timeout')), 5000)
  })
}

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`)
    failed++
  }
}

// ── Tests (simulate handleTask routing logic) ────────────────────────────────

console.log('\n=== Relay routing integration tests ===\n')

// 1. Offline agent → getRelayStatus returns { connected: false }
await test('offline agent → routing falls through to Streamr path', async () => {
  const relay = getRelayStatus(AGENT_ID)
  assert.equal(relay.connected, false)
  // In server.mjs, this means the Streamr P2P path would be taken
})

// 2. Online agent → relayTask returns result
await test('online agent → task routed through relay', async () => {
  const ws = await connectAgent((task, socket) => {
    socket.send(JSON.stringify({ type: 'result', taskId: task.taskId, output: { score: 99 } }))
  })

  const relay = getRelayStatus(AGENT_ID)
  assert.ok(relay.connected, 'should be connected')

  // This is what server.mjs does in the relay branch
  const taskId = `task-${randomBytes(16).toString('hex')}`
  const result = await relayTask(AGENT_ID, taskId, 'test-type', { q: 'hello' }, 5000)
  assert.deepEqual(result, { score: 99 })

  ws.close()
  await new Promise(r => setTimeout(r, 200))
})

// 3. Relay error propagates
await test('relay agent error → relayTask rejects with Error', async () => {
  const ws = await connectAgent((task, socket) => {
    socket.send(JSON.stringify({ type: 'result', taskId: task.taskId, error: 'bad input' }))
  })

  try {
    await relayTask(AGENT_ID, 'task-err', 'test-type', {}, 5000)
    assert.fail('should reject')
  } catch (e) {
    assert.equal(e.message, 'bad input')
    // In server.mjs, this catch block runs the same error path as Streamr failures
  }

  ws.close()
  await new Promise(r => setTimeout(r, 200))
})

// 4. Concurrent tasks to same agent
await test('concurrent tasks to same relay agent', async () => {
  const ws = await connectAgent((task, socket) => {
    // Echo back the taskId + input
    const result = { echo: task.input.n }
    setTimeout(() => {
      socket.send(JSON.stringify({ type: 'result', taskId: task.taskId, output: result }))
    }, 50 + Math.random() * 50) // stagger responses
  })

  const tasks = Array.from({ length: 5 }, (_, i) =>
    relayTask(AGENT_ID, `conc-${i}`, 'test-type', { n: i }, 5000)
  )
  const results = await Promise.all(tasks)

  for (let i = 0; i < 5; i++) {
    assert.deepEqual(results[i], { echo: i }, `task ${i} result mismatch`)
  }

  ws.close()
  await new Promise(r => setTimeout(r, 200))
})

// 5. Disconnect mid-flight → falls through to Streamr on next request
await test('disconnect → next getRelayStatus returns offline', async () => {
  const ws = await connectAgent()
  assert.ok(getRelayStatus(AGENT_ID).connected)

  ws.close()
  await new Promise(r => setTimeout(r, 300))

  assert.equal(getRelayStatus(AGENT_ID).connected, false)
  // In server.mjs, the next task would take the Streamr path
})

// 6. Relay-only agent offline → should NOT fall through to Streamr
await test('relay-only agent offline → AGENT_OFFLINE guard', async () => {
  // Simulate the routing logic in server.mjs for a relay-only agent card
  const transport = ['relay'] // relay-only, no streamr
  const relay = getRelayStatus('nonexistent-relay-agent')
  const supportsStreamr = !transport || transport.includes('streamr')
  const transportMode = relay.connected ? 'relay' : supportsStreamr ? 'streamr' : null

  assert.equal(transportMode, null, 'should be null for offline relay-only agent')
  // In server.mjs, this triggers: err(res, 503, 'Agent is currently offline', 'AGENT_OFFLINE')
})

// 7. Dual-transport agent offline → falls through to Streamr
await test('dual-transport agent offline → falls through to streamr', async () => {
  const transport = ['relay', 'streamr']
  const relay = getRelayStatus('some-dual-agent')
  const supportsStreamr = !transport || transport.includes('streamr')
  const transportMode = relay.connected ? 'relay' : supportsStreamr ? 'streamr' : null

  assert.equal(transportMode, 'streamr', 'should fall through to streamr for dual-transport agent')
})

// 8. Timeout behaves like Streamr timeout (message includes "Timeout")
await test('relay timeout message includes "Timeout" keyword', async () => {
  const ws = await connectAgent() // handler doesn't respond to tasks

  try {
    await relayTask(AGENT_ID, 'task-to', 'test-type', {}, 300)
    assert.fail('should timeout')
  } catch (e) {
    // server.mjs uses: const isTimeout = e.message?.includes('Timeout')
    assert.ok(e.message.includes('Timeout'), `expected "Timeout" in message, got: ${e.message}`)
  }

  ws.close()
  await new Promise(r => setTimeout(r, 200))
})

// ── Teardown ─────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
gwServer.close()
registryServer.close()
process.exit(failed > 0 ? 1 : 0)
