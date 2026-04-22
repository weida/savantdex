/**
 * Phase C Payment — evidence gate test cases
 * Run: node backend/payment.phaseC.test.mjs
 *
 * Covers:
 *   C1  computeResultHash: same result, different key order → same hash
 *   C2  computeResultHash: nested objects are also sorted
 *   C3  writeSubmitted writes TaskAgreementProof with matching agreementHash
 *   C4  evidence gate blocks charge: missing DeliveryReceipt
 *   C5  evidence gate blocks charge: DeliveryReceipt agreementHash mismatch
 *   C6  evidence gate blocks charge: missing TaskAgreementProof
 *   C7  evidence gate blocks charge: TaskAgreementProof agreementHash mismatch
 *   C8  evidence gate passes: both receipts present with matching hash → charged
 *   C9  Phase A/B tasks (agreementVersion=1) bypass gate entirely
 *   C10 getTaskTrace returns agreementProof and deliveryReceipt
 */

import { initDb, writeSubmitted, markStatus, chargeCompleted,
         seedRequester, getTaskTrace, computeResultHash, writeDeliveryReceipt } from './payment.mjs'
import { buildReceiptPayload } from './receipt.mjs'

/** Build a canonical Phase-C DeliveryReceipt row for a completed task. */
function writeTestReceipt(taskId, result, { gatewayAddress = null } = {}) {
  const { agreement } = getTaskTrace(taskId)
  const payload = buildReceiptPayload({
    taskId,
    agreementHash:        agreement?.agreementHash || null,
    providerAgentId:      agreement?.providerAgentId || null,
    providerOwnerAddress: agreement?.providerOwnerAddress || null,
    requesterAgentId:     agreement?.requesterAgentId || null,
    taskType:             agreement?.taskType || 'test',
    resultHash:           computeResultHash(result),
    completedAt:          new Date().toISOString(),
  })
  writeDeliveryReceipt({ payload, gatewayAddress })
}

let passed = 0
let failed = 0

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}`)
    failed++
  }
}

// ── Setup ──────────────────────────────────────────────────────────────────────

const db = initDb(':memory:')

const ONE_DATA = 1_000_000_000_000_000_000n
const PRICE    = (ONE_DATA * 5n).toString()
const PROVIDER = '0xprovider-c'

seedRequester({
  rawKey: 'key-c', requesterAgentId: 'req-c',
  ownerAddress: '0xowner-c',
  remainingBaseUnits:  (ONE_DATA * 100n).toString(),
  maxPerTaskBaseUnits: (ONE_DATA * 10n).toString(),
  dailyLimitBaseUnits: (ONE_DATA * 50n).toString(),
})

const FIXED = { type: 'fixed', currency: 'DATA', amountBaseUnits: PRICE, decimals: 18, billingUnit: 'task' }

// Helper: write v1 task directly by temporarily downgrading agreementVersion in the DB.
// Simulates a pre-Phase-C task without gate.
function insertV1Task(taskId) {
  // writeSubmitted always uses AGREEMENT_VERSION='2', so we write then patch.
  writeSubmitted({ taskId, requesterAgentId: 'req-c', providerAgentId: 'agent-c',
    providerOwnerAddress: PROVIDER, taskType: 'test', pricingModel: FIXED })
  db.prepare(`UPDATE TaskAgreement SET agreementVersion = '1' WHERE taskId = ?`).run(taskId)
  // Also remove the proof row written by writeSubmitted (v2 wrote it, v1 shouldn't have it)
  db.prepare(`DELETE FROM TaskAgreementProof WHERE taskId = ?`).run(taskId)
}

// ── C1: computeResultHash — key order invariance ──────────────────────────────

console.log('\nC1: computeResultHash — same content, different key order → same hash')
{
  const h1 = computeResultHash({ a: 1, b: 2 })
  const h2 = computeResultHash({ b: 2, a: 1 })
  assert(h1 === h2, 'key-order-swapped objects produce the same hash')
  assert(typeof h1 === 'string' && h1.length === 64, 'hash is a 64-char hex string')
}

// ── C2: computeResultHash — nested key sorting ────────────────────────────────

console.log('\nC2: computeResultHash — nested objects are sorted recursively')
{
  const h1 = computeResultHash({ outer: { z: 99, a: 1 }, x: [{ b: 2, a: 1 }] })
  const h2 = computeResultHash({ x: [{ a: 1, b: 2 }], outer: { a: 1, z: 99 } })
  assert(h1 === h2, 'nested key order does not affect hash')
}

// ── C3: writeSubmitted writes TaskAgreementProof ──────────────────────────────

console.log('\nC3: writeSubmitted writes TaskAgreementProof with matching agreementHash')
{
  const { agreementHash } = writeSubmitted({
    taskId: 'task-c3', requesterAgentId: 'req-c', providerAgentId: 'agent-c',
    providerOwnerAddress: PROVIDER, taskType: 'test', pricingModel: FIXED,
  })
  const proof = db.prepare(`SELECT * FROM TaskAgreementProof WHERE taskId = ?`).get('task-c3')
  assert(proof !== undefined, 'TaskAgreementProof row exists')
  assert(proof.agreementHash === agreementHash, 'proof.agreementHash matches TaskAgreement.agreementHash')
  assert(proof.proofType === 'gateway-observed', 'proofType is gateway-observed')
}

// ── C4: evidence gate blocks charge — missing DeliveryReceipt ─────────────────

console.log('\nC4: evidence gate blocks charge when DeliveryReceipt is missing')
{
  writeSubmitted({ taskId: 'task-c4', requesterAgentId: 'req-c', providerAgentId: 'agent-c',
    providerOwnerAddress: PROVIDER, taskType: 'test', pricingModel: FIXED })
  markStatus('task-c4', 'completed')
  // DeliveryReceipt not written
  const result = chargeCompleted('task-c4')
  assert(!result.charged, 'charge rejected')
  assert(result.reason === 'missing_delivery_receipt', 'reason is missing_delivery_receipt')
}

// ── C5: evidence gate blocks charge — DeliveryReceipt agreementHash mismatch ──

console.log('\nC5: evidence gate blocks charge — DeliveryReceipt agreementHash mismatch')
{
  writeSubmitted({ taskId: 'task-c5', requesterAgentId: 'req-c', providerAgentId: 'agent-c',
    providerOwnerAddress: PROVIDER, taskType: 'test', pricingModel: FIXED })
  markStatus('task-c5', 'completed')
  // Insert receipt with wrong agreementHash
  db.prepare(`
    INSERT INTO DeliveryReceipt
      (taskId, agreementHash, providerAgentId, providerOwnerAddress,
       resultHash, proofType, proofPayloadJson, createdAt)
    VALUES (?, 'deadbeef-wrong-hash', 'agent-c', ?, 'fakehash', 'gateway-observed', '{}', datetime('now'))
  `).run('task-c5', PROVIDER)
  const result = chargeCompleted('task-c5')
  assert(!result.charged, 'charge rejected')
  assert(result.reason === 'delivery_receipt_hash_mismatch', 'reason is delivery_receipt_hash_mismatch')
}

// ── C6: evidence gate blocks charge — missing TaskAgreementProof ──────────────

console.log('\nC6: evidence gate blocks charge when TaskAgreementProof is missing')
{
  const { agreementHash } = writeSubmitted({
    taskId: 'task-c6', requesterAgentId: 'req-c', providerAgentId: 'agent-c',
    providerOwnerAddress: PROVIDER, taskType: 'test', pricingModel: FIXED,
  })
  markStatus('task-c6', 'completed')
  // Write a valid DeliveryReceipt
  db.prepare(`
    INSERT INTO DeliveryReceipt
      (taskId, agreementHash, providerAgentId, providerOwnerAddress,
       resultHash, proofType, proofPayloadJson, createdAt)
    VALUES (?, ?, 'agent-c', ?, 'fakehash', 'gateway-observed', '{}', datetime('now'))
  `).run('task-c6', agreementHash, PROVIDER)
  // Delete the proof row that writeSubmitted wrote
  db.prepare(`DELETE FROM TaskAgreementProof WHERE taskId = ?`).run('task-c6')
  const result = chargeCompleted('task-c6')
  assert(!result.charged, 'charge rejected')
  assert(result.reason === 'missing_agreement_proof', 'reason is missing_agreement_proof')
}

// ── C7: evidence gate blocks charge — TaskAgreementProof agreementHash mismatch

console.log('\nC7: evidence gate blocks charge — TaskAgreementProof agreementHash mismatch')
{
  const { agreementHash } = writeSubmitted({
    taskId: 'task-c7', requesterAgentId: 'req-c', providerAgentId: 'agent-c',
    providerOwnerAddress: PROVIDER, taskType: 'test', pricingModel: FIXED,
  })
  markStatus('task-c7', 'completed')
  // Valid DeliveryReceipt
  db.prepare(`
    INSERT INTO DeliveryReceipt
      (taskId, agreementHash, providerAgentId, providerOwnerAddress,
       resultHash, proofType, proofPayloadJson, createdAt)
    VALUES (?, ?, 'agent-c', ?, 'fakehash', 'gateway-observed', '{}', datetime('now'))
  `).run('task-c7', agreementHash, PROVIDER)
  // Corrupt the proof's agreementHash
  db.prepare(`UPDATE TaskAgreementProof SET agreementHash = 'deadbeef-wrong' WHERE taskId = ?`).run('task-c7')
  const result = chargeCompleted('task-c7')
  assert(!result.charged, 'charge rejected')
  assert(result.reason === 'agreement_proof_hash_mismatch', 'reason is agreement_proof_hash_mismatch')
}

// ── C8: full happy path — gate passes, charge succeeds ───────────────────────

console.log('\nC8: full happy path — both evidence records valid → charge succeeds')
{
  writeDeliveryReceipt  // ensure import is used
  const { agreementHash } = writeSubmitted({
    taskId: 'task-c8', requesterAgentId: 'req-c', providerAgentId: 'agent-c',
    providerOwnerAddress: PROVIDER, taskType: 'test', pricingModel: FIXED,
    gatewayAddress: '0xgateway',
  })
  markStatus('task-c8', 'completed')
  writeTestReceipt('task-c8', { answer: 42 }, { gatewayAddress: '0xgateway' })
  const result = chargeCompleted('task-c8')
  assert(result.charged === true, 'charge succeeds')
  // Verify DeliveryReceipt agreementHash
  const receipt = db.prepare(`SELECT * FROM DeliveryReceipt WHERE taskId = ?`).get('task-c8')
  assert(receipt.agreementHash === agreementHash, 'DeliveryReceipt.agreementHash matches')
  assert(receipt.resultHash.length === 64, 'resultHash is a valid SHA-256 hex string')
}

// ── C9: Phase A/B task (agreementVersion=1) bypasses gate ────────────────────

console.log('\nC9: agreementVersion=1 task bypasses evidence gate entirely')
{
  insertV1Task('task-c9')
  markStatus('task-c9', 'completed')
  // No DeliveryReceipt, no TaskAgreementProof — should still charge
  const result = chargeCompleted('task-c9')
  assert(result.charged === true, 'v1 task charges without evidence')
}

// ── C10: getTaskTrace returns Phase C fields ──────────────────────────────────

console.log('\nC10: getTaskTrace returns agreementProof and deliveryReceipt')
{
  writeSubmitted({ taskId: 'task-c10', requesterAgentId: 'req-c', providerAgentId: 'agent-c',
    providerOwnerAddress: PROVIDER, taskType: 'test', pricingModel: FIXED,
    gatewayAddress: '0xgateway' })
  markStatus('task-c10', 'completed')
  writeTestReceipt('task-c10', { ok: true }, { gatewayAddress: '0xgateway' })

  const trace = getTaskTrace('task-c10')
  assert(trace.agreementProof !== null, 'agreementProof present in trace')
  assert(trace.deliveryReceipt !== null, 'deliveryReceipt present in trace')
  assert(trace.agreementProof.proofType === 'gateway-observed', 'proof type correct')
  assert(trace.deliveryReceipt.resultHash.length === 64, 'deliveryReceipt has resultHash')

  // Task with no evidence should return nulls
  writeSubmitted({ taskId: 'task-c10b', requesterAgentId: 'req-c', providerAgentId: 'agent-c',
    providerOwnerAddress: PROVIDER, taskType: 'test', pricingModel: FIXED })
  db.prepare(`DELETE FROM TaskAgreementProof WHERE taskId = ?`).run('task-c10b')
  const trace2 = getTaskTrace('task-c10b')
  assert(trace2.agreementProof === null, 'agreementProof null when missing')
  assert(trace2.deliveryReceipt === null, 'deliveryReceipt null when missing')
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
