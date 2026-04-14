/**
 * Phase D tests — Stage D1 + D2
 *
 * D1-1: resolveRequester finds api-key in RequesterAuthMethod
 * D1-2: resolveRequester returns { requesterAgentId, ownerAddress, authMethod }
 * D1-3: resolveRequester returns null for unknown key
 * D1-4: resolveRequester returns null for disabled method
 * D1-5: migration V3 creates RequesterIdentity + RequesterAuthMethod from RequesterAuth
 * D1-6: getAuthMethods returns method list for requester
 * D1-7: seedRequester writes to RequesterIdentity + RequesterAuthMethod
 * D1-8: resolveApiKey still works (backward compat)
 * D1-9: payment flow works end-to-end through resolveRequester identity
 * D1-10: resolveRequester fallback to RequesterAuth when not in RequesterAuthMethod
 *
 * D2-1: bindWalletMethod creates wallet-signature RequesterAuthMethod row
 * D2-2: bindWalletMethod returns correct shape
 * D2-3: bindWalletMethod rejects unknown requesterAgentId
 * D2-4: bindWalletMethod rejects ownerAddress mismatch
 * D2-5: bindWalletMethod rejects duplicate wallet-signature on same requester
 * D2-6: bindWalletMethod rejects same wallet bound to different requester
 * D2-7: getAuthMethods shows both api-key and wallet-signature after binding
 * D2-8: getRequesterIdentity returns identity row
 * D2-9: ownerAddress comparison is case-insensitive
 * D2-10: disabled binding does not block re-bind (partial unique index)
 *
 * D3-1:  createChallenge returns { challengeId, message, nonce, expiresAt }
 * D3-2:  createChallenge rejects requester without wallet binding
 * D3-3:  challenge message contains all required fields in EIP-191 format
 * D3-4:  getChallenge returns null for used challenge
 * D3-5:  getChallenge returns null for expired challenge
 * D3-6:  getChallenge returns null for unknown challengeId
 * D3-7:  consumeChallengeAndCreateSession returns sessionToken + expiresAt
 * D3-8:  consumeChallengeAndCreateSession is single-use
 * D3-9:  resolveSession returns identity for valid token
 * D3-10: resolveSession returns null for unknown token
 * D3-11: resolveSession returns null for revoked session
 * D3-12: revokeSession marks session revoked
 * D3-13: revokeSession throws SESSION_NOT_FOUND for unknown token
 * D3-14: resolveSession returns null after TTL expired (mocked)
 */

import assert from 'assert/strict'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes, createHash } from 'crypto'
import Database from 'better-sqlite3'
import {
  initDb, resolveRequester, resolveApiKey, getAuthMethods, getRequesterIdentity, bindWalletMethod,
  createChallenge, getChallenge, consumeChallengeAndCreateSession, resolveSession, revokeSession,
  seedRequester, preInvocationCheck, writeSubmitted, markStatus,
  chargeCompleted, getBudget, writeDeliveryReceipt,
} from './payment.mjs'

function tmpDb() {
  return join(tmpdir(), `payment-phaseD-${randomBytes(6).toString('hex')}.db`)
}

let passed = 0
let failed = 0

function test(name, fn) {
  const path = tmpDb()
  try {
    initDb(path)
    fn(path)
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e.message}`)
    failed++
  }
}

// ── D1-1: resolveRequester finds api-key in RequesterAuthMethod ───────────────

test('D1-1: resolveRequester finds api-key via RequesterAuthMethod', () => {
  seedRequester({
    rawKey: 'key-d1', requesterAgentId: 'req-d1',
    ownerAddress: '0xaaa', remainingBaseUnits: '10000000000000000000',
    maxPerTaskBaseUnits: '5000000000000000000', dailyLimitBaseUnits: '20000000000000000000',
  })
  const result = resolveRequester('key-d1')
  assert.ok(result, 'should resolve')
})

// ── D1-2: resolveRequester returns correct shape ──────────────────────────────

test('D1-2: resolveRequester returns { requesterAgentId, ownerAddress, authMethod }', () => {
  seedRequester({
    rawKey: 'key-d2', requesterAgentId: 'req-d2',
    ownerAddress: '0xbbb', remainingBaseUnits: '10000000000000000000',
    maxPerTaskBaseUnits: '5000000000000000000', dailyLimitBaseUnits: '20000000000000000000',
  })
  const result = resolveRequester('key-d2')
  assert.equal(result.requesterAgentId, 'req-d2')
  assert.equal(result.ownerAddress, '0xbbb')
  assert.equal(result.authMethod, 'api-key')
  // Should NOT expose raw internal fields like apiKeyHash
  assert.equal(result.apiKeyHash, undefined)
  assert.equal(result.status, undefined)
})

// ── D1-3: resolveRequester returns null for unknown key ───────────────────────

test('D1-3: resolveRequester returns null for unknown key', () => {
  const result = resolveRequester('nonexistent-key')
  assert.equal(result, null)
})

// ── D1-4: resolveRequester returns null for disabled method ──────────────────

test('D1-4: resolveRequester returns null for disabled method', (path) => {
  seedRequester({
    rawKey: 'key-d4', requesterAgentId: 'req-d4',
    ownerAddress: '0xccc', remainingBaseUnits: '10000000000000000000',
    maxPerTaskBaseUnits: '5000000000000000000', dailyLimitBaseUnits: '20000000000000000000',
  })
  // Disable the method directly
  const db = new Database(path)
  db.prepare(`UPDATE RequesterAuthMethod SET status = 'disabled' WHERE requesterAgentId = 'req-d4'`).run()
  db.close()

  const result = resolveRequester('key-d4')
  assert.equal(result, null)
})

// ── D1-5: migration V3 creates tables and migrates RequesterAuth data ─────────

test('D1-5: migration V3 creates RequesterIdentity + RequesterAuthMethod from RequesterAuth', (path) => {
  seedRequester({
    rawKey: 'key-d5', requesterAgentId: 'req-d5',
    ownerAddress: '0xddd', remainingBaseUnits: '1000000000000000000',
    maxPerTaskBaseUnits: '1000000000000000000', dailyLimitBaseUnits: '5000000000000000000',
  })
  const db = new Database(path)

  const identity = db.prepare(`SELECT * FROM RequesterIdentity WHERE requesterAgentId = 'req-d5'`).get()
  assert.ok(identity, 'RequesterIdentity row should exist')
  assert.equal(identity.ownerAddress, '0xddd')
  assert.equal(identity.status, 'active')

  const method = db.prepare(`SELECT * FROM RequesterAuthMethod WHERE requesterAgentId = 'req-d5'`).get()
  assert.ok(method, 'RequesterAuthMethod row should exist')
  assert.equal(method.methodType, 'api-key')
  assert.equal(method.ownerAddress, '0xddd')
  assert.equal(method.status, 'active')

  db.close()
})

// ── D1-6: getAuthMethods returns method list ──────────────────────────────────

test('D1-6: getAuthMethods returns method rows for requester', () => {
  seedRequester({
    rawKey: 'key-d6', requesterAgentId: 'req-d6',
    ownerAddress: '0xeee', remainingBaseUnits: '1000000000000000000',
    maxPerTaskBaseUnits: '1000000000000000000', dailyLimitBaseUnits: '5000000000000000000',
  })
  const methods = getAuthMethods('req-d6')
  assert.equal(methods.length, 1)
  assert.equal(methods[0].methodType, 'api-key')
  assert.equal(methods[0].status, 'active')
  // methodRef should be present but should NOT expose it as cleartext key
  assert.ok(methods[0].methodRef, 'methodRef should be present')
  assert.ok(!methods[0].methodRef.includes('key-d6'), 'methodRef should be hashed, not cleartext')
})

// ── D1-7: seedRequester writes to all three auth tables ───────────────────────

test('D1-7: seedRequester writes RequesterAuth + RequesterIdentity + RequesterAuthMethod', (path) => {
  seedRequester({
    rawKey: 'key-d7', requesterAgentId: 'req-d7',
    ownerAddress: '0xfff', remainingBaseUnits: '1000000000000000000',
    maxPerTaskBaseUnits: '1000000000000000000', dailyLimitBaseUnits: '5000000000000000000',
  })
  const db = new Database(path)

  const auth    = db.prepare(`SELECT * FROM RequesterAuth       WHERE requesterAgentId = 'req-d7'`).get()
  const identity = db.prepare(`SELECT * FROM RequesterIdentity  WHERE requesterAgentId = 'req-d7'`).get()
  const method  = db.prepare(`SELECT * FROM RequesterAuthMethod WHERE requesterAgentId = 'req-d7'`).get()

  assert.ok(auth,     'RequesterAuth row should exist (compat)')
  assert.ok(identity, 'RequesterIdentity row should exist')
  assert.ok(method,   'RequesterAuthMethod row should exist')
  db.close()
})

// ── D1-8: resolveApiKey still works (backward compat) ────────────────────────

test('D1-8: resolveApiKey still works (backward compat)', () => {
  seedRequester({
    rawKey: 'key-d8', requesterAgentId: 'req-d8',
    ownerAddress: '0x111', remainingBaseUnits: '1000000000000000000',
    maxPerTaskBaseUnits: '1000000000000000000', dailyLimitBaseUnits: '5000000000000000000',
  })
  const legacy = resolveApiKey('key-d8')
  assert.ok(legacy, 'resolveApiKey should still find the key')
  assert.equal(legacy.requesterAgentId, 'req-d8')
})

// ── D1-9: full payment flow works through resolveRequester identity ───────────

test('D1-9: payment flow works end-to-end using resolveRequester result', () => {
  seedRequester({
    rawKey: 'key-d9', requesterAgentId: 'req-d9',
    ownerAddress: '0x222', remainingBaseUnits: '5000000000000000000',
    maxPerTaskBaseUnits: '2000000000000000000', dailyLimitBaseUnits: '10000000000000000000',
  })

  const identity = resolveRequester('key-d9')
  assert.ok(identity)

  const pricingModel = { type: 'fixed', currency: 'DATA', amountBaseUnits: '1000000000000000000', decimals: 18, billingUnit: 'task' }
  const check = preInvocationCheck(identity.requesterAgentId, pricingModel.amountBaseUnits)
  assert.ok(check.ok, 'pre-invocation check should pass')

  const taskId = `task-d9-${Date.now()}`
  writeSubmitted({
    taskId, requesterAgentId: identity.requesterAgentId,
    providerAgentId: 'test-agent', providerOwnerAddress: '0x333',
    taskType: 'test-type', pricingModel, timeoutMs: 60000,
  })
  markStatus(taskId, 'completed')

  // Write delivery receipt so evidence gate passes (agreementVersion=2)
  writeDeliveryReceipt({ taskId, result: { output: 'ok' }, gatewayAddress: '0x222' })

  const { charged } = chargeCompleted(taskId)
  assert.ok(charged, 'charge should succeed')

  const budget = getBudget(identity.requesterAgentId)
  assert.equal(budget.remainingBaseUnits, '4000000000000000000', 'budget should decrease by 1 DATA')
})

// ── D1-10: resolveRequester fallback to RequesterAuth ────────────────────────

test('D1-10: resolveRequester falls back to RequesterAuth if not in RequesterAuthMethod', (path) => {
  seedRequester({
    rawKey: 'key-d10', requesterAgentId: 'req-d10',
    ownerAddress: '0x444', remainingBaseUnits: '1000000000000000000',
    maxPerTaskBaseUnits: '1000000000000000000', dailyLimitBaseUnits: '5000000000000000000',
  })

  // Delete from RequesterAuthMethod to simulate pre-migration state
  const db = new Database(path)
  db.prepare(`DELETE FROM RequesterAuthMethod WHERE requesterAgentId = 'req-d10'`).run()
  db.close()

  // Should still resolve via RequesterAuth fallback
  const result = resolveRequester('key-d10')
  assert.ok(result, 'should fall back to RequesterAuth')
  assert.equal(result.requesterAgentId, 'req-d10')
  assert.equal(result.authMethod, 'api-key')
})

// ── D2: Registration and binding ──────────────────────────────────────────────

function seedD2(id, addr) {
  seedRequester({
    rawKey: `key-${id}`, requesterAgentId: `req-${id}`,
    ownerAddress: addr, remainingBaseUnits: '1000000000000000000',
    maxPerTaskBaseUnits: '1000000000000000000', dailyLimitBaseUnits: '5000000000000000000',
  })
}

test('D2-1: bindWalletMethod creates wallet-signature RequesterAuthMethod row', (path) => {
  seedD2('d2a', '0xAAAA000000000000000000000000000000000001')
  bindWalletMethod({ requesterAgentId: 'req-d2a', ownerAddress: '0xAAAA000000000000000000000000000000000001' })

  const db = new Database(path)
  const method = db.prepare(`SELECT * FROM RequesterAuthMethod WHERE requesterAgentId = 'req-d2a' AND methodType = 'wallet-signature'`).get()
  assert.ok(method, 'wallet-signature row should exist')
  assert.equal(method.status, 'active')
  assert.equal(method.methodRef, '0xaaaa000000000000000000000000000000000001')
  db.close()
})

test('D2-2: bindWalletMethod returns correct shape', () => {
  seedD2('d2b', '0xBBBB000000000000000000000000000000000002')
  const result = bindWalletMethod({ requesterAgentId: 'req-d2b', ownerAddress: '0xBBBB000000000000000000000000000000000002' })
  assert.ok(result.authMethodId, 'authMethodId should be present')
  assert.equal(result.requesterAgentId, 'req-d2b')
  assert.equal(result.ownerAddress, '0xBBBB000000000000000000000000000000000002')
  assert.equal(result.methodType, 'wallet-signature')
})

test('D2-3: bindWalletMethod rejects unknown requesterAgentId', () => {
  assert.throws(
    () => bindWalletMethod({ requesterAgentId: 'req-nonexistent', ownerAddress: '0x1234' }),
    e => e.code === 'IDENTITY_NOT_FOUND'
  )
})

test('D2-4: bindWalletMethod rejects ownerAddress mismatch', () => {
  seedD2('d2d', '0xDDDD000000000000000000000000000000000004')
  assert.throws(
    () => bindWalletMethod({ requesterAgentId: 'req-d2d', ownerAddress: '0x9999000000000000000000000000000000000099' }),
    e => e.code === 'OWNER_MISMATCH'
  )
})

test('D2-5: bindWalletMethod rejects duplicate wallet-signature on same requester', () => {
  seedD2('d2e', '0xEEEE000000000000000000000000000000000005')
  bindWalletMethod({ requesterAgentId: 'req-d2e', ownerAddress: '0xEEEE000000000000000000000000000000000005' })
  assert.throws(
    () => bindWalletMethod({ requesterAgentId: 'req-d2e', ownerAddress: '0xEEEE000000000000000000000000000000000005' }),
    e => e.code === 'METHOD_ALREADY_EXISTS'
  )
})

test('D2-6: bindWalletMethod rejects same wallet bound to different requester', () => {
  const SHARED_ADDR = '0xFFFF000000000000000000000000000000000006'
  seedD2('d2f1', SHARED_ADDR)
  seedD2('d2f2', SHARED_ADDR)
  bindWalletMethod({ requesterAgentId: 'req-d2f1', ownerAddress: SHARED_ADDR })
  assert.throws(
    () => bindWalletMethod({ requesterAgentId: 'req-d2f2', ownerAddress: SHARED_ADDR }),
    e => e.code === 'WALLET_ALREADY_BOUND'
  )
})

test('D2-7: getAuthMethods shows both api-key and wallet-signature after binding', () => {
  seedD2('d2g', '0xAAAA000000000000000000000000000000000007')
  bindWalletMethod({ requesterAgentId: 'req-d2g', ownerAddress: '0xAAAA000000000000000000000000000000000007' })
  const methods = getAuthMethods('req-d2g')
  assert.equal(methods.length, 2)
  const types = methods.map(m => m.methodType).sort()
  assert.deepEqual(types, ['api-key', 'wallet-signature'])
})

test('D2-8: getRequesterIdentity returns identity row', () => {
  seedD2('d2h', '0xBBBB000000000000000000000000000000000008')
  const identity = getRequesterIdentity('req-d2h')
  assert.ok(identity)
  assert.equal(identity.requesterAgentId, 'req-d2h')
  assert.equal(identity.ownerAddress, '0xBBBB000000000000000000000000000000000008')
  assert.equal(identity.status, 'active')
  assert.equal(getRequesterIdentity('req-nonexistent'), null)
})

test('D2-9: ownerAddress comparison is case-insensitive', (path) => {
  seedD2('d2i', '0xCCCC000000000000000000000000000000000009')
  // Bind with different casing — should succeed because we normalize
  bindWalletMethod({ requesterAgentId: 'req-d2i', ownerAddress: '0xcccc000000000000000000000000000000000009' })

  const db = new Database(path)
  const method = db.prepare(`SELECT methodRef FROM RequesterAuthMethod WHERE requesterAgentId = 'req-d2i' AND methodType = 'wallet-signature'`).get()
  assert.equal(method.methodRef, '0xcccc000000000000000000000000000000000009')
  db.close()
})

test('D2-10: disabled binding does not block re-bind to same requester', (path) => {
  seedD2('d2j', '0xDDDD000000000000000000000000000000000010')
  bindWalletMethod({ requesterAgentId: 'req-d2j', ownerAddress: '0xDDDD000000000000000000000000000000000010' })

  // Disable the binding
  const db = new Database(path)
  db.prepare(`UPDATE RequesterAuthMethod SET status = 'disabled' WHERE requesterAgentId = 'req-d2j' AND methodType = 'wallet-signature'`).run()
  db.close()

  // Re-bind should succeed (partial unique index only covers active rows)
  const result = bindWalletMethod({ requesterAgentId: 'req-d2j', ownerAddress: '0xDDDD000000000000000000000000000000000010' })
  assert.ok(result.authMethodId)
})

// ── D3: wallet challenge and session ──────────────────────────────────────────

// Helper: seed a requester with a wallet binding ready for challenge
function seedWithWallet(id, addr) {
  seedRequester({
    rawKey: `key-${id}`, requesterAgentId: `req-${id}`,
    ownerAddress: addr, remainingBaseUnits: '5000000000000000000',
    maxPerTaskBaseUnits: '2000000000000000000', dailyLimitBaseUnits: '10000000000000000000',
  })
  bindWalletMethod({ requesterAgentId: `req-${id}`, ownerAddress: addr })
}

const WALLET_D3 = '0xAAAA000000000000000000000000000000000D03'

test('D3-1: createChallenge returns required fields', () => {
  seedWithWallet('d3a', WALLET_D3)
  const result = createChallenge({ requesterAgentId: 'req-d3a', ownerAddress: WALLET_D3 })
  assert.ok(result.challengeId, 'challengeId present')
  assert.ok(result.message,     'message present')
  assert.ok(result.nonce,       'nonce present')
  assert.ok(result.expiresAt,   'expiresAt present')
  assert.ok(new Date(result.expiresAt) > new Date(), 'expiresAt is in the future')
})

test('D3-2: createChallenge rejects requester without wallet binding', () => {
  seedRequester({
    rawKey: 'key-d3b', requesterAgentId: 'req-d3b',
    ownerAddress: '0xBBBB', remainingBaseUnits: '1000000000000000000',
    maxPerTaskBaseUnits: '1000000000000000000', dailyLimitBaseUnits: '5000000000000000000',
  })
  assert.throws(
    () => createChallenge({ requesterAgentId: 'req-d3b', ownerAddress: '0xBBBB' }),
    e => e.code === 'WALLET_NOT_BOUND'
  )
})

test('D3-3: challenge message contains all required fields', () => {
  seedWithWallet('d3c', '0xCCCC000000000000000000000000000000000D03')
  const { message, nonce } = createChallenge({ requesterAgentId: 'req-d3c', ownerAddress: '0xCCCC000000000000000000000000000000000D03' })
  assert.ok(message.includes('SavantDex authentication'), 'has header')
  assert.ok(message.includes('requesterAgentId: req-d3c'), 'has requesterAgentId')
  assert.ok(message.includes('ownerAddress: 0xCCCC000000000000000000000000000000000D03'), 'has ownerAddress')
  assert.ok(message.includes(`nonce: ${nonce}`), 'has nonce')
  assert.ok(message.includes('issuedAt:'), 'has issuedAt')
  assert.ok(message.includes('expiresAt:'), 'has expiresAt')
})

test('D3-4: getChallenge returns null for used challenge', (path) => {
  seedWithWallet('d3d', '0xDDDD000000000000000000000000000000000D03')
  const { challengeId } = createChallenge({ requesterAgentId: 'req-d3d', ownerAddress: '0xDDDD000000000000000000000000000000000D03' })
  // Mark as used directly
  const db = new Database(path)
  db.prepare(`UPDATE WalletAuthChallenge SET usedAt = datetime('now') WHERE challengeId = ?`).run(challengeId)
  db.close()
  assert.equal(getChallenge(challengeId), null)
})

test('D3-5: getChallenge returns null for expired challenge', (path) => {
  seedWithWallet('d3e', '0xEEEE000000000000000000000000000000000D03')
  const { challengeId } = createChallenge({ requesterAgentId: 'req-d3e', ownerAddress: '0xEEEE000000000000000000000000000000000D03' })
  // Back-date expiresAt
  const db = new Database(path)
  db.prepare(`UPDATE WalletAuthChallenge SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE challengeId = ?`).run(challengeId)
  db.close()
  assert.equal(getChallenge(challengeId), null)
})

test('D3-6: getChallenge returns null for unknown challengeId', () => {
  assert.equal(getChallenge('nonexistent-challenge-id'), null)
})

test('D3-7: consumeChallengeAndCreateSession returns sessionToken + expiresAt', () => {
  seedWithWallet('d3g', '0xGGGG000000000000000000000000000000000D03'.replace('G', 'A'))
  const addr = '0xAAAA000000000000000000000000000000000D04'
  seedWithWallet('d3g2', addr)
  const { challengeId } = createChallenge({ requesterAgentId: 'req-d3g2', ownerAddress: addr })
  const result = consumeChallengeAndCreateSession({ challengeId })
  assert.ok(result.sessionToken, 'sessionToken present')
  assert.ok(result.sessionId,    'sessionId present')
  assert.ok(result.expiresAt,    'expiresAt present')
  assert.ok(new Date(result.expiresAt) > new Date(), 'expiresAt in future')
  assert.equal(result.requesterAgentId, 'req-d3g2')
})

test('D3-8: consumeChallengeAndCreateSession is single-use', () => {
  const addr = '0xAAAA000000000000000000000000000000000D05'
  seedWithWallet('d3h', addr)
  const { challengeId } = createChallenge({ requesterAgentId: 'req-d3h', ownerAddress: addr })
  consumeChallengeAndCreateSession({ challengeId })
  assert.throws(
    () => consumeChallengeAndCreateSession({ challengeId }),
    e => e.code === 'CHALLENGE_ALREADY_USED'
  )
})

test('D3-9: resolveSession returns identity for valid token', () => {
  const addr = '0xAAAA000000000000000000000000000000000D06'
  seedWithWallet('d3i', addr)
  const { challengeId } = createChallenge({ requesterAgentId: 'req-d3i', ownerAddress: addr })
  const { sessionToken } = consumeChallengeAndCreateSession({ challengeId })
  const identity = resolveSession(sessionToken)
  assert.ok(identity, 'should resolve')
  assert.equal(identity.requesterAgentId, 'req-d3i')
  assert.equal(identity.ownerAddress, addr)
  assert.equal(identity.authMethod, 'wallet-signature')
})

test('D3-10: resolveSession returns null for unknown token', () => {
  assert.equal(resolveSession('totally-unknown-token'), null)
})

test('D3-11: resolveSession returns null for revoked session', () => {
  const addr = '0xAAAA000000000000000000000000000000000D07'
  seedWithWallet('d3k', addr)
  const { challengeId } = createChallenge({ requesterAgentId: 'req-d3k', ownerAddress: addr })
  const { sessionToken } = consumeChallengeAndCreateSession({ challengeId })
  revokeSession(sessionToken)
  assert.equal(resolveSession(sessionToken), null)
})

test('D3-12: revokeSession marks session revoked', (path) => {
  const addr = '0xAAAA000000000000000000000000000000000D08'
  seedWithWallet('d3l', addr)
  const { challengeId } = createChallenge({ requesterAgentId: 'req-d3l', ownerAddress: addr })
  const { sessionToken } = consumeChallengeAndCreateSession({ challengeId })
  const result = revokeSession(sessionToken)
  assert.deepEqual(result, { ok: true })
  // Confirm revokedAt is set
  const tokenHash = createHash('sha256').update(sessionToken).digest('hex')
  const db = new Database(path)
  const row = db.prepare(`SELECT revokedAt FROM RequesterSession WHERE tokenHash = ?`).get(tokenHash)
  assert.ok(row.revokedAt, 'revokedAt should be set')
  db.close()
})

test('D3-13: revokeSession throws SESSION_NOT_FOUND for unknown token', () => {
  assert.throws(
    () => revokeSession('nonexistent-session-token'),
    e => e.code === 'SESSION_NOT_FOUND'
  )
})

test('D3-11b: resolveSession returns null when identity is disabled', (path) => {
  const addr = '0xAAAA000000000000000000000000000000000D11'
  seedWithWallet('d3n', addr)
  const { challengeId } = createChallenge({ requesterAgentId: 'req-d3n', ownerAddress: addr })
  const { sessionToken } = consumeChallengeAndCreateSession({ challengeId })
  // Disable the identity
  const db = new Database(path)
  db.prepare(`UPDATE RequesterIdentity SET status = 'disabled' WHERE requesterAgentId = 'req-d3n'`).run()
  db.close()
  assert.equal(resolveSession(sessionToken), null)
})

test('D3-11c: resolveSession returns null when wallet binding is disabled', (path) => {
  const addr = '0xAAAA000000000000000000000000000000000D12'
  seedWithWallet('d3o', addr)
  const { challengeId } = createChallenge({ requesterAgentId: 'req-d3o', ownerAddress: addr })
  const { sessionToken } = consumeChallengeAndCreateSession({ challengeId })
  // Disable the wallet-signature binding
  const db = new Database(path)
  db.prepare(`UPDATE RequesterAuthMethod SET status = 'disabled' WHERE requesterAgentId = 'req-d3o' AND methodType = 'wallet-signature'`).run()
  db.close()
  assert.equal(resolveSession(sessionToken), null)
})

test('D3-8b: consumeChallenge rejects if identity disabled after challenge issued', (path) => {
  const addr = '0xAAAA000000000000000000000000000000000E01'
  seedWithWallet('d3p', addr)
  const { challengeId } = createChallenge({ requesterAgentId: 'req-d3p', ownerAddress: addr })
  // Disable identity after challenge issued
  const db = new Database(path)
  db.prepare(`UPDATE RequesterIdentity SET status = 'disabled' WHERE requesterAgentId = 'req-d3p'`).run()
  db.close()
  assert.throws(
    () => consumeChallengeAndCreateSession({ challengeId }),
    e => e.code === 'IDENTITY_INACTIVE'
  )
})

test('D3-8c: consumeChallenge rejects if wallet binding disabled after challenge issued', (path) => {
  const addr = '0xAAAA000000000000000000000000000000000E02'
  seedWithWallet('d3q', addr)
  const { challengeId } = createChallenge({ requesterAgentId: 'req-d3q', ownerAddress: addr })
  // Disable wallet binding after challenge issued
  const db = new Database(path)
  db.prepare(`UPDATE RequesterAuthMethod SET status = 'disabled' WHERE requesterAgentId = 'req-d3q' AND methodType = 'wallet-signature'`).run()
  db.close()
  assert.throws(
    () => consumeChallengeAndCreateSession({ challengeId }),
    e => e.code === 'BINDING_INACTIVE'
  )
})

test('D3-14: resolveSession returns null after session TTL expires', (path) => {
  const addr = '0xAAAA000000000000000000000000000000000D09'
  seedWithWallet('d3m', addr)
  const { challengeId } = createChallenge({ requesterAgentId: 'req-d3m', ownerAddress: addr })
  const { sessionToken } = consumeChallengeAndCreateSession({ challengeId })
  // Back-date expiresAt on the session row
  const tokenHash = createHash('sha256').update(sessionToken).digest('hex')
  const db = new Database(path)
  db.prepare(`UPDATE RequesterSession SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE tokenHash = ?`).run(tokenHash)
  db.close()
  assert.equal(resolveSession(sessionToken), null)
})

// ── Results ───────────────────────────────────────────────────────────────────

console.log()
console.log(`Phase D tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
