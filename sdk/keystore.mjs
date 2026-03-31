/**
 * SavantDex Keystore Loader
 *
 * Decrypts an Ethereum keystore (EIP-55 / ethers scrypt format) and returns
 * the private key in memory. The key is never written to disk in plaintext.
 *
 * Required env vars:
 *   KEYSTORE_PATH   Path to keystore.json (default: ./keystore.json)
 *
 * The password is passed in explicitly from sdk/secrets.mjs — it is NOT read
 * from environment variables here. This keeps the two concerns separate:
 *   - secrets.mjs owns "how to get the password"
 *   - keystore.mjs owns "how to decrypt the wallet"
 *
 * Usage:
 *   import { loadSecrets } from './secrets.mjs'
 *   import { loadPrivateKey } from './keystore.mjs'
 *
 *   const { KEYSTORE_PASSWORD } = await loadSecrets()
 *   const privateKey = await loadPrivateKey(KEYSTORE_PASSWORD)
 */

import { Wallet } from 'ethers'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Decrypt the keystore file and return the private key.
 * @param {string} password  Keystore password — obtain from loadSecrets()
 * @returns {Promise<string>} Hex private key (0x-prefixed)
 */
export async function loadPrivateKey(password) {
  if (!password) {
    throw new Error('[keystore] password is required. Call loadSecrets() first.')
  }

  const keystorePath = resolve(process.env.KEYSTORE_PATH || 'keystore.json')

  if (!existsSync(keystorePath)) {
    throw new Error(
      `[keystore] Keystore file not found: ${keystorePath}\n` +
      `  Run: PRIVATE_KEY=0x... KEYSTORE_PASSWORD=... node sdk/keygen.mjs`
    )
  }

  const keystoreJson = readFileSync(keystorePath, 'utf8')

  try {
    const wallet = await Wallet.fromEncryptedJson(keystoreJson, password)
    console.log(`[keystore] Unlocked: ${wallet.address}`)
    return wallet.privateKey
  } catch {
    throw new Error('[keystore] Failed to decrypt keystore: wrong password or corrupted file.')
  }
}
