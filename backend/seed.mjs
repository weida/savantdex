/**
 * SavantDex Phase A — Payment DB Seed
 *
 * Required env vars:
 *   FREE_API_KEY          API key for the free-only requester
 *   FREE_OWNER_ADDRESS    Owner wallet address for the free requester
 *   FUNDED_API_KEY        API key for the funded requester
 *   FUNDED_OWNER_ADDRESS  Owner wallet address for the funded requester
 *
 * Optional env vars (funded requester limits):
 *   FUNDED_BUDGET_DATA        Total budget in DATA (default: 100)
 *   FUNDED_MAX_PER_TASK_DATA  Max per task in DATA (default: 10)
 *   FUNDED_DAILY_LIMIT_DATA   Daily limit in DATA (default: 20)
 *
 * Run: node seed.mjs
 */

import { initDb, seedRequester } from './payment.mjs'

function requireEnv(name) {
  const val = process.env[name]
  if (!val) { console.error(`Missing required env var: ${name}`); process.exit(1) }
  return val
}

const ONE_DATA = 1_000_000_000_000_000_000n

function dataToBaseUnits(dataAmount) {
  return (ONE_DATA * BigInt(dataAmount)).toString()
}

const freeKey          = requireEnv('FREE_API_KEY')
const freeOwner        = requireEnv('FREE_OWNER_ADDRESS')
const fundedKey        = requireEnv('FUNDED_API_KEY')
const fundedOwner      = requireEnv('FUNDED_OWNER_ADDRESS')

const fundedBudget     = dataToBaseUnits(process.env.FUNDED_BUDGET_DATA     || '100')
const fundedMaxPerTask = dataToBaseUnits(process.env.FUNDED_MAX_PER_TASK_DATA || '10')
const fundedDailyLimit = dataToBaseUnits(process.env.FUNDED_DAILY_LIMIT_DATA  || '20')

initDb()

seedRequester({
  rawKey:              freeKey,
  requesterAgentId:    'requester-free',
  ownerAddress:        freeOwner,
  remainingBaseUnits:  '0',
  maxPerTaskBaseUnits: '0',
  dailyLimitBaseUnits: '0',
})

seedRequester({
  rawKey:              fundedKey,
  requesterAgentId:    'requester-funded',
  ownerAddress:        fundedOwner,
  remainingBaseUnits:  fundedBudget,
  maxPerTaskBaseUnits: fundedMaxPerTask,
  dailyLimitBaseUnits: fundedDailyLimit,
})

console.log('Seed complete.')
console.log(`  requester-free   — 0 DATA  [owner: ${freeOwner}]`)
console.log(`  requester-funded — ${process.env.FUNDED_BUDGET_DATA || 100} DATA, max ${process.env.FUNDED_MAX_PER_TASK_DATA || 10}/task, ${process.env.FUNDED_DAILY_LIMIT_DATA || 20}/day  [owner: ${fundedOwner}]`)
