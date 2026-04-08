#!/usr/bin/env ts-node
/**
 * Smoke test - uses KucoinConnector directly (the real production path).
 *
 * Fetches spot + futures symbol lists from kucoin via @gainium/kucoin-api,
 * builds a list of (symbol, exchange, interval) subscriptions, feeds them
 * into the connector, and watches Redis for published candles.
 *
 * Usage:
 *   npm run test:kucoin-candles [-- durationSeconds maxSubs]
 *   e.g.  npm run test:kucoin-candles -- 120 50
 *
 * Pass `max` for maxSubs to subscribe to every (symbol x interval) combo.
 *
 * Environment:
 *   PRICEROLE=candle  (set by the npm script)
 *   REDIS_HOST / REDIS_PORT / REDIS_PASSWORD
 */

import KucoinApi from '@gainium/kucoin-api'
import { createClient } from 'redis'

import KucoinConnector from './price/kucoin'
import { ExchangeEnum } from './utils/common'
import { convertSymbol } from './utils/kucoin'

const DURATION_S = Number(process.argv[2] ?? 120)
const MAX_ARG = process.argv[3] ?? '20'
const MAX_SUBS = MAX_ARG === 'max' ? Infinity : Number(MAX_ARG)

// Kucoin-format intervals (the connector forwards these as-is to kucoin).
const INTERVALS = ['1min', '5min', '15min', '1hour', '4hour', '1day']

type Sub = {
  symbol: string
  exchange: ExchangeEnum
  interval: string
}

async function fetchSymbols(): Promise<{
  spot: string[]
  linear: string[]
  inverse: string[]
}> {
  const api = new KucoinApi()
  const [spotRes, futRes] = await Promise.all([
    api.getSymbols(),
    api.getFuturesSymbols(),
  ])
  if (spotRes.status !== 'OK' || !spotRes.data) {
    throw new Error(`getSymbols failed: ${spotRes.reason}`)
  }
  if (futRes.status !== 'OK' || !futRes.data) {
    throw new Error(`getFuturesSymbols failed: ${futRes.reason}`)
  }
  const spot = spotRes.data.filter((s) => s.enableTrading).map((s) => s.symbol) // already BASE-QUOTE form
  const linear: string[] = []
  const inverse: string[] = []
  for (const c of futRes.data) {
    // c.symbol is kucoin native (XBTUSDTM, ETHUSDM, ...). Convert to canonical.
    const canonical = convertSymbol(c.symbol)
    if (c.symbol.endsWith('M') && !c.symbol.endsWith('USDM')) {
      // USDTM / USDCM -> linear (USDT/USDC margined)
      linear.push(canonical)
    } else if (c.symbol.endsWith('USDM')) {
      inverse.push(canonical)
    }
  }
  return { spot, linear, inverse }
}

async function main() {
  // -- Redis subscriber ------------------------------------------------------
  const redisSub = createClient({
    password: process.env.REDIS_PASSWORD,
    socket: {
      port: +(process.env.REDIS_PORT ?? 6379),
      host: process.env.REDIS_HOST ?? 'localhost',
    },
  })
  redisSub.on('error', (e) => console.error('Redis error:', e))
  await redisSub.connect()
  console.log('Connected to Redis (subscriber)')

  let totalMessages = 0
  const channelHits: Record<string, number> = {}

  await redisSub.pSubscribe('*Candle', (message, channel) => {
    totalMessages++
    channelHits[channel] = (channelHits[channel] ?? 0) + 1
    if (totalMessages <= 20 || totalMessages % 100 === 0) {
      try {
        const data = JSON.parse(message) as { close: string }
        console.log(`[${totalMessages}] ${channel}  close=${data.close}`)
      } catch {
        console.log(`[${totalMessages}] ${channel}  ${message}`)
      }
    }
  })

  // -- Connector -------------------------------------------------------------
  const connector = new KucoinConnector()
  // Disable watchdog to avoid noisy reconnects during the test
  if (connector.watchdog) {
    clearInterval(connector.watchdog)
    connector.watchdog = null
  }
  await connector.init()
  console.log('KucoinConnector initialised')

  // -- Symbols ---------------------------------------------------------------
  console.log('\nFetching kucoin symbols...')
  const { spot, linear, inverse } = await fetchSymbols()
  console.log(`  Spot:    ${spot.length}`)
  console.log(`  Linear:  ${linear.length}`)
  console.log(`  Inverse: ${inverse.length}`)

  // Build a unique (symbol@exchange@interval) list, interleaving exchanges so
  // a small slice still exercises spot + linear + inverse paths.
  const allSubs: Sub[] = []
  const maxLen = Math.max(spot.length, linear.length, inverse.length)
  for (let i = 0; i < maxLen; i++) {
    for (const interval of INTERVALS) {
      if (spot[i]) {
        allSubs.push({
          symbol: spot[i],
          exchange: ExchangeEnum.kucoin,
          interval,
        })
      }
      if (linear[i]) {
        allSubs.push({
          symbol: linear[i],
          exchange: ExchangeEnum.kucoinLinear,
          interval,
        })
      }
      if (inverse[i]) {
        allSubs.push({
          symbol: inverse[i],
          exchange: ExchangeEnum.kucoinInverse,
          interval,
        })
      }
    }
  }

  const testSubs = isFinite(MAX_SUBS) ? allSubs.slice(0, MAX_SUBS) : allSubs
  console.log(
    `\nSending ${testSubs.length} subscriptions to KucoinConnector (of ${allSubs.length} total)...`,
  )
  for (const s of testSubs.slice(0, 50)) {
    console.log(`   ${s.symbol}@${s.exchange}@${s.interval}`)
  }
  if (testSubs.length > 50) {
    console.log(`   ... (${testSubs.length - 50} more)`)
  }

  for (const sub of testSubs) {
    connector.subscribeCandleCb(sub)
  }

  console.log(
    `\nAll ${testSubs.length} subs enqueued - debouncing 5s before WS subscribe, then listening for ${DURATION_S}s.\n`,
  )

  await new Promise((r) => setTimeout(r, DURATION_S * 1000))

  // -- Report ---------------------------------------------------------------
  const uniqueChannels = Object.keys(channelHits).length
  console.log(`\n${'-'.repeat(60)}`)
  console.log(
    `Done  |  subs enqueued: ${testSubs.length}  |` +
      `  unique channels with data: ${uniqueChannels}  |` +
      `  total msgs: ${totalMessages}`,
  )

  await redisSub.quit()
  process.exit(0)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
