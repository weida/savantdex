#!/usr/bin/env node
/**
 * SavantDex Keystore Generator
 *
 * One-time utility: encrypts your Ethereum private key into a standard
 * Ethereum keystore JSON file. The keystore is safe to store on disk;
 * without the password it cannot be decrypted.
 *
 * Usage:
 *   PRIVATE_KEY=0x... node sdk/keygen.mjs
 *   PRIVATE_KEY=0x... node sdk/keygen.mjs --password-file /secure/keystore.pass
 *
 * Output:
 *   keystore.json  (created next to this script's cwd)
 *
 * After running:
 *   - Delete PRIVATE_KEY from your .env
 *   - Store the password in age-encrypted secrets, not KEYSTORE_PASSWORD env vars
 *   - Add keystore.json path to workers via KEYSTORE_PATH (default: ./keystore.json)
 */

import { Wallet } from 'ethers'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const privateKey = process.env.PRIVATE_KEY
const outPath = resolve(process.env.KEYSTORE_PATH || 'keystore.json')
const passwordFile = parsePasswordFileArg(process.argv.slice(2))

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

if (!privateKey) {
  console.error('Error: PRIVATE_KEY environment variable is required')
  console.error('  PRIVATE_KEY=0x... node sdk/keygen.mjs')
  process.exit(1)
}

const password = await readPassword().catch(err => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})

if (!password || password.length < 12) {
  console.error('Error: password must be at least 12 characters')
  process.exit(1)
}

console.log('Encrypting... (this takes a few seconds)')

const wallet = new Wallet(privateKey)
const keystoreJson = await wallet.encrypt(password)

writeFileSync(outPath, keystoreJson, { mode: 0o600 })

console.log(`\nKeystore saved to: ${outPath}`)
console.log(`Address: ${wallet.address}`)
console.log(`\nNext steps:`)
console.log(`  1. Remove PRIVATE_KEY from your .env`)
console.log(`  2. Store the password in age-encrypted secrets, not in KEYSTORE_PASSWORD env vars`)
console.log(`  3. Set KEYSTORE_PATH=${outPath}`)
console.log(`  4. Never commit keystore.json or plaintext secrets`)
