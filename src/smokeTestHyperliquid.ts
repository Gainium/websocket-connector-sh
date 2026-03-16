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

import * as hl from '@nktkas/hyperliquid'
import HyperliquidConnector from './price/hyperliquid'
import { ExchangeEnum } from './utils/common'
import { createClient } from 'redis'

const DURATION_S = Number(process.argv[2] ?? 60)
// Default: 2 linear coins x 14 intervals = 28 subscriptions
const MAX_SUBS = Number(process.argv[3] ?? 28)
// Pass --reconnect as 4th arg to run the reconnect resilience test.
// Fixed set of 28 subs (BTC+ETH × 14 intervals), waits for data, force-closes
// the WS, then verifies data resumes after the connector re-subscribes.
const RECONNECT_TEST = process.argv[4] === '--reconnect'

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

// --- reconnect resilience test ----------------------------------------------
// Subscribes to BTC+ETH x all intervals, waits for data, then force-closes
// the WebSocket and checks that data resumes — proving our rate-limited
// reconnect handler works instead of the library's burst autoResubscribe.
async function runReconnectTest(
  connector: HyperliquidConnector,
  channelHits: Record<string, number>,
  getMsgCount: () => number,
) {
  const SETTLE_S = 30 // seconds to wait for initial data before forcing close
  const RESUME_S = 90 // seconds to wait post-reconnect for data to resume

  // Subscribe the fixed small set (already done by main)
  console.log(`\n[reconnect-test] Waiting ${SETTLE_S}s for initial data...`)
  await new Promise((r) => setTimeout(r, SETTLE_S * 1000))

  const msgsBefore = getMsgCount()
  const channelsBefore = Object.keys(channelHits).length
  console.log(
    `[reconnect-test] Before disconnect: ${msgsBefore} msgs, ${channelsBefore} unique channels`,
  )

  if (msgsBefore === 0) {
    console.error('[reconnect-test] FAIL — no data received before disconnect')
    return
  }

  // Force-close the first candle WS transport (simulates network drop)
  const clients = (
    connector as unknown as {
      hyperliquidClientCandle: {
        id: number
        items: Map<string, unknown>
        client: hl.SubscriptionClient<hl.WebSocketTransport>
      }[]
    }
  ).hyperliquidClientCandle

  const target = clients[0]
  console.log(
    `[reconnect-test] Force-closing candle client 0 (${target.items.size} active subs)...`,
  )
  // Pass permanently=false so ReconnectingWebSocket reconnects after this close.
  // This simulates a network drop (server-side close) rather than a graceful shutdown.
  target.client.transport.socket.close(1000, '', false)

  console.log(
    `[reconnect-test] Waiting ${RESUME_S}s for reconnect + resubscribe + data...`,
  )
  const t0 = Date.now()
  let resumed = false
  while (Date.now() - t0 < RESUME_S * 1000) {
    await new Promise((r) => setTimeout(r, 2000))
    if (getMsgCount() > msgsBefore) {
      resumed = true
      break
    }
  }

  const msgsAfter = getMsgCount()
  const channelsAfter = Object.keys(channelHits).length
  const elapsed = Math.round((Date.now() - t0) / 1000)

  console.log(`\n${'-'.repeat(60)}`)
  if (resumed) {
    console.log(
      `[reconnect-test] PASS — data resumed after ${elapsed}s | ` +
        `msgs after reconnect: ${msgsAfter - msgsBefore} | ` +
        `unique channels: ${channelsAfter}`,
    )
  } else {
    console.error(
      `[reconnect-test] FAIL — no data received in ${RESUME_S}s after disconnect`,
    )
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

  // -- Reconnect resilience test -------------------------------------------
  if (RECONNECT_TEST) {
    await runReconnectTest(connector, channelHits, () => totalMessages)
    await redisSub.quit()
    process.exit(0)
  }

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
