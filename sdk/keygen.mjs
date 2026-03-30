#!/usr/bin/env node
/**
 * SavantDex Keystore Generator
 *
 * One-time utility: encrypts your Ethereum private key into a standard
 * Ethereum keystore JSON file. The keystore is safe to store on disk;
 * without the password it cannot be decrypted.
 *
 * Usage:
 *   PRIVATE_KEY=0x... KEYSTORE_PASSWORD=yourpassword node sdk/keygen.mjs
 *
 * Output:
 *   keystore.json  (created next to this script's cwd)
 *
 * After running:
 *   - Delete PRIVATE_KEY from your .env
 *   - Add KEYSTORE_PASSWORD=yourpassword to your .env
 *   - Add keystore.json path to workers via KEYSTORE_PATH (default: ./keystore.json)
 */

import { Wallet } from 'ethers'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const privateKey = process.env.PRIVATE_KEY
const envPassword = process.env.KEYSTORE_PASSWORD
const outPath = resolve(process.env.KEYSTORE_PATH || 'keystore.json')

async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer) })
  })
}

if (!privateKey) {
  console.error('Error: PRIVATE_KEY environment variable is required')
  console.error('  PRIVATE_KEY=0x... node sdk/keygen.mjs')
  process.exit(1)
}

const password = envPassword || await prompt('Enter keystore password: ')

if (!password || password.length < 8) {
  console.error('Error: password must be at least 8 characters')
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
console.log(`  2. Add to your .env:`)
console.log(`       KEYSTORE_PASSWORD=${password}`)
console.log(`       KEYSTORE_PATH=${outPath}`)
console.log(`  3. Never commit keystore.json or .env`)
