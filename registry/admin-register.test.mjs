/**
 * Tests for registry admin registration endpoints.
 * POST /admin/agents/register — admin-assisted relay provider registration
 * DELETE /admin/agents/:agentId — admin delete
 */

import { unlinkSync, existsSync } from 'fs'
import { strict as assert } from 'assert'
import { test, describe, before, after } from 'node:test'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEST_DB = join(__dirname, 'agents-test-admin.json')
const FIXED_PORT = 19876
const ADMIN_KEY = 'test-admin-key-xyz'

let baseUrl

describe('Registry admin endpoints', () => {
  let proc

  before(async () => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)

    proc = await new Promise((resolve, reject) => {
      const child = spawn('node', ['server.mjs'], {
        cwd: __dirname,
        env: {
          ...process.env,
          PORT: String(FIXED_PORT),
          REGISTRY_ADMIN_API_KEY: ADMIN_KEY,
          DB_FILE: TEST_DB,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let started = false
      child.stdout.on('data', (data) => {
        if (!started && data.toString().includes('running on port')) {
          started = true
          resolve(child)
        }
      })

      child.stderr.on('data', (data) => {
        // Ignore warnings
      })

      setTimeout(() => {
        if (!started) { child.kill(); reject(new Error('Timeout')) }
      }, 5000)
    })

    baseUrl = `http://127.0.0.1:${FIXED_PORT}`
  })

  after(() => {
    if (proc) proc.kill()
    try { if (existsSync(TEST_DB)) unlinkSync(TEST_DB) } catch {}
  })

  async function post(path, body, headers = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: res.status, data: await res.json() }
  }

  async function del(path, headers = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'DELETE',
      headers,
    })
    return { status: res.status, data: await res.json() }
  }

  async function get(path) {
    const res = await fetch(`${baseUrl}${path}`)
    return { status: res.status, data: await res.json() }
  }

  test('admin register — success with minimal fields', async () => {
    const res = await post('/admin/agents/register', {
      agentId: 'relay-echo-v1',
      ownerAddress: '0xAbC1230000000000000000000000000000000001',
      capabilities: ['echo'],
      taskType: 'echo',
    }, { 'X-Admin-Key': ADMIN_KEY })

    assert.equal(res.status, 200)
    assert.equal(res.data.ok, true)
    assert.equal(res.data.agentId, 'relay-echo-v1')
    assert.equal(res.data.streamId, 'relay://relay-echo-v1')
    assert.equal(res.data.transport, 'relay')
  })

  test('admin register — agent card has relay transport', async () => {
    const res = await get('/agents/relay-echo-v1/card')
    assert.equal(res.status, 200)
    assert.deepEqual(res.data.invocation.transport, ['relay'])
    assert.equal(res.data.invocation.streamId, 'relay://relay-echo-v1')
    assert.equal(res.data.provider.ownerAddress, '0xabc1230000000000000000000000000000000001')
  })

  test('admin register — rejects without admin key', async () => {
    const res = await post('/admin/agents/register', {
      agentId: 'no-auth-agent',
      ownerAddress: '0x1111111111111111111111111111111111111111',
      capabilities: ['test'],
    })
    assert.equal(res.status, 401)
  })

  test('admin register — rejects wrong admin key', async () => {
    const res = await post('/admin/agents/register', {
      agentId: 'wrong-key-agent',
      ownerAddress: '0x1111111111111111111111111111111111111111',
      capabilities: ['test'],
    }, { 'X-Admin-Key': 'wrong-key' })
    assert.equal(res.status, 401)
  })

  test('admin register — rejects missing agentId', async () => {
    const res = await post('/admin/agents/register', {
      ownerAddress: '0x1111111111111111111111111111111111111111',
      capabilities: ['test'],
    }, { 'X-Admin-Key': ADMIN_KEY })
    assert.equal(res.status, 400)
  })

  test('admin register — rejects missing ownerAddress', async () => {
    const res = await post('/admin/agents/register', {
      agentId: 'no-owner',
      capabilities: ['test'],
    }, { 'X-Admin-Key': ADMIN_KEY })
    assert.equal(res.status, 400)
  })

  test('admin register — rejects empty capabilities', async () => {
    const res = await post('/admin/agents/register', {
      agentId: 'no-caps',
      ownerAddress: '0x1111111111111111111111111111111111111111',
      capabilities: [],
    }, { 'X-Admin-Key': ADMIN_KEY })
    assert.equal(res.status, 400)
  })

  test('admin register — allows explicit streamId override', async () => {
    const res = await post('/admin/agents/register', {
      agentId: 'custom-stream-agent',
      ownerAddress: '0x2222222222222222222222222222222222222222',
      capabilities: ['custom'],
      streamId: '0x2222222222222222222222222222222222222222/savantdex/custom-stream-agent',
    }, { 'X-Admin-Key': ADMIN_KEY })

    assert.equal(res.status, 200)
    assert.equal(res.data.streamId, '0x2222222222222222222222222222222222222222/savantdex/custom-stream-agent')
  })

  test('admin register — blocks overwrite by different owner', async () => {
    // relay-echo-v1 was registered above with 0xAbC123...
    const res = await post('/admin/agents/register', {
      agentId: 'relay-echo-v1',
      ownerAddress: '0x9999999999999999999999999999999999999999',
      capabilities: ['echo'],
    }, { 'X-Admin-Key': ADMIN_KEY })

    assert.equal(res.status, 403)
    assert(res.data.error.includes('different owner'))
  })

  test('admin register — allows re-registration by same owner', async () => {
    const res = await post('/admin/agents/register', {
      agentId: 'relay-echo-v1',
      ownerAddress: '0xAbC1230000000000000000000000000000000001',
      capabilities: ['echo', 'ping'],
      description: 'Updated description',
    }, { 'X-Admin-Key': ADMIN_KEY })

    assert.equal(res.status, 200)

    // Verify update
    const detail = await get('/agents/relay-echo-v1')
    assert.equal(detail.data.description, 'Updated description')
    assert.deepEqual(detail.data.capabilities, ['echo', 'ping'])
  })

  test('admin register — preserves all optional fields', async () => {
    const res = await post('/admin/agents/register', {
      agentId: 'full-fields-agent',
      ownerAddress: '0x3333333333333333333333333333333333333333',
      capabilities: ['analysis'],
      name: 'Full Fields Agent',
      description: 'Test all fields',
      category: 'testing',
      taskType: 'analyze',
      pricingModel: { type: 'paid', currency: 'DATA', amountBaseUnits: '1000000000000000000' },
      expectedLatencyMs: 5000,
      protocolVersion: '1.0',
    }, { 'X-Admin-Key': ADMIN_KEY })

    assert.equal(res.status, 200)

    const detail = await get('/agents/full-fields-agent')
    assert.equal(detail.data.name, 'Full Fields Agent')
    assert.equal(detail.data.category, 'testing')
    assert.equal(detail.data.taskType, 'analyze')
    assert.equal(detail.data.expectedLatencyMs, 5000)
    assert.equal(detail.data.pricingModel.type, 'paid')
  })

  test('admin delete — success', async () => {
    // First register an agent to delete
    await post('/admin/agents/register', {
      agentId: 'to-delete',
      ownerAddress: '0x4444444444444444444444444444444444444444',
      capabilities: ['temp'],
    }, { 'X-Admin-Key': ADMIN_KEY })

    const res = await del('/admin/agents/to-delete', { 'X-Admin-Key': ADMIN_KEY })
    assert.equal(res.status, 200)
    assert.equal(res.data.deleted, 'to-delete')

    // Verify gone
    const check = await get('/agents/to-delete')
    assert.equal(check.status, 404)
  })

  test('admin delete — rejects without admin key', async () => {
    const res = await del('/admin/agents/relay-echo-v1')
    assert.equal(res.status, 401)
  })

  test('admin delete — 404 for nonexistent agent', async () => {
    const res = await del('/admin/agents/nonexistent', { 'X-Admin-Key': ADMIN_KEY })
    assert.equal(res.status, 404)
  })

  test('admin-registered agent visible in list', async () => {
    const res = await get('/agents')
    assert.equal(res.status, 200)
    const ids = res.data.agents.map(a => a.agentId)
    assert(ids.includes('relay-echo-v1'))
  })

  test('admin-registered agent discoverable by capability filter', async () => {
    const res = await get('/agents?capability=echo')
    assert.equal(res.status, 200)
    const ids = res.data.agents.map(a => a.agentId)
    assert(ids.includes('relay-echo-v1'))
  })
})
