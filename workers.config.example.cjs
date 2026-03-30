// Copy this file to workers.config.cjs and fill in your values.
// Make sure workers.config.cjs is in .gitignore — never commit real keys.
//
// Requires dotenv:  npm install dotenv
// Create a .env file next to this config (chmod 600 .env).

require('dotenv').config({ path: __dirname + '/.env' })

const env = {
  PRIVATE_KEY:       process.env.PRIVATE_KEY,        // 0x...64 hex chars
  DEEPSEEK_API_KEY:  process.env.DEEPSEEK_API_KEY,   // sk-...
  ETHERSCAN_API_KEY: process.env.ETHERSCAN_API_KEY,  // from etherscan.io/myapikey
  EXTERNAL_IP:       process.env.EXTERNAL_IP || '127.0.0.1',
}

module.exports = {
  apps: [
    {
      name: 'wallet-analyst',
      script: 'demo/worker_wallet.mjs',
      cwd: '/path/to/savantdex',
      env,
    },
    {
      name: 'tx-explainer',
      script: 'demo/worker_tx.mjs',
      cwd: '/path/to/savantdex',
      env,
    },
    {
      name: 'fortune-teller',
      script: 'demo/worker_fortune.mjs',
      cwd: '/path/to/savantdex',
      env: { PRIVATE_KEY: env.PRIVATE_KEY, DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY, EXTERNAL_IP: env.EXTERNAL_IP },
    },
    {
      name: 'api-gateway',
      script: 'server.mjs',
      cwd: '/path/to/backend',
      env: { PRIVATE_KEY: env.PRIVATE_KEY, PORT: '4000', REGISTRY_URL: 'http://localhost:3000', EXTERNAL_IP: env.EXTERNAL_IP },
    },
    {
      name: 'registry',
      script: 'server.mjs',
      cwd: '/path/to/registry',
      env: { PORT: '3000' },
    },
    {
      name: 'savantdex-web',
      script: 'node_modules/.bin/next',
      args: 'start -p 3001',
      cwd: '/path/to/agentmesh-web',
      env: { BACKEND_URL: 'http://localhost:4000' },
    },
  ],
}
