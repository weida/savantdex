#!/usr/bin/env node
/**
 * SavantDex MCP Server v0.1
 *
 * Exposes SavantDex agent marketplace as MCP tools for Claude Code,
 * Claude Desktop, Cursor, and any MCP-compatible client.
 *
 * Tools (v0.1):
 *   list_agents  — discover available agents with optional filters
 *   run_task     — call an agent and wait for result
 *   get_budget   — check remaining DATA token balance
 *
 * Auth: age-encrypted secrets file → keystore password → ethers keystore
 *
 * Required env vars:
 *   MCP_SECRETS_PATH    Path to age-encrypted secrets file
 *                       e.g. /home/user/.config/savantdex/mcp.secrets.age
 *                       Decrypted JSON must contain: { KEYSTORE_PATH, KEYSTORE_PASSWORD }
 *
 *   AGE_IDENTITY_PATH   Path to age identity key
 *                       e.g. /home/user/.age/identity.txt
 *
 *   REQUESTER_AGENT_ID  Your registered requester ID, e.g. "my-bot-v1"
 *
 *   OWNER_ADDRESS       Your wallet address (0x...), must match registered requester
 *
 * Optional:
 *   GATEWAY_URL         Default: https://savantdex.weicao.dev
 *
 * Setup (one-time):
 *   # 1. Generate keystore from private key
 *   PRIVATE_KEY=0x... node sdk/keygen.mjs
 *
 *   # 2. Create age-encrypted secrets file
 *   echo '{"KEYSTORE_PATH":"/path/to/requester.keystore.json","KEYSTORE_PASSWORD":"..."}' | \
 *     age -r $(age-keygen -y ~/.age/identity.txt) > ~/.config/savantdex/mcp.secrets.age
 *
 *   # 3. Configure MCP client (e.g. Claude Code ~/.claude.json):
 *   {
 *     "mcpServers": {
 *       "savantdex": {
 *         "command": "savantdex-mcp",
 *         "env": {
 *           "MCP_SECRETS_PATH": "/home/user/.config/savantdex/mcp.secrets.age",
 *           "AGE_IDENTITY_PATH": "/home/user/.age/identity.txt",
 *           "REQUESTER_AGENT_ID": "my-bot-v1",
 *           "OWNER_ADDRESS": "0x..."
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { Wallet } from 'ethers'
import { loadSecrets } from './secrets.mjs'
import { loadPrivateKey } from './keystore.mjs'
import { GatewayRequester } from './gateway-requester.mjs'

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://savantdex.weicao.dev'

// ── Startup validation ────────────────────────────────────────────────────────

function checkEnv() {
  const missing = []
  if (!process.env.MCP_SECRETS_PATH)   missing.push('MCP_SECRETS_PATH')
  if (!process.env.AGE_IDENTITY_PATH)  missing.push('AGE_IDENTITY_PATH')
  if (!process.env.REQUESTER_AGENT_ID) missing.push('REQUESTER_AGENT_ID')
  if (!process.env.OWNER_ADDRESS)      missing.push('OWNER_ADDRESS')

  if (missing.length > 0) {
    console.error('[savantdex-mcp] Missing required env vars:', missing.join(', '))
    console.error('[savantdex-mcp] See sdk/mcp-server.mjs header for setup instructions.')
    process.exit(1)
  }
}

async function buildClient() {
  // Remap env vars: MCP uses MCP_SECRETS_PATH, secrets.mjs reads SECRETS_PATH
  process.env.SECRETS_PATH = process.env.MCP_SECRETS_PATH

  let secrets
  try {
    secrets = await loadSecrets()
  } catch (e) {
    console.error('[savantdex-mcp] Failed to load secrets:', e.message)
    process.exit(1)
  }

  const { KEYSTORE_PATH, KEYSTORE_PASSWORD } = secrets

  if (!KEYSTORE_PATH || !KEYSTORE_PASSWORD) {
    console.error('[savantdex-mcp] Decrypted secrets must contain KEYSTORE_PATH and KEYSTORE_PASSWORD')
    process.exit(1)
  }

  process.env.KEYSTORE_PATH = KEYSTORE_PATH

  let privateKey
  try {
    privateKey = await loadPrivateKey(KEYSTORE_PASSWORD)
  } catch (e) {
    console.error('[savantdex-mcp] Keystore decryption failed:', e.message)
    process.exit(1)
  }

  const signer = new Wallet(privateKey)
  const ownerAddress = process.env.OWNER_ADDRESS
  const requesterAgentId = process.env.REQUESTER_AGENT_ID

  if (signer.address.toLowerCase() !== ownerAddress.toLowerCase()) {
    console.error(`[savantdex-mcp] Keystore address (${signer.address}) does not match OWNER_ADDRESS (${ownerAddress})`)
    process.exit(1)
  }

  return GatewayRequester.create({
    gatewayUrl: GATEWAY_URL,
    signer,
    requesterAgentId,
    ownerAddress,
  })
}

// ── Main ─────────────────────────────────────────────────────────────────────

checkEnv()

const client = await buildClient()
console.error(`[savantdex-mcp] Ready`)

const server = new McpServer({
  name: 'savantdex',
  version: '0.1.0',
})

// ── Tool: list_agents ────────────────────────────────────────────────────────

server.tool(
  'list_agents',
  'Discover available AI agents in the SavantDex marketplace. Returns agent IDs, descriptions, capabilities, and input/output schemas.',
  {
    capability: z.string().optional().describe('Filter by capability, e.g. "token-risk", "wallet-profiling"'),
    category:   z.string().optional().describe('Filter by category, e.g. "blockchain", "defi"'),
    q:          z.string().optional().describe('Free-text search across agent names and descriptions'),
  },
  async ({ capability, category, q }) => {
    const agents = await client.findAgents({ capability, category, q })
    if (agents.length === 0) {
      return { content: [{ type: 'text', text: 'No agents found matching the given filters.' }] }
    }
    const lines = agents.map(a =>
      `• ${a.agentId}${a.name ? ` (${a.name})` : ''}\n` +
      `  ${a.description || 'No description'}\n` +
      `  Capabilities: ${(a.capabilities || []).join(', ') || 'none'}\n` +
      `  taskType: ${a.taskType || 'unknown'}`
    )
    return { content: [{ type: 'text', text: lines.join('\n\n') }] }
  }
)

// ── Tool: run_task ───────────────────────────────────────────────────────────

server.tool(
  'run_task',
  'Call a SavantDex agent with structured input and wait for the result. The agent processes the task and returns output.',
  {
    agent_id: z.string().describe('The agent ID to call, e.g. "token-risk-screener-v1"'),
    input:    z.record(z.unknown()).describe('Task input as a JSON object matching the agent\'s inputSchema'),
    timeout:  z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
  },
  async ({ agent_id, input, timeout }) => {
    const result = await client.run(agent_id, input, { timeout })
    if (result.status === 'failed') {
      return {
        content: [{
          type: 'text',
          text: `Task failed: ${result.error || 'unknown error'}\ntaskId: ${result.taskId}`,
        }],
        isError: true,
      }
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result.output, null, 2),
      }],
    }
  }
)

// ── Tool: get_budget ─────────────────────────────────────────────────────────

server.tool(
  'get_budget',
  'Check the remaining DATA token balance for the current requester.',
  {},
  async () => {
    const requesterAgentId = process.env.REQUESTER_AGENT_ID
    const res = await fetch(`${GATEWAY_URL}/requesters/${encodeURIComponent(requesterAgentId)}/budget`)
    if (!res.ok) {
      return {
        content: [{ type: 'text', text: `Failed to fetch budget: HTTP ${res.status}` }],
        isError: true,
      }
    }
    const budget = await res.json()
    const fmt = (v) => v ? (Number(BigInt(v)) / 1e18).toFixed(4) + ' DATA' : 'N/A'
    const text = [
      `Requester: ${budget.requesterAgentId}`,
      `Remaining:  ${fmt(budget.remainingBaseUnits)}`,
      `Currency:   ${budget.currency || 'DATA'}`,
    ].join('\n')
    return { content: [{ type: 'text', text }] }
  }
)

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
