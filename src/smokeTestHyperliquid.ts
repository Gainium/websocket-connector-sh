#!/usr/bin/env ts-node
/**
 * Smoke test – uses HyperliquidConnector directly (the real production path).
 *
 * Sends subscriptions through the connector, which internally batches WS
 * subscribe messages with rate-limiting.  A separate Redis pSubscribe monitors
 * the output channels to verify candle data is actually published.
 *
 * Usage:
 *   npm run test:hl-candles [-- durationSeconds maxSubs]
 *   e.g.  npm run test:hl-candles -- 120 56
 *
 * Environment:
 *   PRICEROLE=candle  (set by the npm script)
 *   HYPERLIQUIDENV=demo  -  uses testnet
 */

import HyperliquidConnector from './price/hyperliquid'
import { ExchangeEnum } from './utils/common'
import { createClient } from 'redis'

const DURATION_S = Number(process.argv[2] ?? 60)
// Default: 2 linear coins x 14 intervals = 28 subscriptions
const MAX_SUBS = Number(process.argv[3] ?? 28)

const INTERVALS: string[] = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
]

// --- fetch all live symbols from the Hyperliquid REST API -------------------
async function fetchSymbols(): Promise<{ linear: string[]; spot: string[] }> {
  const baseUrl =
    process.env.HYPERLIQUIDENV === 'demo'
      ? 'https://api.hyperliquid-testnet.xyz'
      : 'https://api.hyperliquid.xyz'

  const [metaRes, spotRes] = await Promise.all([
    fetch(`${baseUrl}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'meta' }),
    }),
    fetch(`${baseUrl}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotMeta' }),
    }),
  ])

  const meta = (await metaRes.json()) as { universe: { name: string }[] }
  const spotMeta = (await spotRes.json()) as {
    universe: { name: string; tokens: number[] }[]
  }

  return {
    linear: meta.universe.map((a) => a.name),
    spot: spotMeta.universe.map((_, i) => `@${i}`),
  }
}

// --- main -------------------------------------------------------------------
async function main() {
  // -- Redis subscriber: monitors what the connector publishes ---------------
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
      const data = JSON.parse(message) as { close: string }
      console.log(`[${totalMessages}] ${channel}  close=${data.close}`)
    }
  })

  // -- Create connector (PRICEROLE=candle is set by the npm script) ----------
  const connector = new HyperliquidConnector()
  // Disable the watchdog timer so it does not trigger reconnects during the test
  clearInterval(connector.watchdog!)
  connector.watchdog = null

  await connector.init()
  console.log('HyperliquidConnector initialised')

  // -- Fetch symbols and build the subscription list -------------------------
  console.log('\nFetching Hyperliquid symbols...')
  const { linear, spot } = await fetchSymbols()
  console.log(`  Linear (perp): ${linear.length} symbols`)
  console.log(`  Spot:          ${spot.length} symbols`)

  const allSubs = [
    ...linear.flatMap((symbol) =>
      INTERVALS.map((interval) => ({
        symbol,
        exchange: ExchangeEnum.hyperliquidLinear,
        interval,
      })),
    ),
    ...spot.flatMap((symbol) =>
      INTERVALS.map((interval) => ({
        symbol,
        exchange: ExchangeEnum.hyperliquid,
        interval,
      })),
    ),
  ]
  const testSubs = allSubs.slice(0, MAX_SUBS)

  console.log(
    `\nSending ${testSubs.length} subscriptions to HyperliquidConnector...`,
  )
  testSubs.forEach((s) =>
    console.log(`   ${s.symbol}@${s.exchange}@${s.interval}`),
  )

  // Feed all subscriptions into the connector.  The connector queues them and
  // batch-subscribes over WS after the 5-second first-win debounce fires.
  for (const sub of testSubs) {
    connector.subscribeCandleCb(sub)
  }

  const batchSecs = Math.ceil(testSubs.length / 20) + 6
  console.log(
    `\nAll ${testSubs.length} subs enqueued - connector will send them over` +
      ` ~${batchSecs}s, listening for ${DURATION_S}s total.\n`,
  )

  // -- Wait for the full test duration ---------------------------------------
  await new Promise((r) => setTimeout(r, DURATION_S * 1000))

  // -- Final report ----------------------------------------------------------
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
