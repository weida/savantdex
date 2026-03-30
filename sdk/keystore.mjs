/**
 * SavantDex Keystore Loader
 *
 * Decrypts an Ethereum keystore file at startup and returns the private key.
 * The key is only held in memory; it is never written to disk in plaintext.
 *
 * Required env vars:
 *   KEYSTORE_PATH      Path to keystore.json (default: ./keystore.json)
 *   KEYSTORE_PASSWORD  Password to decrypt the keystore
 *
 * Falls back to PRIVATE_KEY env var if keystore vars are not set
 * (for backwards compatibility during migration).
 */

import { Wallet } from 'ethers'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export async function loadPrivateKey() {
  // Fallback: plain env var (legacy, not recommended)
  if (!process.env.KEYSTORE_PATH && !process.env.KEYSTORE_PASSWORD) {
    if (process.env.PRIVATE_KEY) {
      console.warn('[keystore] WARNING: Using PRIVATE_KEY env var directly. ' +
        'Run sdk/keygen.mjs to migrate to an encrypted keystore.')
      return process.env.PRIVATE_KEY
    }
    throw new Error('No credentials found. Set KEYSTORE_PATH + KEYSTORE_PASSWORD, or PRIVATE_KEY.')
  }

  const keystorePath = resolve(process.env.KEYSTORE_PATH || 'keystore.json')
  const password = process.env.KEYSTORE_PASSWORD

  if (!existsSync(keystorePath)) {
    throw new Error(`Keystore file not found: ${keystorePath}\nRun: node sdk/keygen.mjs`)
  }

  if (!password) {
    throw new Error('KEYSTORE_PASSWORD is required when using a keystore file.')
  }

  const keystoreJson = readFileSync(keystorePath, 'utf8')

  try {
    const wallet = await Wallet.fromEncryptedJson(keystoreJson, password)
    console.log(`[keystore] Unlocked: ${wallet.address}`)
    return wallet.privateKey
  } catch {
    throw new Error('Failed to decrypt keystore: wrong password or corrupted file.')
  }
}
