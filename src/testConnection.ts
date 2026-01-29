#!/usr/bin/env node

import { UserConnector } from './userStream'

interface TestOptions {
  provider: string
  key: string
  secret: string
  passphrase?: string
  environment?: 'live' | 'sandbox'
  bybitHost?: string
  keysType?: string
  okxSource?: string
}

function parseArgs(): TestOptions {
  const args = process.argv.slice(2)
  const options: any = {}

  for (const arg of args) {
    if (arg.includes('=')) {
      const [key, value] = arg.split('=')
      options[key] = value
    }
  }

  if (!options.provider) {
    console.error('❌ Error: provider is required')
    console.log(
      'Usage: npm run test:connection -- provider=bybit key=your_key secret=your_secret',
    )
    console.log(
      'Example: npm run test:connection -- provider=bybit key=abc123 secret=xyz789',
    )
    console.log('')
    console.log('Supported providers:')
    console.log('  - binance, binanceUS, binanceCoinm, binanceUsdm')
    console.log('  - bybit, bybitCoinm, bybitUsdm')
    console.log('  - okx, okxInverse, okxLinear')
    console.log('  - kucoin, kucoinLinear, kucoinInverse')
    console.log('  - bitget, bitgetCoinm, bitgetUsdm')
    console.log('  - coinbase')
    console.log('  - hyperliquid, hyperliquidLinear')
    console.log('')
    console.log('Optional parameters:')
    console.log('  - passphrase (required for Kucoin, OKX, Bitget)')
    console.log('  - environment=sandbox (for exchanges that support testnet)')
    console.log('  - bybitHost=eu|com|nl|tr|kz|ge (for Bybit)')
    console.log('  - keysType=legacy|cloud (for Coinbase)')
    console.log('  - okxSource=my|com (for OKX)')
    process.exit(1)
  }

  if (!options.key) {
    console.error('❌ Error: key is required')
    process.exit(1)
  }

  if (!options.secret) {
    console.error('❌ Error: secret is required')
    process.exit(1)
  }

  return options as TestOptions
}

async function main() {
  const options = parseArgs()

  console.log('🔧 Initializing connection test...')
  console.log(`Provider: ${options.provider}`)
  console.log(`Environment: ${options.environment || 'live'}`)

  // Initialize UserConnector in test mode
  const connector = new UserConnector(true)

  try {
    await connector.testConnection(options)
  } catch (error) {
    console.error('❌ Connection test failed:', error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error)
  process.exit(1)
})
