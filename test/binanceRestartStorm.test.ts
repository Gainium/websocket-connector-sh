/**
 * Regression coverage for the Binance price-connector restart storm (spec 013).
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * `binanceErrorCb` is registered on all EIGHT binance clients and
 * `stopBinance()` recreates all eight whichever one faulted, so before the guard
 * every exception started its own full teardown + re-subscribe cycle. In
 * production that ran at ~0.4-1.3 cycles/s and no Binance socket — including the
 * separate-endpoint binanceUS/usdm/coinm ones — survived long enough to finish a
 * handshake (spec 013 §1.3, §1.4).
 *
 * Two shapes have to collapse, and they are not the same test:
 *   - a same-tick burst (all eight clients fault together);
 *   - a 1-per-second sequence, which is what production actually logged, spaced
 *     by `connectBinanceCandleStreams`' own `await sleep(1000)` between chunk
 *     dials. `init()` resolves in the same tick here (it only ARMS a 5s debounce
 *     timer), so a guard scoped to the cycle's promise — bybit's shape — would
 *     be released before the re-dial it scheduled even starts, and would not
 *     collapse this one. Hence `binanceRestartSettle` (spec 013 §1.1b/§1.2b).
 *
 * No live WS or REST is touched: the real `binanceErrorCb`/`runBinanceRestart`
 * are driven off the prototype against a fake `this` that counts cycles — the
 * idiom of `bybitRestartStorm.test.ts`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import BinanceConnector from '../src/price/binance'
import { ExchangeEnum } from '../src/utils/common'

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

/** A `ws` transport fault, the shape `parseWsError` emits (spec 013 §1.3). */
const REAL_FAILURE = {
  wsKey: 'main',
  message: 'Unexpected server response: 404',
}

/**
 * Drive the real handler with a fake `this`, so we can count restart cycles and
 * observe how many run concurrently. `binanceRestartSettle` is shortened so the
 * suite does not sit through the production 15s window.
 */
function makeHarness(settleMs = 60, initDelayMs = 0) {
  const calls = { stop: 0, init: 0 }
  let inFlight = 0
  let maxInFlight = 0

  const proto = BinanceConnector.prototype as any

  const fake = {
    binanceRestarting: false,
    binanceRestartSettle: settleMs,
    runBinanceRestart: proto.runBinanceRestart,
    stopBinance() {
      calls.stop++
    },
    async init() {
      calls.init++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      if (initDelayMs) await sleep(initDelayMs)
      inFlight--
    },
  }

  const cbFor = (exchange: ExchangeEnum) =>
    proto.binanceErrorCb.call(fake, exchange)

  return { cbFor, calls, maxInFlight: () => maxInFlight }
}

/** The eight clients `getBinanceClient` registers the handler on. */
const ALL_EIGHT: ExchangeEnum[] = [
  ExchangeEnum.binance,
  ExchangeEnum.binanceUsdm,
  ExchangeEnum.binanceCoinm,
  ExchangeEnum.binanceUS,
  ExchangeEnum.binance,
  ExchangeEnum.binanceUS,
  ExchangeEnum.binanceUsdm,
  ExchangeEnum.binanceCoinm,
]

test('§1.1a a same-tick burst from all eight clients collapses into ONE cycle', async () => {
  // Handler-level property only. In the live object graph a same-tick burst is
  // already largely self-limiting, because `stopBinance()` synchronously calls
  // `removeAllListeners()` on the clients it replaces — so this is the weaker
  // of the two shapes. The one that actually storms is the next test.
  const h = makeHarness(60, 20)
  ALL_EIGHT.forEach((e) => h.cbFor(e)(REAL_FAILURE))
  await sleep(150)
  assert.equal(
    h.maxInFlight(),
    1,
    'overlapping cycles recreate clients that are still mid-handshake',
  )
  assert.equal(
    h.calls.init,
    1,
    'the burst must be COALESCED (dropped), not queued into eight restarts',
  )
  assert.equal(h.calls.stop, 1)
})

test('§1.1b exceptions arriving 1s apart still collapse into ONE cycle', async () => {
  // The production shape: one exception per second for the length of a re-dial.
  // A guard released when `init()` resolves would restart on every one of them.
  const h = makeHarness(350)
  for (let i = 0; i < 6; i++) {
    h.cbFor(ExchangeEnum.binance)(REAL_FAILURE)
    await sleep(50)
  }
  await sleep(50)
  assert.equal(
    h.calls.stop,
    1,
    'the guard must outlive init(), which only arms the 5s re-dial debounce',
  )
})

test('§1.1c benign SDK replies are logged, not answered with a restart', async () => {
  const h = makeHarness()
  h.cbFor(ExchangeEnum.binance)({ wsKey: 'main', message: 'handler not found' })
  h.cbFor(ExchangeEnum.binance)({ wsKey: 'main', message: 'format error' })
  h.cbFor(ExchangeEnum.binance)({
    wsKey: 'main',
    error: 'error:already subscribed,topic:x',
  })
  await sleep(120)
  assert.equal(
    h.calls.stop,
    0,
    'self-clearing replies must not tear down eight clients',
  )
  assert.equal(h.calls.init, 0)
})

test('§3 a genuinely fatal exception still restarts the whole family', async () => {
  const h = makeHarness()
  h.cbFor(ExchangeEnum.binanceUsdm)(REAL_FAILURE)
  await sleep(30)
  assert.equal(h.calls.stop, 1, 'the recovery RADIUS is deliberately unchanged')
  assert.equal(h.calls.init, 1)
})

test('§1.1b the guard must not latch permanently', async () => {
  const h = makeHarness(40)
  h.cbFor(ExchangeEnum.binance)(REAL_FAILURE)
  await sleep(120)
  h.cbFor(ExchangeEnum.binance)(REAL_FAILURE)
  await sleep(120)
  assert.equal(h.calls.init, 2, 'a later fault recovers once the window closed')
})

test('§1.2b init() really does resolve in the same tick (why the window exists)', async () => {
  // Locks in the premise of §1.2b: if `init()` ever grows a body that awaits the
  // re-dial, `binanceRestartSettle` can be dropped — until then it cannot.
  const proto = BinanceConnector.prototype as any
  const src = `${proto.init}`
  assert.ok(
    !/await\s+this\.reconnectBinanceCandleStream|await\s+this\.initBinanceWS/.test(
      src,
    ),
    'init() awaits its reconnect now — re-check whether the settle window is still needed',
  )
})
