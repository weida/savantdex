import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Wallet, verifyMessage } from 'ethers'
import { canonicalJson } from '../sdk/canonical.mjs'
import {
  ATTESTATION_VERSION,
  buildAttestationPayload,
  canonicalAttestationMessage,
  signAttestation,
} from '../sdk/attestation.mjs'

test('buildAttestationPayload: produces fixed-shape payload', () => {
  const p = buildAttestationPayload({
    taskId: 't-1',
    providerAgentId: 'agent-v1',
    providerOwnerAddress: '0xABCDEF0000000000000000000000000000000001',
    resultHash: 'a'.repeat(64),
    completedAt: '2026-04-21T12:00:00.000Z',
  })
  assert.equal(p.version, ATTESTATION_VERSION)
  assert.equal(p.taskId, 't-1')
  assert.equal(p.providerAgentId, 'agent-v1')
  assert.equal(p.providerOwnerAddress, '0xabcdef0000000000000000000000000000000001')
  assert.equal(p.resultHash, 'a'.repeat(64))
  assert.equal(p.completedAt, '2026-04-21T12:00:00.000Z')
  assert.deepEqual(Object.keys(p).sort(),
    ['completedAt', 'providerAgentId', 'providerOwnerAddress', 'resultHash', 'taskId', 'version'])
})

test('canonicalAttestationMessage: equals canonicalJson of payload', () => {
  const p = buildAttestationPayload({
    taskId: 't-1',
    providerAgentId: 'agent-v1',
    providerOwnerAddress: '0x0000000000000000000000000000000000000001',
    resultHash: 'b'.repeat(64),
    completedAt: '2026-04-21T12:00:00.000Z',
  })
  assert.equal(canonicalAttestationMessage(p), canonicalJson(p))
})

test('signAttestation: signature recovers to signer address', async () => {
  const wallet = Wallet.createRandom()
  const payload = buildAttestationPayload({
    taskId: 't-2',
    providerAgentId: 'agent-v1',
    providerOwnerAddress: wallet.address,
    resultHash: 'c'.repeat(64),
    completedAt: '2026-04-21T12:00:00.000Z',
  })
  const { signature } = await signAttestation(payload, wallet)
  const recovered = verifyMessage(canonicalAttestationMessage(payload), signature)
  assert.equal(recovered.toLowerCase(), wallet.address.toLowerCase())
})

test('signAttestation: returns both payload and signature', async () => {
  const wallet = Wallet.createRandom()
  const payload = buildAttestationPayload({
    taskId: 't-3',
    providerAgentId: 'agent-v1',
    providerOwnerAddress: wallet.address,
    resultHash: 'd'.repeat(64),
    completedAt: '2026-04-21T12:00:00.000Z',
  })
  const result = await signAttestation(payload, wallet)
  assert.equal(typeof result.signature, 'string')
  assert.equal(result.signature.startsWith('0x'), true)
  assert.deepEqual(result.payload, payload)
})
