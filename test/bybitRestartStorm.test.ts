/**
 * Regression coverage for the Bybit price-connector restart storm (bug #121).
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Two independent defects fed each other:
 *   1. Bybit answers a duplicate subscribe with
 *      `{success:false, ret_msg:"error:already subscribed,topic:..."}`. The
 *      vendored client routes ANY `success:false` reply to `exception`, and
 *      `bybitRestartCb` treated every exception as fatal -> full stop+reinit.
 *   2. `bybitRestartCb` had no re-entrancy guard, so the spot/linear/inverse
 *      clients could each start an overlapping restart cycle. Since
 *      `initBybitWS` re-subscribes every ticker topic with 5s sleeps between
 *      markets, overlapping cycles double-subscribe -> more "already
 *      subscribed" -> back to (1).
 *
 * No live WS or REST is touched: the message classification test drives the
 * vendored parser directly, and the restart tests invoke the real
 * `bybitRestartCb` against a fake `this` that counts cycles.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import BybitConnector from '../src/price/bybit'
import { WebsocketClient as BybitWSClient } from '../bybit-custom/websocket-client'
import { ExchangeEnum, wsLoggerOptions } from '../src/utils/common'

/** Verbatim Bybit v5 reply to re-subscribing an already-active topic. */
const ALREADY_SUBSCRIBED = {
  success: false,
  ret_msg: 'error:already subscribed,topic:tickers.AAVEUSD',
  conn_id: 'f1d9b1e0-0000-4000-8000-000000000000',
  req_id: '',
  op: 'subscribe',
}

/** A genuinely fatal subscribe failure (must still trigger a restart). */
const REAL_FAILURE = {
  success: false,
  ret_msg: 'error:handler timeout',
  conn_id: 'f1d9b1e0-0000-4000-8000-000000000001',
  req_id: '',
  op: 'subscribe',
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

/**
 * Drive the real `bybitRestartCb` with a fake `this`, so we can count restart
 * cycles and observe how many run concurrently.
 */
function makeHarness(initDelayMs = 25) {
  const calls = { stop: 0, init: 0, candle: 0 }
  let inFlight = 0
  let maxInFlight = 0

  const proto = BybitConnector.prototype as any

  // Real restart-cycle implementation, fake leaf dependencies.
  const fake = {
    bybitRestarting: false,
    runBybitRestart: proto.runBybitRestart,
    stopBybit() {
      calls.stop++
    },
    async initBybitWS() {
      calls.init++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await sleep(initDelayMs)
      inFlight--
    },
    async reconnectBybitCandleStream() {
      calls.candle++
    },
  }

  const cbFor = (exchange: ExchangeEnum) =>
    (BybitConnector.prototype as any).bybitRestartCb.call(fake, exchange)

  return { cbFor, calls, maxInFlight: () => maxInFlight }
}

test('bybit "already subscribed" is classified as a WS exception', () => {
  const client = new BybitWSClient({ market: 'v5' }, wsLoggerOptions)
  try {
    const events = (client as any).resolveEmittableEvents('v5SpotPublic', {
      data: JSON.stringify(ALREADY_SUBSCRIBED),
    })
    assert.equal(
      events[0]?.eventType,
      'exception',
      'a duplicate-subscribe reply reaches the connector via the exception channel',
    )
  } finally {
    client.closeAll(false)
  }
})

test('"already subscribed" must NOT trigger a connector restart', async () => {
  const h = makeHarness()
  h.cbFor(ExchangeEnum.bybit)(ALREADY_SUBSCRIBED)
  await sleep(60)
  assert.equal(
    h.calls.stop,
    0,
    'no stopBybit for a harmless duplicate subscribe',
  )
  assert.equal(
    h.calls.init,
    0,
    'no initBybitWS for a harmless duplicate subscribe',
  )
})

test('existing benign messages stay skipped', async () => {
  const h = makeHarness()
  h.cbFor(ExchangeEnum.bybit)({ ret_msg: 'handler not found' })
  h.cbFor(ExchangeEnum.bybit)({ ret_msg: 'format error' })
  await sleep(60)
  assert.equal(
    h.calls.stop,
    0,
    'handler not found / format error remain non-fatal',
  )
})

test('a genuinely fatal WS error still restarts the connector', async () => {
  const h = makeHarness()
  h.cbFor(ExchangeEnum.bybit)(REAL_FAILURE)
  await sleep(60)
  assert.equal(h.calls.stop, 1, 'real failures must still recover')
  assert.equal(h.calls.init, 1)
})

test('concurrent exceptions collapse into ONE restart cycle', async () => {
  const h = makeHarness(40)
  // spot / linear / inverse each raise their own exception within the same tick
  h.cbFor(ExchangeEnum.bybit)(REAL_FAILURE)
  h.cbFor(ExchangeEnum.bybitUsdm)(REAL_FAILURE)
  h.cbFor(ExchangeEnum.bybitCoinm)(REAL_FAILURE)
  await sleep(120)
  assert.equal(
    h.maxInFlight(),
    1,
    'overlapping restart cycles double-subscribe topics and feed the storm',
  )
  assert.equal(
    h.calls.init,
    1,
    'the burst is coalesced, not queued into N restarts',
  )
})

test('a later fatal error can still restart once the cycle finished', async () => {
  const h = makeHarness(10)
  h.cbFor(ExchangeEnum.bybit)(REAL_FAILURE)
  await sleep(80)
  h.cbFor(ExchangeEnum.bybit)(REAL_FAILURE)
  await sleep(80)
  assert.equal(h.calls.init, 2, 'the guard must not latch permanently')
})
