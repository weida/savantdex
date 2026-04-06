/**
 * SavantDex Worker - Transaction Forensics
 * Structured transaction analysis: method decode, protocol ID, asset flows, risk flags.
 * Replaces tx-explainer-v1 with structured output.
 *
 * Handles task type: 'analyze-tx'
 * Input:  { hash: '0x...' }
 * Output: { hash, chain, status, from, to, protocol, method, valueUsd, assetFlows,
 *           gasInfo, riskFlags, classification, summary }
 *
 * Key model: signer mode (no private key in process)
 */

import { SavantDex } from '../sdk/index.mjs'
import { RemoteSignerIdentity } from '../sdk/remote-identity.mjs'
import { loadSecrets } from '../sdk/secrets.mjs'
import { loadPrivateKey } from '../sdk/keystore.mjs'
import { registerToRegistry } from '../sdk/registry.mjs'
import OpenAI from 'openai'

const DEEPSEEK_KEY   = process.env.DEEPSEEK_API_KEY
const ETHERSCAN_KEY  = process.env.ETHERSCAN_API_KEY
const EXTERNAL_IP    = process.env.EXTERNAL_IP    || '127.0.0.1'
const SIGNER_ADDRESS = process.env.SIGNER_ADDRESS
const SIGNER_PORT    = Number(process.env.SIGNER_PORT || 17099)

if (!DEEPSEEK_KEY)  { console.error('Missing DEEPSEEK_API_KEY');  process.exit(1) }
if (!ETHERSCAN_KEY) { console.error('Missing ETHERSCAN_API_KEY'); process.exit(1) }

// --- Auth ---
let workerAuth, ownerPrivateKey, registrySignerUrl
if (SIGNER_ADDRESS) {
  console.log(`[tx-forensics] Using remote signer: ${SIGNER_ADDRESS} on port ${SIGNER_PORT}`)
  workerAuth = { identity: new RemoteSignerIdentity(SIGNER_ADDRESS, SIGNER_PORT) }
  registrySignerUrl = `http://127.0.0.1:${SIGNER_PORT}`
} else {
  console.warn('[tx-forensics] SIGNER_ADDRESS not set — falling back to local keystore (legacy mode)')
  const { KEYSTORE_PASSWORD } = await loadSecrets()
  ownerPrivateKey = await loadPrivateKey(KEYSTORE_PASSWORD)
  workerAuth = { privateKey: ownerPrivateKey }
}

const deepseek = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: 'https://api.deepseek.com' })

// --- Protocol + method registry ---

const PROTOCOLS = {
  // Uniswap
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': { name: 'Uniswap V2', category: 'DEX' },
  '0xe592427a0aece92de3edee1f18e0157c05861564': { name: 'Uniswap V3', category: 'DEX' },
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': { name: 'Uniswap V3', category: 'DEX' },
  // 1inch
  '0x1111111254fb6c44bac0bed2854e76f90643097d': { name: '1inch V4', category: 'DEX Aggregator' },
  '0x1111111254eeb25477b68fb85ed929f73a960582': { name: '1inch V5', category: 'DEX Aggregator' },
  // Aave
  '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9': { name: 'Aave V2', category: 'Lending' },
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2': { name: 'Aave V3', category: 'Lending' },
  // Compound
  '0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b': { name: 'Compound', category: 'Lending' },
  // ETH2
  '0x00000000219ab540356cbb839cbe05303d7705fa': { name: 'ETH2 Deposit', category: 'Staking' },
  // Lido
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': { name: 'Lido stETH', category: 'Staking' },
  // OpenSea
  '0x00000000006c3852cbef3e08e8df289169ede581': { name: 'OpenSea Seaport', category: 'NFT' },
  '0x7be8076f4ea4a4ad08075c2508e481d6c946d12b': { name: 'OpenSea V1', category: 'NFT' },
  // Tokens
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { name: 'USDC', category: 'Token' },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { name: 'USDT', category: 'Token' },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { name: 'DAI', category: 'Token' },
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { name: 'WETH', category: 'Token' },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { name: 'WBTC', category: 'Token' },
}

// Common 4-byte method selectors
const METHOD_SELECTORS = {
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0x38ed1739': 'swapExactTokensForTokens',
  '0x8803dbee': 'swapTokensForExactTokens',
  '0x7ff36ab5': 'swapExactETHForTokens',
  '0x18cbafe5': 'swapExactTokensForETH',
  '0x5c11d795': 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
  '0x414bf389': 'exactInputSingle (Uni V3)',
  '0xc04b8d59': 'exactInput (Uni V3)',
  '0xe8e33700': 'addLiquidity',
  '0xf305d719': 'addLiquidityETH',
  '0xbaa2abde': 'removeLiquidity',
  '0xe9748a5a': 'deposit',
  '0x2e1a7d4d': 'withdraw(uint256)',
  '0x69328dec': 'withdraw (Aave)',
  '0x573ade81': 'repay (Aave)',
  '0xab9c4b5d': 'flashLoan',
  '0x12aa3caf': '1inch swap',
  '0x0d5f0e3b': '1inch fillOrder',
  '0xb6f9de95': 'swapExactETHForTokensSupportingFeeOnTransferTokens',
}

function decodeMethod(input) {
  if (!input || input === '0x' || input.length < 10) return null
  const selector = input.slice(0, 10).toLowerCase()
  return METHOD_SELECTORS[selector] || null
}

function getProtocol(address) {
  if (!address) return null
  return PROTOCOLS[address.toLowerCase()] || null
}

// --- Etherscan data layer ---

const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api'

async function etherscan(params, chainId = '1') {
  const url = new URL(ETHERSCAN_BASE)
  url.searchParams.set('chainid', chainId)
  url.searchParams.set('apikey', ETHERSCAN_KEY)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(12000) })
  const data = await res.json()
  if (data.status === '0' && data.result !== '0x') throw new Error(`Etherscan: ${data.message}`)
  return data.result
}

async function detectChain(hash) {
  for (const [chainId, chainName, nativeToken] of [
    ['1', 'Ethereum', 'ETH'],
    ['137', 'Polygon', 'POL'],
  ]) {
    try {
      const tx = await etherscan({ module: 'proxy', action: 'eth_getTransactionByHash', txhash: hash }, chainId)
      if (tx?.hash) return { chainId, chainName, nativeToken }
    } catch {}
  }
  return null
}

async function fetchTxData(hash, chainId) {
  const [receipt, tx, tokenTx, internalTx] = await Promise.allSettled([
    etherscan({ module: 'proxy', action: 'eth_getTransactionReceipt', txhash: hash }, chainId),
    etherscan({ module: 'proxy', action: 'eth_getTransactionByHash', txhash: hash }, chainId),
    etherscan({ module: 'account', action: 'tokentx', txhash: hash, page: '1', offset: '50' }, chainId),
    etherscan({ module: 'account', action: 'txlistinternal', txhash: hash, page: '1', offset: '20' }, chainId),
  ])
  return {
    receipt:    receipt.status    === 'fulfilled' ? receipt.value    : null,
    tx:         tx.status         === 'fulfilled' ? tx.value         : null,
    tokenTx:    tokenTx.status    === 'fulfilled' && Array.isArray(tokenTx.value)    ? tokenTx.value    : [],
    internalTx: internalTx.status === 'fulfilled' && Array.isArray(internalTx.value) ? internalTx.value : [],
  }
}

// --- Structure extraction ---

function extractForensics(hash, chainInfo, raw) {
  const { chainName, nativeToken } = chainInfo
  const { receipt, tx, tokenTx, internalTx } = raw

  if (!tx) return null

  const status      = receipt ? (receipt.status === '0x1' ? 'success' : 'failed') : 'pending'
  const blockNumber = receipt ? parseInt(receipt.blockNumber, 16) : null
  const gasUsed     = receipt ? parseInt(receipt.gasUsed, 16) : 0
  const gasPrice    = parseInt(tx.gasPrice || '0', 16)
  const gasFeeEth   = (gasUsed * gasPrice) / 1e18
  const valueEth    = Number(BigInt(tx.value || '0')) / 1e18
  const nonce       = parseInt(tx.nonce || '0', 16)

  const protocol = getProtocol(tx.to)
  const method   = decodeMethod(tx.input)
  const isContractCall = tx.input && tx.input !== '0x'
  const isContractCreation = !tx.to

  // Asset flows: native token
  const assetFlows = []
  if (valueEth > 0) {
    assetFlows.push({
      type: 'native',
      token: nativeToken,
      from: tx.from,
      to: tx.to || '(contract creation)',
      amount: parseFloat(valueEth.toFixed(8)),
    })
  }

  // Asset flows: ERC-20 transfers
  for (const t of tokenTx.slice(0, 10)) {
    const decimals = Number(t.tokenDecimal) || 18
    const amount = Number(t.value) / Math.pow(10, decimals)
    assetFlows.push({
      type: 'erc20',
      token: t.tokenSymbol,
      tokenName: t.tokenName,
      from: t.from,
      to: t.to,
      amount: parseFloat(amount.toFixed(6)),
      contractAddress: t.contractAddress,
    })
  }

  // Asset flows: internal ETH
  for (const t of internalTx.slice(0, 5)) {
    const amount = Number(BigInt(t.value || '0')) / 1e18
    if (amount > 0) {
      assetFlows.push({
        type: 'internal',
        token: nativeToken,
        from: t.from,
        to: t.to,
        amount: parseFloat(amount.toFixed(8)),
      })
    }
  }

  // Risk flags
  const riskFlags = []
  if (status === 'failed') {
    riskFlags.push({ flag: 'TX_FAILED', detail: 'Transaction reverted on-chain' })
  }
  if (gasFeeEth > 0.1) {
    riskFlags.push({ flag: 'HIGH_GAS_FEE', detail: `Gas fee: ${gasFeeEth.toFixed(4)} ${nativeToken}` })
  }
  if (internalTx.length > 5) {
    riskFlags.push({ flag: 'COMPLEX_INTERNAL_CALLS', detail: `${internalTx.length} internal calls` })
  }
  if (tokenTx.length > 5) {
    riskFlags.push({ flag: 'MULTI_TOKEN_TRANSFER', detail: `${tokenTx.length} token transfer events` })
  }
  if (isContractCall && !protocol && !method) {
    riskFlags.push({ flag: 'UNKNOWN_CONTRACT', detail: 'Unknown protocol or unverified contract' })
  }
  if (nonce === 0) {
    riskFlags.push({ flag: 'FIRST_TX_FROM_SENDER', detail: 'Nonce 0 — first transaction from this address' })
  }

  // Classification
  let classification
  if (isContractCreation)                     classification = 'contract-deployment'
  else if (protocol?.category === 'DEX')      classification = 'dex-swap'
  else if (protocol?.category === 'Lending')  classification = 'defi-lending'
  else if (protocol?.category === 'Staking')  classification = 'staking'
  else if (protocol?.category === 'NFT')      classification = 'nft-trade'
  else if (protocol?.category === 'Token' && method === 'transfer(address,uint256)') classification = 'token-transfer'
  else if (!isContractCall && valueEth > 0)   classification = 'eth-transfer'
  else if (isContractCall)                    classification = 'contract-interaction'
  else                                        classification = 'unknown'

  return {
    hash,
    chain: chainName,
    status,
    blockNumber,
    from: tx.from,
    to: tx.to || null,
    protocol: protocol ? protocol.name : null,
    protocolCategory: protocol ? protocol.category : null,
    method: method || (isContractCreation ? 'contract-deployment' : null),
    methodSelector: isContractCall ? tx.input?.slice(0, 10) : null,
    valueNative: parseFloat(valueEth.toFixed(8)),
    nativeToken,
    gasInfo: {
      gasUsed,
      gasPriceGwei: parseFloat((gasPrice / 1e9).toFixed(2)),
      gasFee: parseFloat(gasFeeEth.toFixed(8)),
      gasFeeToken: nativeToken,
    },
    assetFlows,
    riskFlags,
    classification,
  }
}

// --- AI summary (structured JSON) ---

async function summarizeTx(forensics) {
  const flows = forensics.assetFlows.slice(0, 5).map(f =>
    `${f.type}: ${f.amount} ${f.token} ${f.from?.slice(0,8)}→${f.to?.slice(0,8)}`
  ).join(', ')

  const prompt = `You are a blockchain analyst. Based on the following transaction data, return a JSON object with exactly these fields:

{
  "summary": string (1 sentence, max 25 words — what happened in plain English),
  "senderAction": string (1 sentence — from the sender's perspective: what did they do),
  "suspiciousNote": string or null (1 sentence if anything suspicious, otherwise null)
}

Hash: ${forensics.hash}
Chain: ${forensics.chain}
Status: ${forensics.status}
Classification: ${forensics.classification}
Protocol: ${forensics.protocol || 'unknown'}
Method: ${forensics.method || 'unknown calldata'}
Value: ${forensics.valueNative} ${forensics.nativeToken}
Asset flows: ${flows || 'none'}
Risk flags: ${forensics.riskFlags.map(f => f.flag).join(', ') || 'none'}

Return only valid JSON, no explanation.`

  const res = await deepseek.chat.completions.create({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: 'You are a blockchain analyst. Always respond with valid JSON only.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 150,
    temperature: 0.2,
  })

  const raw = res.choices[0].message.content.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '')

  try {
    return JSON.parse(raw)
  } catch {
    return { summary: raw.slice(0, 100), senderAction: null, suspiciousNote: null }
  }
}

// --- Agent ---

const agent = new SavantDex({
  ...workerAuth,
  agentId: 'tx-forensics-v1',
  network: { websocketPort: 32242, websocketPortMax: 32252, externalIp: EXTERNAL_IP }
})

await agent.register()
await registerToRegistry(agent, ownerPrivateKey || null, {
  registryUrl: process.env.REGISTRY_URL || 'http://localhost:3000',
  capabilities: ['tx-analysis', 'method-decode', 'asset-flow', 'defi-forensics'],
  description: 'Structured transaction forensics: method decoding, protocol identification, asset flow tracing, and risk flag detection. Returns machine-readable JSON.',
  name: 'Transaction Forensics',
  category: 'blockchain',
  exampleInput:  { hash: '0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060' },
  exampleOutput: {
    classification: 'eth-transfer',
    protocol: null,
    method: null,
    riskFlags: [],
    summary: 'First Ethereum transaction — 1 ETH sent directly between two addresses.',
  },
  inputSchema: [
    { key: 'hash', label: 'Transaction Hash', type: 'text', required: true,
      placeholder: '0x...', hint: 'Ethereum or Polygon transaction hash (0x + 64 hex chars)' }
  ],
  outputSchema: [
    { key: 'hash',             type: 'string',  description: 'Transaction hash' },
    { key: 'chain',            type: 'string',  description: 'Ethereum | Polygon' },
    { key: 'status',           type: 'string',  description: 'success | failed | pending' },
    { key: 'blockNumber',      type: 'number',  description: 'Block number' },
    { key: 'from',             type: 'string',  description: 'Sender address' },
    { key: 'to',               type: 'string',  description: 'Recipient or contract address' },
    { key: 'protocol',         type: 'string',  description: 'Identified protocol name or null' },
    { key: 'protocolCategory', type: 'string',  description: 'DEX | Lending | Staking | NFT | Token | null' },
    { key: 'method',           type: 'string',  description: 'Decoded function name or null' },
    { key: 'methodSelector',   type: 'string',  description: '4-byte selector (0x...) or null' },
    { key: 'valueNative',      type: 'number',  description: 'Native token value transferred' },
    { key: 'nativeToken',      type: 'string',  description: 'ETH | POL' },
    { key: 'gasInfo',          type: 'object',  description: '{ gasUsed, gasPriceGwei, gasFee, gasFeeToken }' },
    { key: 'assetFlows',       type: 'array',   description: 'Array of { type, token, from, to, amount } — native/erc20/internal' },
    { key: 'riskFlags',        type: 'array',   description: 'Array of { flag, detail } risk observations' },
    { key: 'classification',   type: 'string',  description: 'eth-transfer | token-transfer | dex-swap | defi-lending | staking | nft-trade | contract-interaction | contract-deployment | unknown' },
    { key: 'summary',          type: 'string',  description: 'One-sentence plain-English summary' },
    { key: 'senderAction',     type: 'string',  description: 'What the sender did, from their perspective' },
    { key: 'suspiciousNote',   type: 'string',  description: 'Suspicious observation or null' },
  ],
  taskType:          'analyze-tx',
  protocolVersion:   '1.0',
  supportsAsync:     false,
  expectedLatencyMs: 10000,
  authType:          'none',
  pricingModel:      { type: 'free' },
  ...(registrySignerUrl ? { signerUrl: registrySignerUrl } : {}),
}).catch(e => console.warn('[registry] Registration skipped:', e.message))

console.log('\n=== SavantDex Worker - Transaction Forensics ===')
console.log('Stream:', await agent.getStreamId())
console.log('Waiting for tasks...\n')

await agent.onTask(async (task, reply) => {
  if (task.type !== 'analyze-tx') {
    return reply({ error: `Unknown task type: ${task.type}. Use 'analyze-tx'.` })
  }

  const hash = task.input?.hash?.trim()
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return reply({ error: 'Invalid transaction hash (must be 0x + 64 hex chars)' })
  }

  console.log(`[tx-forensics] Analyzing: ${hash}`)

  try {
    const chainInfo = await detectChain(hash)
    if (!chainInfo) return reply({ error: 'Transaction not found on Ethereum or Polygon' })

    console.log(`  Chain: ${chainInfo.chainName}`)

    const raw      = await fetchTxData(hash, chainInfo.chainId)
    const forensics = extractForensics(hash, chainInfo, raw)
    if (!forensics) return reply({ error: 'Failed to decode transaction data' })

    const ai = await summarizeTx(forensics)

    console.log(`  Class: ${forensics.classification} | Protocol: ${forensics.protocol || 'unknown'} | Flags: ${forensics.riskFlags.length}`)

    await reply({
      ...forensics,
      summary:        ai.summary,
      senderAction:   ai.senderAction,
      suspiciousNote: ai.suspiciousNote,
    })
  } catch (err) {
    console.error(`[error] ${err.message}`)
    await reply({ error: err.message })
  }
})
