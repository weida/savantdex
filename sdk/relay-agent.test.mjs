/**
 * relay-agent.mjs — unit / integration tests
 *
 * Run: node savantdex/sdk/relay-agent.test.mjs
 *
 * Spins up a fake relay server, then exercises:
 *   1. connect() succeeds with valid auth
 *   2. connect() rejects on auth_error
 *   3. Task handler invoked and result sent
 *   4. Task handler error sent as { error }
 *   5. Pong sent in response to ping
 *   6. disconnect() closes cleanly
 *   7. Constructor validation
 *   8. connect() without onTask() throws
 *   9. Reconnect after server-side close
 *  10. Superseded message handled gracefully
 */

import http from 'http'
import assert from 'assert/strict'
import { Wallet } from 'ethers'
import { WebSocketServer } from 'ws'
import { RelayAgent } from './relay-agent.mjs'

const wallet = Wallet.createRandom()

// ── Fake relay server ────────────────────────────────────────────────────────

let serverHandler = null  // per-test handler

const httpServer = http.createServer((req, res) => { res.writeHead(404); res.end() })
await new Promise(r => httpServer.listen(0, '127.0.0.1', r))
const PORT = httpServer.address().port
const GW_URL = `ws://127.0.0.1:${PORT}/ws/agent`

const wss = new WebSocketServer({ server: httpServer, path: '/ws/agent' })

wss.on('connection', (ws) => {
  if (serverHandler) serverHandler(ws)
})

// ── Helpers ──────────────────────────────────────────────────────────────────

function waitMsg(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitMsg timeout')), timeoutMs)
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString())
      if (predicate(msg)) {
        clearTimeout(timer)
        ws.removeListener('message', handler)
        resolve(msg)
      }
    }
    ws.on('message', handler)
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

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('\n=== relay-agent.mjs tests ===\n')

// 1. connect() succeeds
await test('connect succeeds with valid auth', async () => {
  serverHandler = (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'auth') {
        ws.send(JSON.stringify({ type: 'auth_ok', sessionId: 'test-session', heartbeatIntervalMs: 30000 }))
      }
    })
  }

  const agent = new RelayAgent({ gatewayUrl: GW_URL, signer: wallet, agentId: 'test-v1' })
  agent.onTask(async () => ({}))
  await agent.connect()
  await agent.disconnect()
})

// 2. connect() rejects on auth_error
await test('connect rejects on auth_error', async () => {
  serverHandler = (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'auth') {
        ws.send(JSON.stringify({ type: 'auth_error', error: 'bad signature' }))
      }
    })
  }

  const agent = new RelayAgent({ gatewayUrl: GW_URL, signer: wallet, agentId: 'test-v1' })
  agent.onTask(async () => ({}))
  try {
    await agent.connect()
    assert.fail('should have rejected')
  } catch (e) {
    assert.ok(e.message.includes('bad signature'), `expected auth error, got: ${e.message}`)
  }
})

// 3. Task handler invoked — result sent
await test('task handler invoked and result sent', async () => {
  let serverWs
  serverHandler = (ws) => {
    serverWs = ws
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'auth') {
        ws.send(JSON.stringify({ type: 'auth_ok', sessionId: 's1', heartbeatIntervalMs: 30000 }))
      }
    })
  }

  const agent = new RelayAgent({ gatewayUrl: GW_URL, signer: wallet, agentId: 'test-v1' })
  agent.onTask(async (task) => {
    return { wordCount: task.input.text.split(' ').length }
  })
  await agent.connect()

  // Server sends a task
  const resultP = waitMsg(serverWs, m => m.type === 'result')
  serverWs.send(JSON.stringify({ type: 'task', taskId: 'tk-1', taskType: 'analyze', input: { text: 'hello world' }, timeoutMs: 5000 }))
  const result = await resultP

  assert.equal(result.taskId, 'tk-1')
  assert.deepEqual(result.output, { wordCount: 2 })
  assert.equal(result.error, undefined)

  await agent.disconnect()
})

// 4. Task handler error → sent as { error }
await test('task handler error sent as error message', async () => {
  let serverWs
  serverHandler = (ws) => {
    serverWs = ws
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'auth') {
        ws.send(JSON.stringify({ type: 'auth_ok', sessionId: 's2', heartbeatIntervalMs: 30000 }))
      }
    })
  }

  const agent = new RelayAgent({ gatewayUrl: GW_URL, signer: wallet, agentId: 'test-v1' })
  agent.onTask(async () => { throw new Error('handler boom') })
  await agent.connect()

  const resultP = waitMsg(serverWs, m => m.type === 'result')
  serverWs.send(JSON.stringify({ type: 'task', taskId: 'tk-2', taskType: 'x', input: {}, timeoutMs: 5000 }))
  const result = await resultP

  assert.equal(result.taskId, 'tk-2')
  assert.equal(result.error, 'handler boom')
  assert.equal(result.output, undefined)

  await agent.disconnect()
})

// 5. Pong sent in response to ping
await test('pong sent in response to ping', async () => {
  let serverWs
  serverHandler = (ws) => {
    serverWs = ws
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'auth') {
        ws.send(JSON.stringify({ type: 'auth_ok', sessionId: 's3', heartbeatIntervalMs: 30000 }))
      }
    })
  }

  const agent = new RelayAgent({ gatewayUrl: GW_URL, signer: wallet, agentId: 'test-v1' })
  agent.onTask(async () => ({}))
  await agent.connect()

  const pongP = waitMsg(serverWs, m => m.type === 'pong')
  serverWs.send(JSON.stringify({ type: 'ping', ts: 12345 }))
  const pong = await pongP
  assert.equal(pong.ts, 12345)

  await agent.disconnect()
})

// 6. disconnect() closes cleanly
await test('disconnect closes cleanly', async () => {
  let serverWs
  serverHandler = (ws) => {
    serverWs = ws
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'auth') {
        ws.send(JSON.stringify({ type: 'auth_ok', sessionId: 's4', heartbeatIntervalMs: 30000 }))
      }
    })
  }

  const agent = new RelayAgent({ gatewayUrl: GW_URL, signer: wallet, agentId: 'test-v1' })
  agent.onTask(async () => ({}))
  await agent.connect()

  const closeP = new Promise(r => serverWs.on('close', r))
  await agent.disconnect()
  await closeP
  // No crash, clean close
})

// 7. Constructor validation
await test('constructor rejects missing params', async () => {
  assert.throws(() => new RelayAgent({ signer: wallet, agentId: 'x' }), /gatewayUrl/)
  assert.throws(() => new RelayAgent({ gatewayUrl: 'ws://x', agentId: 'x' }), /privateKey or signer/)
  assert.throws(() => new RelayAgent({ gatewayUrl: 'ws://x', signer: wallet }), /agentId/)
})

// 8. connect() without onTask throws
await test('connect without onTask throws', async () => {
  const agent = new RelayAgent({ gatewayUrl: GW_URL, signer: wallet, agentId: 'test-v1' })
  try {
    await agent.connect()
    assert.fail('should have thrown')
  } catch (e) {
    assert.ok(e.message.includes('onTask'), `expected onTask error, got: ${e.message}`)
  }
})

// 9. Auth message contains nonce
await test('auth message contains nonce field', async () => {
  let authMsg
  serverHandler = (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'auth') {
        authMsg = msg
        ws.send(JSON.stringify({ type: 'auth_ok', sessionId: 's5', heartbeatIntervalMs: 30000 }))
      }
    })
  }

  const agent = new RelayAgent({ gatewayUrl: GW_URL, signer: wallet, agentId: 'test-v1' })
  agent.onTask(async () => ({}))
  await agent.connect()

  assert.ok(authMsg.nonce, 'auth message should have nonce')
  assert.equal(typeof authMsg.nonce, 'string')
  assert.ok(authMsg.nonce.length >= 16, 'nonce should be at least 16 chars')
  assert.ok(authMsg.timestamp, 'auth message should have timestamp')
  assert.ok(authMsg.signature, 'auth message should have signature')

  await agent.disconnect()
})

// 10. privateKey constructor path
await test('privateKey constructor creates signer', async () => {
  serverHandler = (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'auth') {
        ws.send(JSON.stringify({ type: 'auth_ok', sessionId: 's6', heartbeatIntervalMs: 30000 }))
      }
    })
  }

  const agent = new RelayAgent({ gatewayUrl: GW_URL, privateKey: wallet.privateKey, agentId: 'test-v1' })
  agent.onTask(async () => ({}))
  await agent.connect()
  await agent.disconnect()
})

// ── Teardown ─────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)

httpServer.close()
process.exit(failed > 0 ? 1 : 0)
