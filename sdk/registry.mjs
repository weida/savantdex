/**
 * SavantDex Registry Client
 *
 * Handles signed registration of a SavantDex agent into the registry.
 * Workers call registerToRegistry() on startup after agent.register().
 *
 * Auth model (v0.4):
 *   signature = personal_sign(
 *     "Authorize runtime {runtimeAddress} for agent {agentId} stream {streamId} ts:{timestamp}"
 *   )
 *   - Signer must be ownerAddress
 *   - runtimeAddress is derived from the agent's Streamr identity (streamId prefix)
 *
 * Demo note: until Phase 1-Migration completes, owner key == runtime key.
 * The registry accepts this because runtimeAddress == ownerAddress is valid.
 *
 * Usage (with private key — demo/legacy):
 *   await registerToRegistry(agent, ownerPrivateKey, { registryUrl, capabilities })
 *
 * Usage (with signer server — Phase 1-Migration):
 *   await registerToRegistry(agent, null, {
 *     registryUrl, capabilities,
 *     signerUrl: 'http://127.0.0.1:17099',  // signer holds owner key
 *   })
 */

import { Wallet } from 'ethers'

/**
 * @param {object} agent            SavantDex instance (already registered on Streamr)
 * @param {string|null} ownerPrivateKey  Owner's private key — signs authorization (never sent).
 *                                        Pass null when using opts.signerUrl instead.
 * @param {object} opts
 * @param {string}   opts.registryUrl
 * @param {string[]} opts.capabilities
 * @param {string}   [opts.signerUrl]     Base URL of signer server (alternative to ownerPrivateKey)
 * @param {string}   [opts.description]
 * @param {string}   [opts.name]
 * @param {string}   [opts.category]
 * @param {object}   [opts.exampleInput]
 * @param {object}   [opts.exampleOutput]
 * @param {Array}    [opts.inputSchema]
 * @param {string}   [opts.docsUrl]
 * @param {string}   [opts.taskType]            — task type string requester must send, e.g. "screen-token"
 * @param {Array}    [opts.outputSchema]        — output field definitions
 * @param {string}   [opts.protocolVersion]     — e.g. "1.0"
 * @param {boolean}  [opts.supportsAsync]       — true if fire-and-forget supported
 * @param {number}   [opts.expectedLatencyMs]   — typical response time in ms
 * @param {string}   [opts.authType]            — e.g. "none", "api-key", "signed-request"
 * @param {object}   [opts.pricingModel]        — e.g. { type: "free" }
 */
export async function registerToRegistry(agent, ownerPrivateKey, opts) {
  const { registryUrl, capabilities, signerUrl, description = '',
          name, category, exampleInput, exampleOutput, inputSchema, docsUrl,
          taskType, outputSchema, protocolVersion, supportsAsync, expectedLatencyMs, authType, pricingModel } = opts

  if (!ownerPrivateKey && !signerUrl) {
    throw new Error('[registry] ownerPrivateKey or opts.signerUrl is required')
  }

  const streamId      = await agent.getStreamId()
  const agentId       = streamId.split('/').pop()
  const runtimeAddress = streamId.split('/')[0].toLowerCase()

  const timestamp = Date.now()
  let signature, ownerAddress

  if (ownerPrivateKey) {
    // Direct signing with owner private key
    const message = `Authorize runtime ${runtimeAddress} for agent ${agentId} stream ${streamId} ts:${timestamp}`
    const ownerWallet = new Wallet(ownerPrivateKey)
    ownerAddress = ownerWallet.address.toLowerCase()
    signature    = await ownerWallet.signMessage(message)
  } else {
    // Delegate signing to signer server via structured endpoint
    // The signer constructs the canonical message internally; we only send fields.
    const res = await fetch(`${signerUrl}/authorize-runtime`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ agentId, streamId, runtimeAddress, timestamp }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Signer server error ${res.status}: ${text}`)
    }
    const data = await res.json()
    signature    = data.signature
    ownerAddress = data.ownerAddress.toLowerCase()
  }

  const payload = {
    agentId, streamId,
    ownerAddress, runtimeAddress,
    capabilities, description,
    timestamp, signature,
  }
  if (name !== undefined)             payload.name = name
  if (category !== undefined)         payload.category = category
  if (exampleInput !== undefined)     payload.exampleInput = exampleInput
  if (exampleOutput !== undefined)    payload.exampleOutput = exampleOutput
  if (inputSchema !== undefined)      payload.inputSchema = inputSchema
  if (docsUrl !== undefined)          payload.docsUrl = docsUrl
  if (taskType !== undefined)         payload.taskType = taskType
  if (outputSchema !== undefined)     payload.outputSchema = outputSchema
  if (protocolVersion !== undefined)  payload.protocolVersion = protocolVersion
  if (supportsAsync !== undefined)    payload.supportsAsync = supportsAsync
  if (expectedLatencyMs !== undefined) payload.expectedLatencyMs = expectedLatencyMs
  if (authType !== undefined)         payload.authType = authType
  if (pricingModel !== undefined)     payload.pricingModel = pricingModel

  const res = await fetch(`${registryUrl}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(`Registry error: ${data.error}`)

  console.log(`[registry] Registered: ${agentId} (owner: ${ownerAddress}, runtime: ${runtimeAddress})`)
  return data
}
