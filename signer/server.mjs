#!/usr/bin/env node
/**
 * SavantDex Signer Server
 *
 * Holds a single keystore and exposes two signing endpoints on localhost.
 * Agent and gateway processes never receive the private key — only signatures.
 *
 * Run one instance per runtime key:
 *   KEYSTORE_LABEL=gateway KEYSTORE_PASSWORD=... node signer/server.mjs
 *   KEYSTORE_LABEL=worker  KEYSTORE_PASSWORD=... node signer/server.mjs
 *
 * Required env:
 *   KEYSTORE_PATH (or KEYSTORE_LABEL to derive path)  — path to encrypted keystore
 *   KEYSTORE_PASSWORD (or SECRETS_PATH + AGE_IDENTITY_PATH)
 *
 * Optional env:
 *   SIGNER_PORT   Port to listen on (default: 17099)
 *   SIGNER_LABEL  Label for log output (default: derived from KEYSTORE_LABEL)
 *
 * Endpoints:
 *   POST /sign-message
 *     Body:   { "payload": "<hex>" }         ← raw bytes from Streamr SDK
 *     Result: { "signature": "<0x hex>", "address": "0x...", "signMs": "..." }
 *
 *   POST /authorize-runtime
 *     Body:   { "agentId": "...", "streamId": "...", "runtimeAddress": "0x...", "timestamp": N }
 *     The signer assembles the canonical message internally; the caller never controls it.
 *     Result: { "signature": "<0x hex>", "ownerAddress": "0x...", "message": "...", "signMs": "..." }
 *
 *   GET /health
 *     Result: { "ok": true, "address": "0x...", "requests": N }
 */

import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { Wallet } from 'ethers'
import { loadSecrets } from '../sdk/secrets.mjs'
import { loadPrivateKey } from '../sdk/keystore.mjs'

const PORT  = Number(process.env.SIGNER_PORT || 17099)
const LABEL = process.env.SIGNER_LABEL || process.env.KEYSTORE_LABEL || 'signer'
const MAX_BODY_BYTES = 64 * 1024

const { KEYSTORE_PASSWORD, SIGNER_TOKEN } = await loadSecrets()
if (!SIGNER_TOKEN) throw new Error('[signer] Missing required secret: SIGNER_TOKEN')
const privateKey = await loadPrivateKey(KEYSTORE_PASSWORD)
const wallet = new Wallet(privateKey)

console.log(`[${LABEL}] Address: ${wallet.address}`)
console.log(`[${LABEL}] Ready on 127.0.0.1:${PORT}`)

let reqCount = 0

// ── Request parsing ───────────────────────────────────────────────────────────

async function readBody(req) {
  let body = ''
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) {
      const err = new Error('body too large')
      err.code = 'BODY_TOO_LARGE'
      throw err
    }
    body += chunk
  }
  return JSON.parse(body)
}

function respond(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

const SIGNER_TOKEN_BUF = Buffer.from(SIGNER_TOKEN)
const SIGNER_TOKEN_DUMMY = Buffer.alloc(SIGNER_TOKEN_BUF.length)

function isAuthorized(req) {
  const presented = req.headers['x-signer-token']
  if (typeof presented !== 'string') {
    timingSafeEqual(SIGNER_TOKEN_DUMMY, SIGNER_TOKEN_DUMMY)
    return false
  }
  const actual = Buffer.from(presented)
  if (actual.length !== SIGNER_TOKEN_BUF.length) {
    timingSafeEqual(SIGNER_TOKEN_DUMMY, SIGNER_TOKEN_DUMMY)
    return false
  }
  return timingSafeEqual(actual, SIGNER_TOKEN_BUF)
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return respond(res, 200, { ok: true, address: wallet.address, requests: reqCount })
  }

  if (req.method !== 'POST') {
    return respond(res, 405, { error: 'method not allowed' })
  }

  if (!isAuthorized(req)) {
    return respond(res, 401, { error: 'unauthorized' })
  }

  let body
  try {
    body = await readBody(req)
  } catch (err) {
    if (err.code === 'BODY_TOO_LARGE') {
      return respond(res, 413, { error: 'body too large' })
    }
    return respond(res, 400, { error: 'invalid JSON' })
  }

  const t0 = performance.now()

  try {
    let signature

    if (req.url === '/sign-message') {
      // Streamr SDK: raw bytes → signMessage adds Ethereum prefix + keccak256
      if (!body.payload || typeof body.payload !== 'string') {
        return respond(res, 400, { error: 'missing payload field' })
      }
      const bytes = Buffer.from(body.payload, 'hex')
      signature = await wallet.signMessage(bytes)

      const elapsed = (performance.now() - t0).toFixed(2)
      reqCount++
      if (reqCount % 50 === 0) console.log(`[${LABEL}] ${reqCount} requests, last: ${elapsed}ms`)
      return respond(res, 200, { signature, address: wallet.address, signMs: elapsed })

    } else if (req.url === '/authorize-runtime') {
      // Registry authorization: structured payload → signer constructs canonical message
      const { agentId, streamId, runtimeAddress, timestamp } = body
      if (!agentId || !streamId || !runtimeAddress || !timestamp) {
        return respond(res, 400, { error: 'missing required fields: agentId, streamId, runtimeAddress, timestamp' })
      }

      // Validate: runtimeAddress must match the stream owner prefix
      const streamOwner = streamId.split('/')[0].toLowerCase()
      if (runtimeAddress.toLowerCase() !== streamOwner) {
        return respond(res, 400, {
          error: `runtimeAddress ${runtimeAddress} does not match stream owner ${streamOwner}`
        })
      }

      // Validate: signer address must match runtimeAddress (this signer IS the runtime key)
      if (runtimeAddress.toLowerCase() !== wallet.address.toLowerCase()) {
        return respond(res, 403, {
          error: `This signer controls ${wallet.address}, not ${runtimeAddress}. Use the correct signer instance.`
        })
      }

      // Canonical message — must match registry/server.mjs verifyOwnerRuntimeSig exactly
      const message = `Authorize runtime ${runtimeAddress.toLowerCase()} for agent ${agentId} stream ${streamId} ts:${timestamp}`
      signature = await wallet.signMessage(message)

      const elapsed = (performance.now() - t0).toFixed(2)
      reqCount++
      console.log(`[${LABEL}] authorize-runtime: ${agentId} (${elapsed}ms)`)
      return respond(res, 200, { signature, ownerAddress: wallet.address, message, signMs: elapsed })

    } else {
      return respond(res, 404, { error: 'not found' })
    }

  } catch (err) {
    console.error(`[${LABEL}] signing error:`, err.message)
    respond(res, 500, { error: 'signing failed' })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[${LABEL}] Listening on 127.0.0.1:${PORT}`)
})

server.on('error', (err) => {
  console.error(`[${LABEL}] Server error:`, err.message)
  process.exit(1)
})
