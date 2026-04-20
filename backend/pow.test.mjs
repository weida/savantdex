/**
 * PoW module tests
 * Run: node backend/pow.test.mjs
 *
 * POW-1: createPowChallenge returns { challengeId, prefix, difficulty }
 * POW-2: verifyPow accepts correct nonce
 * POW-3: verifyPow rejects incorrect nonce
 * POW-4: verifyPow rejects reuse (single-use)
 * POW-5: verifyPow rejects unknown challengeId
 * POW-6: verifyPow rejects empty/invalid nonce
 * POW-7: difficulty override works
 */

import { createHash } from 'crypto'
import { createPowChallenge, verifyPow } from '../sdk/pow.mjs'

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

function assertThrows(fn, expectedCode, label) {
  try {
    fn()
    console.error(`  ✗ ${label} (did not throw)`)
    failed++
  } catch (e) {
    if (e.code === expectedCode) {
      console.log(`  ✓ ${label}`)
      passed++
    } else {
      console.error(`  ✗ ${label} (threw ${e.code}, expected ${expectedCode})`)
      failed++
    }
  }
}

/** Brute-force solve a PoW challenge (for testing). */
function solvePow(prefix, difficulty) {
  for (let nonce = 0; ; nonce++) {
    const hash = createHash('sha256').update(prefix + String(nonce)).digest()
    const fullBytes = Math.floor(difficulty / 8)
    const remainBits = difficulty % 8
    let ok = true
    for (let i = 0; i < fullBytes; i++) {
      if (hash[i] !== 0) { ok = false; break }
    }
    if (ok && remainBits > 0) {
      const mask = 0xFF << (8 - remainBits)
      if ((hash[fullBytes] & mask) !== 0) ok = false
    }
    if (ok) return String(nonce)
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('PoW module tests')

// POW-1: createPowChallenge shape
{
  const c = createPowChallenge()
  assert(typeof c.challengeId === 'string' && c.challengeId.length > 0, 'POW-1: challengeId is non-empty string')
  assert(typeof c.prefix === 'string' && c.prefix.length === 32, 'POW-1: prefix is 32-char hex')
  assert(typeof c.difficulty === 'number' && c.difficulty > 0, 'POW-1: difficulty is positive number')
}

// POW-2: verifyPow accepts correct nonce
{
  const c = createPowChallenge(8)  // low difficulty for fast test
  const nonce = solvePow(c.prefix, c.difficulty)
  verifyPow(c.challengeId, nonce)  // should not throw
  assert(true, 'POW-2: correct nonce accepted')
}

// POW-3: verifyPow rejects incorrect nonce
{
  const c = createPowChallenge(8)
  assertThrows(() => verifyPow(c.challengeId, 'definitely-wrong-nonce'), 'POW_INVALID', 'POW-3: incorrect nonce rejected')
}

// POW-4: verifyPow rejects reuse
{
  const c = createPowChallenge(8)
  const nonce = solvePow(c.prefix, c.difficulty)
  verifyPow(c.challengeId, nonce)
  assertThrows(() => verifyPow(c.challengeId, nonce), 'POW_INVALID', 'POW-4: reuse rejected')
}

// POW-5: verifyPow rejects unknown challengeId
{
  assertThrows(() => verifyPow('non-existent-id', '0'), 'POW_INVALID', 'POW-5: unknown challengeId rejected')
}

// POW-6: verifyPow rejects empty/invalid nonce
{
  const c = createPowChallenge(8)
  assertThrows(() => verifyPow(c.challengeId, ''), 'POW_INVALID', 'POW-6a: empty nonce rejected')
  const c2 = createPowChallenge(8)
  assertThrows(() => verifyPow(c2.challengeId, 123), 'POW_INVALID', 'POW-6b: non-string nonce rejected')
}

// POW-7: difficulty override works
{
  const c = createPowChallenge(4)  // very low
  assert(c.difficulty === 4, 'POW-7: difficulty override respected')
  const nonce = solvePow(c.prefix, c.difficulty)
  verifyPow(c.challengeId, nonce)
  assert(true, 'POW-7: low-difficulty solution accepted')
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
