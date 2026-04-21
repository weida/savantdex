/**
 * Gateway-side verifier for provider delivery attestations.
 *
 * Takes the provider's signed attestation plus the values the gateway already
 * knows authoritatively (taskId it dispatched, resultHash it computed, the
 * ownerAddress that was registered for providerAgentId). Returns whether the
 * attestation is consistent and came from the registered owner wallet.
 *
 * Never throws on bad input — returns `{ valid: false, reason }` so callers
 * can log and degrade gracefully to gateway-signed-v1.
 */

import { ethers } from 'ethers'
import {
  ATTESTATION_VERSION,
  canonicalAttestationMessage,
} from '../sdk/attestation.mjs'

// backend depends on ethers v5 (see backend/node_modules); v5 exposes
// verifyMessage under ethers.utils. sdk depends on ethers v6.
const verifyMessage = ethers.verifyMessage ?? ethers.utils.verifyMessage

export function verifyProviderAttestation({
  attestation,
  expectedTaskId,
  expectedResultHash,
  expectedOwnerAddress,
  expectedAgentId,
}) {
  if (!attestation || !attestation.payload || !attestation.signature) {
    return { valid: false, reason: 'missing attestation fields' }
  }
  const { payload, signature } = attestation

  if (payload.version !== ATTESTATION_VERSION) {
    return { valid: false, reason: `unsupported attestation version ${payload.version}` }
  }
  if (payload.taskId !== expectedTaskId) {
    return { valid: false, reason: `taskId mismatch (got ${payload.taskId})` }
  }
  if (payload.resultHash !== expectedResultHash) {
    return { valid: false, reason: 'resultHash mismatch' }
  }
  if (payload.providerAgentId !== expectedAgentId) {
    return { valid: false, reason: `agentId mismatch (got ${payload.providerAgentId})` }
  }

  let recovered
  try {
    recovered = verifyMessage(canonicalAttestationMessage(payload), signature)
  } catch (err) {
    return { valid: false, reason: `signature recovery failed: ${err.message}` }
  }

  const expectedLower  = String(expectedOwnerAddress || '').toLowerCase()
  const recoveredLower = recovered.toLowerCase()
  if (recoveredLower !== expectedLower) {
    return {
      valid: false,
      reason: `signer address mismatch (recovered ${recoveredLower}, expected ${expectedLower})`,
      recoveredAddress: recovered,
    }
  }
  if (payload.providerOwnerAddress && payload.providerOwnerAddress.toLowerCase() !== expectedLower) {
    return { valid: false, reason: 'payload.providerOwnerAddress mismatch' }
  }

  return { valid: true, recoveredAddress: recovered }
}
