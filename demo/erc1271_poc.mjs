#!/usr/bin/env node
/**
 * Minimal ERC-1271 PoC for Streamr SDK.
 *
 * Goal:
 *   1. Verify publish works when erc1271Contract metadata is supplied
 *   2. Verify subscribe works when erc1271Contract option is supplied
 *   3. Verify stream-management APIs still operate through the client auth wallet
 *
 * Important:
 *   - This PoC does NOT prove "keyless runtime".
 *   - Streamr SDK still requires client auth. ERC-1271 is an extra pub/sub option.
 *
 * Required env:
 *   PRIVATE_KEY=0x...
 *   ERC1271_CONTRACT=0x...
 *
 * Optional env:
 *   EXTERNAL_IP=1.2.3.4
 *   ERC1271_TEST_STREAM_ID=0x.../erc1271/poc
 *   ERC1271_TIMEOUT_MS=30000
 */

import { StreamrClient, StreamPermission } from '@streamr/sdk'
import { Wallet } from 'ethers'

const PRIVATE_KEY = process.env.PRIVATE_KEY
const ERC1271_CONTRACT = process.env.ERC1271_CONTRACT
const EXTERNAL_IP = process.env.EXTERNAL_IP
const TEST_STREAM_ID = process.env.ERC1271_TEST_STREAM_ID
const TIMEOUT_MS = Number(process.env.ERC1271_TIMEOUT_MS || 30000)

if (!PRIVATE_KEY) {
  console.error('Missing PRIVATE_KEY')
  process.exit(1)
}

if (!ERC1271_CONTRACT || !/^0x[a-fA-F0-9]{40}$/.test(ERC1271_CONTRACT)) {
  console.error('Missing or invalid ERC1271_CONTRACT')
  process.exit(1)
}

const wallet = new Wallet(PRIVATE_KEY)

function logStep(name, details = '') {
  console.log(`\n[${name}]${details ? ' ' + details : ''}`)
}

function logResult(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${message}`)
}

async function waitForMessage(sub, expectedMarker) {
  for await (const msg of sub) {
    if (msg?.content?.marker === expectedMarker) {
      return msg
    }
  }
  throw new Error('Subscription ended before receiving message')
}

async function main() {
  const client = new StreamrClient({
    auth: { privateKey: PRIVATE_KEY },
    network: EXTERNAL_IP
      ? { controlLayer: { externalIp: EXTERNAL_IP } }
      : undefined,
  })

  let stream
  let streamId = TEST_STREAM_ID
  let sub

  try {
    logStep('PRECHECK')
    console.log(`SDK auth wallet:  ${wallet.address}`)
    console.log(`ERC1271 contract: ${ERC1271_CONTRACT}`)
    console.log('Interpretation: if this script works, it still proves the SDK runtime is backed by an auth wallet.')

    logStep('STREAM MANAGEMENT')
    if (streamId) {
      stream = await client.getStream(streamId)
      logResult(true, `Using existing stream ${streamId}`)
    } else {
      const path = `/erc1271-poc/${Date.now()}`
      stream = await client.getOrCreateStream({ id: path })
      streamId = stream.id
      logResult(true, `Created stream ${streamId}`)

      await stream.grantPermissions(
        { permission: StreamPermission.SUBSCRIBE, public: true },
        { permission: StreamPermission.PUBLISH, public: true }
      )
      logResult(true, 'Granted public publish/subscribe permissions')
    }

    console.log('Observation: stream creation and permission management use the client auth wallet APIs directly.')

    logStep('SUBSCRIBE')
    sub = await client.subscribe(streamId, {
      erc1271Contract: ERC1271_CONTRACT,
    })
    logResult(true, 'Subscription opened with erc1271Contract option')

    logStep('PUBLISH')
    const marker = `erc1271-poc-${Date.now()}`
    await client.publish(
      streamId,
      {
        marker,
        ts: new Date().toISOString(),
        note: 'publish path uses erc1271Contract metadata',
      },
      {
        erc1271Contract: ERC1271_CONTRACT,
      }
    )
    logResult(true, 'Published message with erc1271Contract metadata')

    logStep('ROUNDTRIP')
    const received = await Promise.race([
      waitForMessage(sub, marker),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
    ])
    logResult(true, `Received matching message back from stream ${received.streamId}`)

    console.log('\n=== SUMMARY ===')
    console.log('PASS publish works with erc1271Contract metadata')
    console.log('PASS subscribe works with erc1271Contract option')
    console.log('INFO stream-management calls still run through the client auth wallet')
    console.log('INFO this PoC does not remove the need for an auth signer; it only validates ERC-1271 support on pub/sub')
  } catch (err) {
    console.error('\n=== SUMMARY ===')
    console.error(`FAIL ${err.message}`)
    console.error('Interpretation:')
    console.error('- If publish/subscribe failed, ERC-1271 support is not usable in your current setup')
    console.error('- Even if publish/subscribe pass, this does not prove keyless runtime')
    process.exitCode = 1
  } finally {
    try {
      if (sub) await sub.unsubscribe()
    } catch {}
    try {
      await client.destroy()
    } catch {}
  }
}

await main()
