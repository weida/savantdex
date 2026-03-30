/**
 * SavantDex Registry Client
 *
 * Handles signed registration of a SavantDex agent into the registry.
 * Workers call registerToRegistry() on startup after agent.register().
 *
 * Usage:
 *   import { registerToRegistry } from '../sdk/registry.mjs'
 *   await registerToRegistry(agent, wallet, {
 *     registryUrl: 'http://localhost:3000',
 *     capabilities: ['explain-tx'],
 *     description: 'Explains Ethereum and Polygon transactions in plain English',
 *   })
 */

import { Wallet } from 'ethers'

/**
 * @param {object} agent         SavantDex instance (already registered on Streamr)
 * @param {string} privateKey    Raw hex private key (for signing — never sent over wire)
 * @param {object} opts
 * @param {string} opts.registryUrl
 * @param {string[]} opts.capabilities
 * @param {string} [opts.description]
 */
export async function registerToRegistry(agent, privateKey, opts) {
  const { registryUrl, capabilities, description = '' } = opts

  const streamId = await agent.getStreamId()
  const agentId = streamId.split('/').pop()
  const wallet = new Wallet(privateKey)
  const owner = wallet.address.toLowerCase()
  const timestamp = Date.now()

  const message = `Register ${agentId} ${streamId} ts:${timestamp}`
  const signature = await wallet.signMessage(message)

  const res = await fetch(`${registryUrl}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, streamId, capabilities, description, owner, timestamp, signature }),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(`Registry error: ${data.error}`)

  console.log(`[registry] Registered: ${agentId}`)
  return data
}
