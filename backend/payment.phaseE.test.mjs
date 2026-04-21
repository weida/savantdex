/**
 * Phase E — Dual attestation receipt unit tests.
 * Run: node --test backend/payment.phaseE.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Wallet, ethers } from 'ethers'
import { initDb, writeDeliveryReceipt, getDeliveryReceipt } from './payment.mjs'
import { buildAttestationPayload, signAttestation, canonicalAttestationMessage } from '../sdk/attestation.mjs'
import { computeResultHash } from '../sdk/canonical.mjs'
import { verifyProviderAttestation } from './attestation.mjs'

const verifyMessage = ethers.verifyMessage ?? ethers.utils.verifyMessage

initDb(':memory:')

test('dual-signed-v1: writeDeliveryReceipt persists provider attestation', async () => {
  const provider = Wallet.createRandom()
  const taskId   = 'dual-1'
  const resultHash = 'f'.repeat(64)

  const attPayload = buildAttestationPayload({
    taskId,
    providerAgentId:      'dual-agent',
    providerOwnerAddress: provider.address,
    resultHash,
    completedAt:          '2026-04-21T12:00:00.000Z',
  })
  const { signature: attSig } = await signAttestation(attPayload, provider)

  const gatewayPayload = {
    version: 'v1',
    taskId,
    agreementHash:        'agree-1',
    providerAgentId:      'dual-agent',
    providerOwnerAddress: provider.address.toLowerCase(),
    requesterAgentId:     'req-funded',
    taskType:             'dual-test',
    resultHash,
    completedAt:          '2026-04-21T12:00:00.000Z',
  }

  writeDeliveryReceipt({
    payload:       gatewayPayload,
    signedPayload: gatewayPayload,
    signature:     '0x' + '11'.repeat(65),
    signerAddress: '0xgateway',
    gatewayAddress: '0xgateway',
    providerAttestation: {
      payload:   attPayload,
      signature: attSig,
      address:   provider.address.toLowerCase(),
    },
  })

  const r = getDeliveryReceipt(taskId)
  assert.ok(r, 'receipt row exists')
  assert.equal(r.proofType, 'dual-signed-v1')
  assert.ok(r.providerAttestation, 'providerAttestation surfaced')
  assert.equal(r.providerAttestation.signature, attSig)
  assert.equal(r.providerAttestation.address.toLowerCase(), provider.address.toLowerCase())
  assert.equal(r.providerAttestation.payload.resultHash, resultHash)
})

test('gateway-signed-v1 when only gateway signs (no provider attestation)', () => {
  const taskId = 'gw-only-1'
  const resultHash = 'e'.repeat(64)
  const gatewayPayload = {
    version: 'v1', taskId, agreementHash: 'agree-2',
    providerAgentId: 'dual-agent', providerOwnerAddress: '0xabc',
    requesterAgentId: 'req-funded', taskType: 'dual-test',
    resultHash, completedAt: '2026-04-21T12:00:00.000Z',
  }
  writeDeliveryReceipt({
    payload: gatewayPayload, signedPayload: gatewayPayload,
    signature: '0x' + '22'.repeat(65), signerAddress: '0xgateway',
    gatewayAddress: '0xgateway',
    providerAttestation: null,
  })

  const r = getDeliveryReceipt(taskId)
  assert.equal(r.proofType, 'gateway-signed-v1')
  assert.equal(r.providerAttestation, null)
})

test('gateway-observed when neither signs', () => {
  const taskId = 'obs-1'
  writeDeliveryReceipt({
    payload: {
      taskId, resultHash: 'd'.repeat(64),
      providerAgentId: 'a', providerOwnerAddress: '0xa',
      agreementHash: 'ag',
    },
    gatewayAddress: '0xgateway',
  })
  const r = getDeliveryReceipt(taskId)
  assert.equal(r.proofType, 'gateway-observed')
  assert.equal(r.providerAttestation, null)
})

test('E2E: provider signs → gateway verifies → receipt round-trips → signer recovers', async () => {
  const provider = Wallet.createRandom()
  const taskId   = 'e2e-dual-1'
  const result   = { answer: 42, trace: ['a', 'b', 'c'] }
  const resultHash = computeResultHash(result)

  const att = await signAttestation(
    buildAttestationPayload({
      taskId,
      providerAgentId:      'e2e-agent',
      providerOwnerAddress: provider.address,
      resultHash,
      completedAt:          '2026-04-21T12:00:00.000Z',
    }),
    provider,
  )

  const check = verifyProviderAttestation({
    attestation: att,
    expectedTaskId:       taskId,
    expectedResultHash:   resultHash,
    expectedOwnerAddress: provider.address,
    expectedAgentId:      'e2e-agent',
  })
  assert.equal(check.valid, true)

  const gatewayPayload = {
    version: 'v1', taskId, agreementHash: 'agree-e2e',
    providerAgentId: 'e2e-agent', providerOwnerAddress: provider.address.toLowerCase(),
    requesterAgentId: 'req-e2e', taskType: 'dual', resultHash,
    completedAt: '2026-04-21T12:00:00.000Z',
  }
  writeDeliveryReceipt({
    payload:            gatewayPayload,
    signedPayload:      gatewayPayload,
    signature:          '0x' + '44'.repeat(65),
    signerAddress:      '0xgateway',
    gatewayAddress:     '0xgateway',
    providerAttestation: {
      payload:   att.payload,
      signature: att.signature,
      address:   check.recoveredAddress.toLowerCase(),
    },
  })

  const r = getDeliveryReceipt(taskId)
  assert.equal(r.proofType, 'dual-signed-v1')
  assert.ok(r.providerAttestation)

  const recovered = verifyMessage(
    canonicalAttestationMessage(r.providerAttestation.payload),
    r.providerAttestation.signature,
  )
  assert.equal(recovered.toLowerCase(), provider.address.toLowerCase())
  assert.equal(r.providerAttestation.payload.resultHash, r.payload.resultHash)
})

test('fallback: tampered attestation is rejected, receipt degrades to gateway-signed-v1', async () => {
  const provider = Wallet.createRandom()
  const taskId   = 'e2e-fallback-1'
  const result   = { v: 1 }
  const resultHash = computeResultHash(result)

  // Provider signs a payload that lies about the resultHash
  const att = await signAttestation(
    buildAttestationPayload({
      taskId, providerAgentId: 'e2e-agent',
      providerOwnerAddress: provider.address,
      resultHash: 'deadbeef' + 'd'.repeat(56),   // mismatches gateway's view
      completedAt: '2026-04-21T12:00:00.000Z',
    }),
    provider,
  )
  const check = verifyProviderAttestation({
    attestation: att,
    expectedTaskId: taskId, expectedResultHash: resultHash,
    expectedOwnerAddress: provider.address, expectedAgentId: 'e2e-agent',
  })
  assert.equal(check.valid, false)

  const gatewayPayload = {
    version: 'v1', taskId, agreementHash: null,
    providerAgentId: 'e2e-agent', providerOwnerAddress: provider.address.toLowerCase(),
    requesterAgentId: 'req-e2e', taskType: 'dual', resultHash,
    completedAt: '2026-04-21T12:00:00.000Z',
  }
  writeDeliveryReceipt({
    payload:        gatewayPayload,
    signedPayload:  gatewayPayload,
    signature:      '0x' + '55'.repeat(65),
    signerAddress:  '0xgateway',
    gatewayAddress: '0xgateway',
    providerAttestation: null,     // gateway refused to include the invalid one
  })

  const r = getDeliveryReceipt(taskId)
  assert.equal(r.proofType, 'gateway-signed-v1')
  assert.equal(r.providerAttestation, null)
})
