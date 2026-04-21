import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Wallet } from 'ethers'
import {
  buildAttestationPayload,
  signAttestation,
} from '../sdk/attestation.mjs'
import { verifyProviderAttestation } from './attestation.mjs'

async function makeValid(wallet, overrides = {}) {
  const payload = buildAttestationPayload({
    taskId: 't-1',
    providerAgentId: 'agent-v1',
    providerOwnerAddress: wallet.address,
    resultHash: 'a'.repeat(64),
    completedAt: '2026-04-21T12:00:00.000Z',
    ...overrides,
  })
  return await signAttestation(payload, wallet)
}

test('accepts valid attestation', async () => {
  const w = Wallet.createRandom()
  const att = await makeValid(w)
  const r = verifyProviderAttestation({
    attestation: att,
    expectedTaskId:       't-1',
    expectedResultHash:   'a'.repeat(64),
    expectedOwnerAddress: w.address,
    expectedAgentId:      'agent-v1',
  })
  assert.equal(r.valid, true)
  assert.equal(r.recoveredAddress.toLowerCase(), w.address.toLowerCase())
})

test('rejects when signature recovers to wrong address', async () => {
  const w1 = Wallet.createRandom()
  const w2 = Wallet.createRandom()
  const att = await makeValid(w1, { providerOwnerAddress: w2.address })
  const r = verifyProviderAttestation({
    attestation: att,
    expectedTaskId:       't-1',
    expectedResultHash:   'a'.repeat(64),
    expectedOwnerAddress: w2.address,
    expectedAgentId:      'agent-v1',
  })
  assert.equal(r.valid, false)
  assert.match(r.reason, /signer/i)
})

test('rejects when resultHash mismatches', async () => {
  const w = Wallet.createRandom()
  const att = await makeValid(w)
  const r = verifyProviderAttestation({
    attestation: att,
    expectedTaskId:       't-1',
    expectedResultHash:   'b'.repeat(64),
    expectedOwnerAddress: w.address,
    expectedAgentId:      'agent-v1',
  })
  assert.equal(r.valid, false)
  assert.match(r.reason, /resultHash/i)
})

test('rejects when taskId mismatches', async () => {
  const w = Wallet.createRandom()
  const att = await makeValid(w)
  const r = verifyProviderAttestation({
    attestation: att,
    expectedTaskId:       't-999',
    expectedResultHash:   'a'.repeat(64),
    expectedOwnerAddress: w.address,
    expectedAgentId:      'agent-v1',
  })
  assert.equal(r.valid, false)
  assert.match(r.reason, /taskId/i)
})

test('rejects when agentId mismatches', async () => {
  const w = Wallet.createRandom()
  const att = await makeValid(w)
  const r = verifyProviderAttestation({
    attestation: att,
    expectedTaskId:       't-1',
    expectedResultHash:   'a'.repeat(64),
    expectedOwnerAddress: w.address,
    expectedAgentId:      'different-agent',
  })
  assert.equal(r.valid, false)
  assert.match(r.reason, /agentId/i)
})

test('rejects null / malformed attestation', () => {
  const r1 = verifyProviderAttestation({
    attestation: null,
    expectedTaskId: 't', expectedResultHash: 'x', expectedOwnerAddress: '0x0', expectedAgentId: 'a',
  })
  assert.equal(r1.valid, false)

  const r2 = verifyProviderAttestation({
    attestation: { payload: { taskId: 't-1' } },
    expectedTaskId: 't-1', expectedResultHash: 'x', expectedOwnerAddress: '0x0', expectedAgentId: 'a',
  })
  assert.equal(r2.valid, false)
})

test('rejects wrong version', async () => {
  const w = Wallet.createRandom()
  const att = await makeValid(w)
  att.payload.version = 'v2'
  const r = verifyProviderAttestation({
    attestation: att,
    expectedTaskId: 't-1', expectedResultHash: 'a'.repeat(64),
    expectedOwnerAddress: w.address, expectedAgentId: 'agent-v1',
  })
  assert.equal(r.valid, false)
})
