#!/usr/bin/env node
/**
 * SavantDex Runtime Key Generator
 *
 * Generates a fresh Ethereum wallet and saves it as an encrypted keystore file.
 * The private key is never printed or stored in plaintext — only the keystore is written.
 *
 * Use this for runtime keys (workers, gateway).
 * Do NOT use this for owner keys — owner keys must be generated offline.
 *
 * Usage:
 *   node sdk/genkey.mjs
 *   node sdk/genkey.mjs --password-file /secure/worker.pass
 *
 * With label (recommended when generating multiple keys):
 *   KEYSTORE_LABEL=worker  node sdk/genkey.mjs
 *   KEYSTORE_LABEL=gateway node sdk/genkey.mjs
 *
 * Output path override:
 *   KEYSTORE_PATH=/secure/worker.keystore.json node sdk/genkey.mjs
 *
 * After running:
 *   - Fund the printed address with a small amount of POL (for Streamr stream creation)
 *   - Set KEYSTORE_PATH in the relevant service's .env
 *   - Set SECRETS_PATH / AGE_IDENTITY_PATH (see sdk/secrets.mjs) to protect the password
 */

import { Wallet } from 'ethers'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const label = process.env.KEYSTORE_LABEL
const passwordFile = parsePasswordFileArg(process.argv.slice(2))

// Derive default output path from label if no explicit path given
function defaultOutPath() {
  if (process.env.KEYSTORE_PATH) return resolve(process.env.KEYSTORE_PATH)
  if (label) return resolve(`${label}.keystore.json`)
  return resolve('keystore.json')
}

const outPath = defaultOutPath()

async function promptHidden(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  rl.stdoutMuted = true
  rl._writeToOutput = function _writeToOutput(stringToWrite) {
    if (!rl.stdoutMuted) rl.output.write(stringToWrite)
  }
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.output.write('\n')
      rl.close()
      resolve(answer)
    })
  })
}

async function readPassword() {
  if (process.env.KEYSTORE_PASSWORD) {
    throw new Error('KEYSTORE_PASSWORD env is no longer supported; use interactive prompt or --password-file')
  }
  if (passwordFile) {
    return readFileSync(passwordFile, 'utf8').trimEnd()
  }
  const password = await promptHidden('Enter keystore password: ')
  const confirm = await promptHidden('Confirm keystore password: ')
  if (password !== confirm) throw new Error('password confirmation does not match')
  return password
}

function parsePasswordFileArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--password-file') return argv[i + 1] || null
    if (arg.startsWith('--password-file=')) return arg.slice('--password-file='.length)
  }
  return null
}

const password = await readPassword().catch(err => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})

if (!password || password.length < 12) {
  console.error('Error: password must be at least 12 characters')
  process.exit(1)
}

console.error('Generating new wallet and encrypting keystore...')

const wallet = Wallet.createRandom()
const keystoreJson = await wallet.encrypt(password)

writeFileSync(outPath, keystoreJson, { mode: 0o600 })

console.log(`Address:  ${wallet.address}`)
console.log(`Keystore: ${outPath}`)
console.log('')
console.log('Next steps:')
console.log(`  1. Fund this address with a small amount of POL (needed for Streamr stream creation)`)
console.log(`  2. Add to your service .env:`)
console.log(`       KEYSTORE_PATH=${outPath}`)
console.log(`  3. Protect the password with age-encrypted secrets (see sdk/secrets.mjs)`)
console.log(`  4. Never print or store the private key — it exists only inside the keystore`)
