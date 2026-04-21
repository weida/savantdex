/**
 * Phase E — Dual attestation receipt unit tests.
 * Run: node --test backend/payment.phaseE.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Wallet } from 'ethers'
import { initDb, writeDeliveryReceipt, getDeliveryReceipt } from './payment.mjs'
import { buildAttestationPayload, signAttestation } from '../sdk/attestation.mjs'

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
