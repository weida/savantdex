/**
 * Proof of Work challenge/verify for self-service registration.
 *
 * Challenge: server issues { challengeId, prefix, difficulty }.
 * Client finds nonce such that SHA-256(prefix + nonce) has `difficulty` leading zero bits.
 * At difficulty=20 (~1M hashes), this takes ~1-2s on typical hardware.
 *
 * Challenges are ephemeral (in-memory, 5-min TTL, single-use).
 */

import { createHash, randomBytes, randomUUID } from 'crypto'

const POW_DIFFICULTY = Number(process.env.POW_DIFFICULTY) || 20
const CHALLENGE_TTL_MS = 5 * 60 * 1000  // 5 minutes

const challenges = new Map()  // challengeId → { prefix, difficulty, createdAt, used }

// ── Public API ───────────────────────────────────────────────────────────────

export function createPowChallenge(difficulty = POW_DIFFICULTY) {
  const challengeId = randomUUID()
  const prefix = randomBytes(16).toString('hex')
  challenges.set(challengeId, { prefix, difficulty, createdAt: Date.now(), used: false })
  return { challengeId, prefix, difficulty }
}

export function verifyPow(challengeId, nonce) {
  const entry = challenges.get(challengeId)
  if (!entry) {
    const e = new Error('Challenge not found or expired')
    e.code = 'POW_INVALID'; throw e
  }
  if (entry.used) {
    const e = new Error('Challenge already used')
    e.code = 'POW_INVALID'; throw e
  }
  if (Date.now() - entry.createdAt > CHALLENGE_TTL_MS) {
    challenges.delete(challengeId)
    const e = new Error('Challenge expired')
    e.code = 'POW_INVALID'; throw e
  }
  if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > 20) {
    const e = new Error('Invalid nonce')
    e.code = 'POW_INVALID'; throw e
  }

  const hash = createHash('sha256').update(entry.prefix + nonce).digest()
  if (!hasLeadingZeroBits(hash, entry.difficulty)) {
    const e = new Error('PoW solution incorrect')
    e.code = 'POW_INVALID'; throw e
  }

  entry.used = true
}

// ── Internals ────────────────────────────────────────────────────────────────

function hasLeadingZeroBits(buf, bits) {
  const fullBytes = Math.floor(bits / 8)
  const remainBits = bits % 8
  for (let i = 0; i < fullBytes; i++) {
    if (buf[i] !== 0) return false
  }
  if (remainBits > 0) {
    const mask = 0xFF << (8 - remainBits)  // e.g. remainBits=4 → 0xF0
    if ((buf[fullBytes] & mask) !== 0) return false
  }
  return true
}

// Periodic cleanup: evict expired entries so the Map does not grow unbounded.
setInterval(() => {
  const cutoff = Date.now() - CHALLENGE_TTL_MS
  for (const [id, entry] of challenges) {
    if (entry.createdAt < cutoff) challenges.delete(id)
  }
}, 60_000).unref()
