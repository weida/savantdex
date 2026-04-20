/**
 * Backend — Delivery Receipt Phase 1
 *
 * Builds the canonical receipt payload, signs it via the local signer gateway,
 * and produces a stable message string that off-chain verifiers can replay.
 *
 * Canonical form: JSON.stringify(sortKeysDeep(payload)).
 * Signature: EIP-191 personal_sign applied by the signer gateway.
 *
 * Required env:
 *   SIGNER_ADDRESS    URL of the local signer gateway (default: http://127.0.0.1:17099)
 *   SIGNER_TOKEN      Bearer token for the signer gateway
 *
 * If SIGNER_TOKEN is unset, receipts are written in their unsigned form
 * (proofType=gateway-observed), keeping backward compatibility with existing
 * DeliveryReceipt rows.
 */

const SIGNER_URL   = (process.env.SIGNER_ADDRESS || 'http://127.0.0.1:17099').replace(/\/$/, '')
const SIGNER_TOKEN = process.env.SIGNER_TOKEN || ''
const SIGN_TIMEOUT_MS = Number(process.env.RECEIPT_SIGN_TIMEOUT_MS || 2500)

export const RECEIPT_VERSION = 'v1'

function sortKeysDeep(val) {
  if (Array.isArray(val)) return val.map(sortKeysDeep)
  if (val !== null && typeof val === 'object') {
    return Object.keys(val).sort().reduce((acc, k) => { acc[k] = sortKeysDeep(val[k]); return acc }, {})
  }
  return val
}

/**
 * Build the canonical receipt payload object for a completed task.
 *
 * Fields are carefully chosen to represent "who did what for whom with what outcome",
 * in a form that a verifier can reproduce from task data + result content.
 */
export function buildReceiptPayload({
  taskId,
  agreementHash     = null,     // null when task had no payment agreement
  providerAgentId,
  providerOwnerAddress,
  requesterAgentId  = null,     // null when task had no authenticated requester
  taskType,
  resultHash,
  completedAt,
}) {
  return {
    version: RECEIPT_VERSION,
    taskId,
    agreementHash,
    providerAgentId,
    providerOwnerAddress: providerOwnerAddress ? providerOwnerAddress.toLowerCase() : null,
    requesterAgentId,
    taskType,
    resultHash,
    completedAt,
  }
}

/** Canonical message string (UTF-8) used as the EIP-191 signing input. */
export function canonicalReceiptMessage(payload) {
  return JSON.stringify(sortKeysDeep(payload))
}

/**
 * Ask the local signer gateway to sign the canonical receipt message.
 * Returns { signature, signerAddress } on success, or null if signing is
 * unavailable (no token, signer offline, timeout). Callers should write an
 * unsigned receipt when null is returned — never fail the task.
 */
export async function signReceiptPayload(payload) {
  return signCanonical(payload, canonicalReceiptMessage)
}

/**
 * Generic "sign a canonical object" helper. Used by both receipt signing and
 * registry-portability export signing — anywhere the platform needs to attest
 * to a specific payload shape, producing a signature a third party can recover.
 */
export async function signCanonical(payload, canonicalizer = canonicalReceiptMessage) {
  if (!SIGNER_TOKEN) return null

  const message = canonicalizer(payload)
  const payloadHex = Buffer.from(message, 'utf8').toString('hex')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SIGN_TIMEOUT_MS)

  try {
    const res = await fetch(`${SIGNER_URL}/sign-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signer-Token': SIGNER_TOKEN },
      body: JSON.stringify({ payload: payloadHex }),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.warn(`[Signer] responded ${res.status}`)
      return null
    }
    const { signature, address } = await res.json()
    if (!signature || !address) {
      console.warn('[Signer] returned malformed response')
      return null
    }
    return { signature, signerAddress: address.toLowerCase() }
  } catch (err) {
    console.warn(`[Signer] sign failed: ${err.message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── Registry portability export ───────────────────────────────────────────────

export const EXPORT_VERSION = 'v1'

/**
 * Build the canonical registry export payload. Only the stable, transferable
 * fields — no platform-specific cache/metrics. A provider can take this JSON
 * to another platform and re-register there under the same ownerAddress.
 */
export function buildExportPayload(registryRecord, extras = {}) {
  return {
    version:        EXPORT_VERSION,
    agentId:        registryRecord.agentId,
    ownerAddress:   registryRecord.ownerAddress ? registryRecord.ownerAddress.toLowerCase() : null,
    transport:      registryRecord.transport || (registryRecord.streamId?.startsWith('relay://') ? 'relay' : 'streamr'),
    capabilities:   registryRecord.capabilities || [],
    taskType:       registryRecord.taskType || null,
    pricingModel:   registryRecord.pricingModel || null,
    docsUrl:        registryRecord.docsUrl || null,
    registeredAt:   registryRecord.registeredAt || null,
    updatedAt:      registryRecord.updatedAt    || null,
    // exportedAt is not part of the signed payload-proper but is the "proof
    // freshness" timestamp — callers should treat exports older than a few
    // minutes as stale and re-request.
    exportedAt:     extras.exportedAt || new Date().toISOString(),
  }
}

export function canonicalExportMessage(payload) {
  return JSON.stringify(sortKeysDeep(payload))
}

export async function signExportPayload(payload) {
  return signCanonical(payload, canonicalExportMessage)
}
