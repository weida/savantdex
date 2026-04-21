#!/usr/bin/env node
/**
 * verify-export.mjs — verify a signed registry export.
 *
 * Usage:
 *   node verify-export.mjs <export-url>
 *     e.g. node verify-export.mjs https://savantdex.weicao.dev/api/agents/token-risk-screener-v1/export
 *
 *   Optional:
 *     --file path              read export from a local JSON file instead of URL
 *     --expected-signer 0x...  fail unless recovered signer matches this
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

const src         = args.find(a => !a.startsWith('--'))
const fileFlag    = arg('--file')
const expectedSig = arg('--expected-signer')?.toLowerCase()

if (!src && !fileFlag) {
  console.error('Usage: node verify-export.mjs <url> [--file path] [--expected-signer 0x...]')
  process.exit(2)
}

async function load() {
  if (fileFlag) return JSON.parse(await readFile(fileFlag, 'utf8'))
  const res = await fetch(src)
  if (!res.ok) throw new Error(`fetch ${src} → ${res.status}`)
  return res.json()
}

const c = {
  ok: s => `\x1b[32m${s}\x1b[0m`, bad: s => `\x1b[31m${s}\x1b[0m`,
  warn: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
}

const exp = await load()
let failed = false

console.log(c.bold('═══ SavantDex Agent Export Verifier ═══\n'))
console.log(`  agentId    : ${exp.payload?.agentId || '?'}`)
console.log(`  transport  : ${exp.payload?.transport || '?'}`)
console.log(`  exportedAt : ${exp.payload?.exportedAt || '?'}`)

const canonicalMsg = JSON.stringify(sortKeysDeep(exp.payload))
const computedHash = createHash('sha256').update(canonicalMsg).digest('hex')

console.log('\n' + c.bold('Record hash check:'))
console.log(`  claimed recordHash : ${exp.recordHash}`)
console.log(`  recomputed         : ${computedHash}`)
const hashMatch = computedHash === exp.recordHash
console.log(`  match              : ${hashMatch ? c.ok('✓') : c.bad('✗')}`)
if (!hashMatch) failed = true

if (!exp.signature || !exp.signerAddress) {
  console.log('\n' + c.warn('⚠ Export is unsigned (platform signer was unavailable at export time).'))
  console.log(c.dim('  Hash comparison above is still valid, but no cryptographic signer attestation is present.'))
  if (!failed) console.log('\n' + c.ok(c.bold('RECORD HASH VERIFIED (unsigned)')))
  else         console.log('\n' + c.bad(c.bold('EXPORT VERIFICATION FAILED')))
  process.exit(failed ? 1 : 0)
}

const recovered = verifyMessage(canonicalMsg, exp.signature).toLowerCase()
const sigMatch  = recovered === exp.signerAddress.toLowerCase()

console.log('\n' + c.bold('Signature check:'))
console.log(`  claimed signer   : ${exp.signerAddress.toLowerCase()}`)
console.log(`  recovered signer : ${recovered}`)
console.log(`  match            : ${sigMatch ? c.ok('✓') : c.bad('✗')}`)
if (!sigMatch) failed = true

if (expectedSig) {
  const trustMatch = recovered === expectedSig
  console.log(`  expected signer  : ${expectedSig}`)
  console.log(`  trust match      : ${trustMatch ? c.ok('✓') : c.bad('✗')}`)
  if (!trustMatch) failed = true
}

console.log('\n' + c.bold('Payload fields:'))
for (const [k, v] of Object.entries(exp.payload)) {
  const show = Array.isArray(v) || (typeof v === 'object' && v !== null) ? JSON.stringify(v) : String(v)
  console.log(`  ${k.padEnd(16)}: ${show}`)
}

if (failed) {
  console.log('\n' + c.bad(c.bold('EXPORT VERIFICATION FAILED')))
  process.exit(1)
}
console.log('\n' + c.ok(c.bold('EXPORT VERIFIED')))
