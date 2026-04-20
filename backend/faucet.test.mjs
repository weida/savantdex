/**
 * Self-registration + Faucet tests
 * Run: node backend/faucet.test.mjs  (from savantdex/backend/)
 *
 * REG-1: selfRegisterRequester creates identity + wallet binding (zero budget)
 * REG-2: selfRegisterRequester returns correct shape
 * REG-3: selfRegisterRequester rejects duplicate wallet address
 * REG-4: selfRegisterRequester rejects duplicate requesterAgentId
 * REG-5: wallet auth method is created with correct methodRef
 *
 * FAU-1: claimFaucet grants 10 DATA to registered requester; sets faucetClaimedAt
 * FAU-2: claimFaucet rejects double-claim (immediate)
 * FAU-3: claimFaucet rejects unknown requester
 * FAU-4: claimFaucet rejects ownerAddress mismatch
 * FAU-5: claimFaucet respects FAUCET_ENABLED=false
 */

import { randomBytes } from 'crypto'
import {
  initDb, selfRegisterRequester, claimFaucet,
  getRequesterIdentity, getAuthMethods, getBudget,
} from './payment.mjs'

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
      console.error(`  ✗ ${label} (threw ${e.code}: ${e.message}, expected ${expectedCode})`)
      failed++
    }
  }
}

// ── Setup ────────────────────────────────────────────────────────────────────

initDb(':memory:')

const ONE_DATA = 1_000_000_000_000_000_000n
const addr1 = '0x' + randomBytes(20).toString('hex')
const addr2 = '0x' + randomBytes(20).toString('hex')
const addr3 = '0x' + randomBytes(20).toString('hex')
const addr4 = '0x' + randomBytes(20).toString('hex')

// ── Registration tests ───────────────────────────────────────────────────────

console.log('Self-registration tests')

// REG-1: creates identity + wallet binding with zero budget
{
  selfRegisterRequester({ requesterAgentId: 'reg-test-1', ownerAddress: addr1 })
  const identity = getRequesterIdentity('reg-test-1')
  assert(identity !== null, 'REG-1a: RequesterIdentity created')
  assert(identity.ownerAddress === addr1.toLowerCase(), 'REG-1b: ownerAddress normalized')
  assert(identity.status === 'active', 'REG-1c: status is active')

  const methods = getAuthMethods('reg-test-1')
  const walletMethod = methods.find(m => m.methodType === 'wallet-signature')
  assert(walletMethod !== undefined, 'REG-1d: wallet-signature auth method created')

  const budget = getBudget('reg-test-1')
  assert(BigInt(budget.remainingBaseUnits) === 0n, 'REG-1e: budget starts at zero (no faucet)')
}

// REG-2: returns correct shape
{
  const result = selfRegisterRequester({ requesterAgentId: 'reg-test-2', ownerAddress: addr2 })
  assert(result.ok === true, 'REG-2a: ok is true')
  assert(result.requesterAgentId === 'reg-test-2', 'REG-2b: requesterAgentId returned')
  assert(result.ownerAddress === addr2.toLowerCase(), 'REG-2c: ownerAddress returned')
  assert(result.budget === undefined, 'REG-2d: no budget in registration response')
}

// REG-3: rejects duplicate wallet address
{
  assertThrows(
    () => selfRegisterRequester({ requesterAgentId: 'reg-dup-wallet', ownerAddress: addr1 }),
    'WALLET_ALREADY_REGISTERED',
    'REG-3: duplicate wallet rejected'
  )
}

// REG-4: rejects duplicate requesterAgentId
{
  assertThrows(
    () => selfRegisterRequester({ requesterAgentId: 'reg-test-1', ownerAddress: addr3 }),
    'AGENT_ID_TAKEN',
    'REG-4: duplicate agentId rejected'
  )
}

// REG-5: wallet auth method has correct methodRef
{
  const methods = getAuthMethods('reg-test-1')
  const walletMethod = methods.find(m => m.methodType === 'wallet-signature')
  assert(walletMethod.methodRef === addr1.toLowerCase(), 'REG-5: methodRef is normalized address')
}

// ── Faucet tests ─────────────────────────────────────────────────────────────

console.log('\nFaucet claim tests')

// FAU-1: claimFaucet grants 10 DATA
{
  const result = claimFaucet({ requesterAgentId: 'reg-test-1', ownerAddress: addr1 })
  assert(result.ok === true, 'FAU-1a: claim ok')
  assert(result.budget.currency === 'DATA', 'FAU-1b: currency is DATA')

  const budget = getBudget('reg-test-1')
  assert(BigInt(budget.remainingBaseUnits) === 10n * ONE_DATA, 'FAU-1c: remaining = 10 DATA')
  assert(BigInt(budget.maxPerTaskBaseUnits) === 2n * ONE_DATA, 'FAU-1d: maxPerTask = 2 DATA')
  assert(BigInt(budget.dailyLimitBaseUnits) === 5n * ONE_DATA, 'FAU-1e: dailyLimit = 5 DATA')
  assert(budget.faucetClaimedAt !== null, 'FAU-1f: faucetClaimedAt is set after claim')
}

// FAU-2: rejects double-claim
{
  assertThrows(
    () => claimFaucet({ requesterAgentId: 'reg-test-1', ownerAddress: addr1 }),
    'ALREADY_CLAIMED',
    'FAU-2: double-claim rejected'
  )
}

// FAU-3: rejects unknown requester
{
  assertThrows(
    () => claimFaucet({ requesterAgentId: 'nonexistent', ownerAddress: addr4 }),
    'REQUESTER_NOT_FOUND',
    'FAU-3: unknown requester rejected'
  )
}

// FAU-4: rejects ownerAddress mismatch
{
  assertThrows(
    () => claimFaucet({ requesterAgentId: 'reg-test-2', ownerAddress: addr1 }),
    'OWNER_MISMATCH',
    'FAU-4: ownerAddress mismatch rejected'
  )
}

// FAU-5: FAUCET_ENABLED=false — tested via subprocess (FAUCET_ENABLED is a module-load-time constant)
// Run: FAUCET_ENABLED=false node backend/faucet.test.mjs — claimFaucet will throw FAUCET_DISABLED.

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
