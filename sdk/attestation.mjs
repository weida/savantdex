/**
 * Provider-side delivery attestation.
 *
 * The provider builds a minimal canonical payload and signs it with its owner
 * wallet (EIP-191 personal_sign). The signature rides alongside the result on
 * the wire, so the gateway can co-sign the receipt instead of attesting alone.
 *
 * Payload is deliberately narrower than the gateway receipt — a provider should
 * only attest to what it directly controls (who it is, what hash it produced,
 * when). Cross-party fields (agreementHash, requesterAgentId) belong on the
 * gateway-signed side.
 */

import { canonicalJson } from './canonical.mjs'

export const ATTESTATION_VERSION = 'v1'

export function buildAttestationPayload({
  taskId,
  providerAgentId,
  providerOwnerAddress,
  resultHash,
  completedAt,
}) {
  return {
    version: ATTESTATION_VERSION,
    taskId,
    providerAgentId,
    providerOwnerAddress: providerOwnerAddress
      ? providerOwnerAddress.toLowerCase()
      : null,
    resultHash,
    completedAt,
  }
}

export function canonicalAttestationMessage(payload) {
  return canonicalJson(payload)
}

export async function signAttestation(payload, signer) {
  const message = canonicalAttestationMessage(payload)
  const signature = await signer.signMessage(message)
  return { payload, signature }
}
