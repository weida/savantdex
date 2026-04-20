/**
 * SavantDex Secrets Loader
 *
 * Decrypts an age-encrypted secrets file at startup and returns the contents.
 * Node never handles the age encryption protocol directly — it shells out to
 * the age CLI binary, which must be installed on the host.
 *
 * Primary env vars (new path):
 *   SECRETS_PATH        Path to the age-encrypted secrets file (e.g. /secure/worker.secrets.age)
 *   AGE_IDENTITY_PATH   Path to the age identity file         (e.g. /secure/age-identity.key)
 *
 * Legacy fallback (migration period):
 *   KEYSTORE_PASSWORD   Plain-text password — accepted with a deprecation warning
 *
 * The decrypted file must be valid JSON. Required fields are validated by the
 * caller (e.g. signer-gateway expects KEYSTORE_PASSWORD + SIGNER_TOKEN; relay
 * workers expect PRIVATE_KEYS[AGENT_ID]). This module only handles decryption.
 *
 * One-time setup (run on the host, not in Node):
 *   # 1. Generate an age identity key (once per host)
 *   age-keygen -o /secure/age-identity.key
 *   chmod 600 /secure/age-identity.key
 *
 *   # 2. Encrypt the secrets file
 *   echo '{"KEYSTORE_PASSWORD":"your-strong-password"}' | \
 *     age -r $(age-keygen -y /secure/age-identity.key) > /secure/worker.secrets.age
 *   chmod 600 /secure/worker.secrets.age
 *
 *   # 3. Set env vars in .env (no sensitive values needed)
 *   SECRETS_PATH=/secure/worker.secrets.age
 *   AGE_IDENTITY_PATH=/secure/age-identity.key
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Load and decrypt secrets.
 * @returns {Promise<{ KEYSTORE_PASSWORD: string, [key: string]: string }>}
 */
export async function loadSecrets() {
  const secretsPath  = process.env.SECRETS_PATH
  const identityPath = process.env.AGE_IDENTITY_PATH

  // ── Primary path: age-encrypted secrets file ─────────────────────────────
  if (secretsPath && identityPath) {
    const sp = resolve(secretsPath)
    const ip = resolve(identityPath)

    if (!existsSync(sp)) throw new Error(`[secrets] Secrets file not found: ${sp}`)
    if (!existsSync(ip)) throw new Error(`[secrets] Age identity key not found: ${ip}`)

    let decrypted
    try {
      decrypted = execFileSync('age', ['--decrypt', '-i', ip, sp], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      })
    } catch (err) {
      const stderr = err.stderr?.trim() || err.message
      throw new Error(`[secrets] age decryption failed: ${stderr}`)
    }

    let parsed
    try {
      parsed = JSON.parse(decrypted)
    } catch {
      throw new Error('[secrets] Decrypted content is not valid JSON')
    }

    console.log('[secrets] Loaded from age-encrypted file:', sp)
    return parsed
  }

  // ── Legacy fallback: plain env var ────────────────────────────────────────
  if (process.env.KEYSTORE_PASSWORD) {
    console.warn(
      '[secrets] WARNING: Using KEYSTORE_PASSWORD env var directly.\n' +
      '          Migrate to age-encrypted secrets:\n' +
      '          Set SECRETS_PATH + AGE_IDENTITY_PATH and remove KEYSTORE_PASSWORD from .env'
    )
    return { KEYSTORE_PASSWORD: process.env.KEYSTORE_PASSWORD }
  }

  throw new Error(
    '[secrets] No secrets source configured.\n' +
    '  Option A (recommended): set SECRETS_PATH + AGE_IDENTITY_PATH\n' +
    '  Option B (legacy):      set KEYSTORE_PASSWORD'
  )
}
