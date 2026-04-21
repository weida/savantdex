/**
 * Shared canonicalization helpers.
 *
 * Single source of truth for the JSON shape that gets hashed / signed.
 * Used by receipt builder, payment ledger, provider attestation, and the
 * external verifier CLIs. Any change here is a wire-format change — version
 * the receipt/attestation payload before touching.
 */

import { createHash } from 'crypto'

export function sortKeysDeep(val) {
  if (Array.isArray(val)) return val.map(sortKeysDeep)
  if (val !== null && typeof val === 'object') {
    return Object.keys(val).sort().reduce((acc, k) => {
      acc[k] = sortKeysDeep(val[k])
      return acc
    }, {})
  }
  return val
}

export function canonicalJson(payload) {
  return JSON.stringify(sortKeysDeep(payload))
}

export function computeResultHash(result) {
  return createHash('sha256').update(canonicalJson(result)).digest('hex')
}
