/**
 * Transaction Forensics — Relay Mode
 *
 * Same business logic as worker_tx_forensics.mjs but connects via WebSocket
 * relay instead of running a Streamr P2P node.
 *
 * Required env:
 *   PRIVATE_KEY         Owner private key for the registered agent
 *   ETHERSCAN_API_KEY   Etherscan v2 API key
 *   DEEPSEEK_API_KEY    Deepseek API key (for structured summary)
 *
 * Optional env:
 *   GATEWAY_WS_URL      Default: wss://savantdex.weicao.dev/ws/agent
 *   AGENT_ID            Default: tx-forensics-v1
 */

import { RelayAgent } from '../sdk/relay-agent.mjs'
import { Wallet } from 'ethers'
import OpenAI from 'openai'
import { loadSecrets } from '../sdk/secrets.mjs'

const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'wss://savantdex.weicao.dev/ws/agent'
const AGENT_ID       = process.env.AGENT_ID || 'tx-forensics-v1'

let _secrets = {}
try { _secrets = await loadSecrets() } catch { /* env-only mode */ }
const PRIVATE_KEY   = _secrets.PRIVATE_KEYS?.[AGENT_ID] || process.env.PRIVATE_KEY
const ETHERSCAN_KEY = _secrets.ETHERSCAN_API_KEY        || process.env.ETHERSCAN_API_KEY
const DEEPSEEK_KEY  = _secrets.DEEPSEEK_API_KEY         || process.env.DEEPSEEK_API_KEY

if (!PRIVATE_KEY)   { console.error(`[tx-forensics-relay] No key for ${AGENT_ID}: set PRIVATE_KEYS.${AGENT_ID} in secrets or PRIVATE_KEY env`); process.exit(1) }
if (!ETHERSCAN_KEY) { console.error('[tx-forensics-relay] ETHERSCAN_API_KEY required (secrets or env)'); process.exit(1) }
if (!DEEPSEEK_KEY)  { console.error('[tx-forensics-relay] DEEPSEEK_API_KEY required (secrets or env)'); process.exit(1) }

const deepseek = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: 'https://api.deepseek.com' })

// ── Protocol + method registry ───────────────────────────────────────────────

const PROTOCOLS = {
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': { name: 'Uniswap V2', category: 'DEX' },
  '0xe592427a0aece92de3edee1f18e0157c05861564': { name: 'Uniswap V3', category: 'DEX' },
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': { name: 'Uniswap V3', category: 'DEX' },
  '0x1111111254fb6c44bac0bed2854e76f90643097d': { name: '1inch V4', category: 'DEX Aggregator' },
  '0x1111111254eeb25477b68fb85ed929f73a960582': { name: '1inch V5', category: 'DEX Aggregator' },
  '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9': { name: 'Aave V2', category: 'Lending' },
  '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2': { name: 'Aave V3', category: 'Lending' },
  '0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b': { name: 'Compound', category: 'Lending' },
  '0x00000000219ab540356cbb839cbe05303d7705fa': { name: 'ETH2 Deposit', category: 'Staking' },
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': { name: 'Lido stETH', category: 'Staking' },
  '0x00000000006c3852cbef3e08e8df289169ede581': { name: 'OpenSea Seaport', category: 'NFT' },
  '0x7be8076f4ea4a4ad08075c2508e481d6c946d12b': { name: 'OpenSea V1', category: 'NFT' },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { name: 'USDC', category: 'Token' },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { name: 'USDT', category: 'Token' },
  '0x6b175474e89094c44da98b954eedeac495271d0f': { name: 'DAI', category: 'Token' },
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { name: 'WETH', category: 'Token' },
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { name: 'WBTC', category: 'Token' },
}

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

// ── Etherscan data layer ─────────────────────────────────────────────────────

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

// ── Structure extraction ─────────────────────────────────────────────────────

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

  const riskFlags = []
  if (status === 'failed')            riskFlags.push({ flag: 'TX_FAILED', detail: 'Transaction reverted on-chain' })
  if (gasFeeEth > 0.1)                riskFlags.push({ flag: 'HIGH_GAS_FEE', detail: `Gas fee: ${gasFeeEth.toFixed(4)} ${nativeToken}` })
  if (internalTx.length > 5)          riskFlags.push({ flag: 'COMPLEX_INTERNAL_CALLS', detail: `${internalTx.length} internal calls` })
  if (tokenTx.length > 5)             riskFlags.push({ flag: 'MULTI_TOKEN_TRANSFER', detail: `${tokenTx.length} token transfer events` })
  if (isContractCall && !protocol && !method) riskFlags.push({ flag: 'UNKNOWN_CONTRACT', detail: 'Unknown protocol or unverified contract' })
  if (nonce === 0)                    riskFlags.push({ flag: 'FIRST_TX_FROM_SENDER', detail: 'Nonce 0 — first transaction from this address' })

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

// ── Agent setup ──────────────────────────────────────────────────────────────

const signer = new Wallet(PRIVATE_KEY)
console.log(`[tx-forensics-relay] Owner address: ${signer.address}`)

const agent = new RelayAgent({
  gatewayUrl: GATEWAY_WS_URL,
  signer,
  agentId: AGENT_ID,
})

agent.onTask(async (task) => {
  if (task.taskType !== 'analyze-tx') {
    return { error: `Unknown task type: ${task.taskType}` }
  }

  const hash = task.input?.hash?.trim()
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return { error: 'Invalid transaction hash (must be 0x + 64 hex chars)' }
  }

  console.log(`[tx-forensics-relay] Analyzing: ${hash}`)

  try {
    const chainInfo = await detectChain(hash)
    if (!chainInfo) return { error: 'Transaction not found on Ethereum or Polygon' }

    console.log(`  Chain: ${chainInfo.chainName}`)

    const raw      = await fetchTxData(hash, chainInfo.chainId)
    const forensics = extractForensics(hash, chainInfo, raw)
    if (!forensics) return { error: 'Failed to decode transaction data' }

    const ai = await summarizeTx(forensics)

    console.log(`  Class: ${forensics.classification} | Protocol: ${forensics.protocol || 'unknown'} | Flags: ${forensics.riskFlags.length}`)

    return {
      ...forensics,
      summary:        ai.summary,
      senderAction:   ai.senderAction,
      suspiciousNote: ai.suspiciousNote,
    }
  } catch (err) {
    console.error(`[error] ${err.message}`)
    return { error: err.message }
  }
})

await agent.connect()
console.log(`\n=== SavantDex Worker - Transaction Forensics (Relay Mode) ===`)
console.log(`Gateway: ${GATEWAY_WS_URL}`)
console.log(`Agent:   ${AGENT_ID}`)
console.log('Waiting for tasks...\n')
