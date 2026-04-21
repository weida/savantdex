#!/usr/bin/env node
/**
 * verify-receipt.mjs — verify a Phase-1 signed delivery receipt.
 *
 * What this proves:
 *   - The backend observed this task completing with `resultHash`
 *   - The gateway-controlled key at `signerAddress` signed that observation
 *
 * What this does NOT prove (by design):
 *   - That the result content matches `resultHash` (verifier must have the
 *     result JSON and recompute the hash independently)
 *   - That the provider's own signature was over the result (provider-side
 *     signing is Phase 2, not this phase)
 *
 * Usage:
 *   node verify-receipt.mjs <receipt-url>
 *     e.g. node verify-receipt.mjs https://savantdex.weicao.dev/api/receipts/task-abc...
 *
 *   node verify-receipt.mjs --file receipt.json
 *
 *   Optional:  --expected-signer 0x...    fail unless recovered == expected
 *              --result-file   result.json  also verify resultHash matches the raw result
 */

import { verifyMessage } from 'ethers'
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { sortKeysDeep } from '../sdk/canonical.mjs'

const args = process.argv.slice(2)

function arg(flag) {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}

const src          = args.find(a => !a.startsWith('--'))
const fileFlag     = arg('--file')
const expectedSig  = arg('--expected-signer')?.toLowerCase()
const resultFile   = arg('--result-file')

if (!src && !fileFlag) {
  console.error('Usage: node verify-receipt.mjs <url-or-taskId> [--file path] [--expected-signer 0x...] [--result-file path]')
  process.exit(2)
}

async function loadReceipt() {
  if (fileFlag) {
    return JSON.parse(await readFile(fileFlag, 'utf8'))
  }
  const res = await fetch(src)
  if (!res.ok) throw new Error(`fetch ${src} → ${res.status}`)
  return res.json()
}

const c = {
  ok:    s => `\x1b[32m${s}\x1b[0m`,
  bad:   s => `\x1b[31m${s}\x1b[0m`,
  warn:  s => `\x1b[33m${s}\x1b[0m`,
  dim:   s => `\x1b[2m${s}\x1b[0m`,
  bold:  s => `\x1b[1m${s}\x1b[0m`,
}

const receipt = await loadReceipt()
let failed = false

console.log(c.bold('═══ SavantDex Receipt Verifier ═══\n'))
console.log(`  taskId     : ${receipt.taskId}`)
console.log(`  proofType  : ${receipt.proofType}`)
console.log(`  createdAt  : ${receipt.createdAt}`)

if (receipt.proofType !== 'gateway-signed-v1') {
  console.log(c.warn(`\n  ⚠ This receipt is not a Phase-1 signed receipt (got ${receipt.proofType}).`))
  console.log(c.dim('    The gateway observed this task completing, but did not sign the observation.'))
  console.log(c.dim('    Typical causes: SIGNER_TOKEN not configured on backend, signer service offline.'))
  process.exit(3)
}

const { payload, signature, signerAddress } = receipt
if (!payload || !signature || !signerAddress) {
  console.log(c.bad('\n  ✗ Missing signed fields (payload / signature / signerAddress).'))
  process.exit(3)
}

// 1) Re-canonicalize payload and verify signature
const canonicalMsg = JSON.stringify(sortKeysDeep(payload))
let recovered
try {
  recovered = verifyMessage(canonicalMsg, signature).toLowerCase()
} catch (err) {
  console.log(c.bad(`\n  ✗ Signature recovery failed: ${err.message}`))
  process.exit(1)
}

const expectedClaimed = signerAddress.toLowerCase()
const sigMatches      = recovered === expectedClaimed

console.log('\n' + c.bold('Signature check:'))
console.log(`  claimed signer   : ${expectedClaimed}`)
console.log(`  recovered signer : ${recovered}`)
console.log(`  match            : ${sigMatches ? c.ok('✓') : c.bad('✗')}`)
if (!sigMatches) failed = true

if (expectedSig) {
  const trustMatches = recovered === expectedSig
  console.log(`  expected signer  : ${expectedSig}`)
  console.log(`  trust match      : ${trustMatches ? c.ok('✓') : c.bad('✗')}`)
  if (!trustMatches) failed = true
}

// 2) Optional: verify resultHash against a raw result file
if (resultFile) {
  const raw = JSON.parse(await readFile(resultFile, 'utf8'))
  const computed = createHash('sha256').update(JSON.stringify(sortKeysDeep(raw))).digest('hex')
  const match = computed === payload.resultHash
  console.log('\n' + c.bold('Result hash check:'))
  console.log(`  payload.resultHash : ${payload.resultHash}`)
  console.log(`  recomputed         : ${computed}`)
  console.log(`  match              : ${match ? c.ok('✓') : c.bad('✗')}`)
  if (!match) failed = true
}

// 3) Payload summary
console.log('\n' + c.bold('Payload:'))
for (const [k, v] of Object.entries(payload)) {
  console.log(`  ${k.padEnd(22)}: ${v}`)
}

if (failed) {
  console.log('\n' + c.bad(c.bold('RECEIPT VERIFICATION FAILED')))
  process.exit(1)
}
console.log('\n' + c.ok(c.bold('RECEIPT VERIFIED')))
