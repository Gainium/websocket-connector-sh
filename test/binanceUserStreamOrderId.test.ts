/**
 * Binance user stream → exchange order id precision contract (spec 004).
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Binance issues order ids as JSON *numbers*. USDM futures ids are now 19 digits
 * (8389766269723522123), well above `Number.MAX_SAFE_INTEGER`, and `JSON.parse`
 * has no representation for one — it returns the nearest IEEE-754 double, so the
 * low digits become zeros. The vendor SDK parses every frame that way before our
 * listener runs, so the id was already rounded by the time `convertFutures` read
 * it (spec 004 §3). On production this rounded 741 of 743 stored binanceUsdm
 * order ids and collapsed 22 groups of genuinely different orders onto one id
 * each (§2.2), which is how a bot can cancel or poll the wrong exchange order.
 *
 * The frames below are the real prod shapes for the ETHUSDT orders in the
 * 2026-09-03 user-stream log (§2.1), with the id restored to a plausible exact
 * value — the true low digits only exist at Binance.
 *
 * These tests drive the REAL vendor client: the frame goes in as raw text through
 * `onWsMessage()`, and the listener is the one `userStream.ts:1916` installs. That
 * is deliberate — a test that hands `convertFutures` an already-parsed object
 * cannot fail for the reason §3 names, because the digits are gone before it runs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { WebsocketClient } from 'binance'
import { convert, convertFutures } from '../src/utils/binance'
import { withLosslessOrderIds } from '../src/binance-custom'
import {
  parseBinanceWsFrame,
  quoteUnsafeIntegerIds,
} from '../src/binance-custom/losslessOrderId'

/** A 19-digit USDM order id, above 2^53. */
const HUGE_ID = '8389766269723522123'
/** What a bare `JSON.parse` turns HUGE_ID into today — note the trailing zeros. */
const ROUNDED_ID = '8389766269723522000'
/** An ordinary id, comfortably below 2^53. */
const SAFE_ID = '4293153'

/**
 * A raw `ORDER_TRADE_UPDATE` frame with `o.i` as a bare JSON number of exactly
 * `id`'s digits. Built as text, not via `JSON.stringify`, because the whole point
 * is that the digits must survive as text up to the parser under test.
 */
function futuresFrame(id: string, clientOrderId = 'D-BO-9CLgYh80pabXS6hhObOG') {
  return (
    `{"e":"ORDER_TRADE_UPDATE","E":1788446892253,"T":1788446892253,"o":{` +
    `"s":"ETHUSDT","c":"${clientOrderId}","S":"BUY","o":"LIMIT","f":"GTC",` +
    `"q":"0.009","p":"3200.00","ap":"3200.00","sp":"0","x":"TRADE","X":"FILLED",` +
    `"i":${id},"l":"0.009","z":"0.009","L":"3200.00","N":"USDT","n":"0.0144",` +
    `"T":1788446892253,"t":911223344,"b":"0","a":"0","m":false,"R":false,` +
    `"wt":"CONTRACT_PRICE","ot":"LIMIT","ps":"BOTH","cp":false,"rp":"0"}}`
  )
}

/** A raw spot `executionReport` frame with `i` as a bare JSON number. */
function spotFrame(id: string) {
  return (
    `{"e":"executionReport","E":1788446892253,"s":"ETHUSDT",` +
    `"c":"D-TP-6HG0kdvklqx69YsEb4jH","S":"SELL","o":"LIMIT","f":"GTC",` +
    `"q":"0.009","p":"3200.00","P":"0","F":"0","g":-1,"C":null,"x":"TRADE",` +
    `"X":"FILLED","r":"NONE","i":${id},"l":"0.009","z":"0.009","L":"3200.00",` +
    `"n":"0.0144","N":"USDT","T":1788446892253,"t":911223344,"w":false,` +
    `"m":true,"O":1788446892000,"Z":"28.80","Q":"0","Y":"28.80",` +
    `"B":{"a":"ETH","f":"1.0","l":"0.0"}}`
  )
}

const silentLogger = {
  silly: () => {},
  debug: () => {},
  notice: () => {},
  info: () => {},
  warning: () => {},
  error: () => {},
  trace: () => {},
}

/**
 * Feed `raw` to a real vendor client and return what the `userStream.ts:1916`
 * listener would hand to `userStreamEvent`.
 *
 * `lossless` selects the seam under test: `false` reproduces today's behaviour
 * (no `customParseJSONFn`, so the SDK's bare `JSON.parse` runs), `true` applies
 * the fix. No socket, no credentials — `onWsMessage` is the SDK's own entry point
 * for a received frame.
 */
function receive(
  raw: string,
  kind: 'futures' | 'spot',
  lossless: boolean,
): Record<string, unknown> {
  const client = new WebsocketClient(
    lossless
      ? withLosslessOrderIds({ api_key: 'test', api_secret: 'test' })
      : { api_key: 'test', api_secret: 'test' },
    silentLogger as never,
  )
  let out: Record<string, unknown> | null = null
  client.on('message', (data: unknown) => {
    out = (kind === 'futures' ? convertFutures(data) : convert(data)) as Record<
      string,
      unknown
    >
  })
  // Same call the SDK makes on a received frame; wsKey only selects logging.
  ;(
    client as unknown as {
      onWsMessage: (e: unknown, k: string, w: unknown) => void
    }
  ).onWsMessage({ type: 'message', data: raw }, 'usdmPrivate', {})
  client.closeAll(false)
  assert.ok(out, 'vendor client emitted no message for this frame')
  return out as unknown as Record<string, unknown>
}

test('§3 today the vendor parse is the truncation point', () => {
  const before = receive(futuresFrame(HUGE_ID), 'futures', false)
  assert.equal(
    String(before.orderId),
    ROUNDED_ID,
    'baseline changed — re-derive spec 004 §3 before trusting the rest of this file',
  )
})

test('§1.1.1 a 19-digit futures order id survives the user stream exactly', () => {
  const ev = receive(futuresFrame(HUGE_ID), 'futures', true)
  assert.equal(String(ev.orderId), HUGE_ID)
})

test('§1.1.1 the exact id reaches the Redis payload, not just the mapper', () => {
  const ev = receive(futuresFrame(HUGE_ID), 'futures', true)
  // userStreamEvent publishes `JSON.stringify(streamMsg)` (userStream.ts:3859).
  const published = JSON.parse(JSON.stringify(ev))
  assert.equal(published.orderId, HUGE_ID)
  assert.ok(
    String(ev.uniqueMessageId).endsWith(HUGE_ID),
    `uniqueMessageId lost the id: ${ev.uniqueMessageId}`,
  )
})

test('§1.1.3 two ids that round to the same double stay distinct', () => {
  const a = receive(futuresFrame('8389766269723522123'), 'futures', true)
  const b = receive(futuresFrame('8389766269723522089'), 'futures', true)
  assert.notEqual(String(a.orderId), String(b.orderId))
  // Both collapse onto ROUNDED_ID without the fix — that is the 22 prod
  // collision groups in §2.2.
  assert.equal(String(Number(a.orderId)), String(Number(b.orderId)))
})

test('§1.1.2 / §4.3.1 an ordinary futures id is untouched and stays a number', () => {
  const ev = receive(futuresFrame(SAFE_ID), 'futures', true)
  assert.equal(ev.orderId, Number(SAFE_ID))
  assert.equal(typeof ev.orderId, 'number')
})

test('§1.1.2 / §4.3.1 an ordinary spot id is untouched and stays a number', () => {
  const ev = receive(spotFrame(SAFE_ID), 'spot', true)
  assert.equal(ev.orderId, Number(SAFE_ID))
  assert.equal(typeof ev.orderId, 'number')
})

test('§4.1.2 a spot execution report with a huge id is exact too', () => {
  const ev = receive(spotFrame(HUGE_ID), 'spot', true)
  assert.equal(String(ev.orderId), HUGE_ID)
})

test('§4.3.2 digits inside a clientOrderId string are never rewritten', () => {
  // A client order id made entirely of digits above 2^53 is the adversarial case:
  // it is a JSON string, so the scan must skip it whole.
  const ev = receive(
    futuresFrame(SAFE_ID, '99999999999999999999'),
    'futures',
    true,
  )
  assert.equal(ev.clientOrderId, '99999999999999999999')
  assert.equal(typeof ev.clientOrderId, 'string')
  assert.equal(ev.orderId, Number(SAFE_ID))
})

test('§4.3.3 a malformed frame throws exactly as JSON.parse does', () => {
  // The vendor wraps the parse in a try/catch and emits an `exception` event with
  // the raw frame (websocket-client.js:743). Swallowing the error here would hand
  // it a string as the parsed event instead, and that signal would be lost.
  const broken = '{"e":"ORDER_TRADE_UPDATE","o":{"i":8389766269723522123'
  assert.throws(() => JSON.parse(broken), SyntaxError)
  assert.throws(() => parseBinanceWsFrame(broken), SyntaxError)
})

test('§4.3.3 an unterminated string literal degrades to no rewrite, not a hang', () => {
  const broken = '{"e":"ORDER_TRADE_UPDATE","c":"D-BO-unterminated'
  assert.equal(quoteUnsafeIntegerIds(broken), broken)
  assert.throws(() => parseBinanceWsFrame(broken), SyntaxError)
})

test('§4.3.4 a non-order frame is unchanged by the parser', () => {
  const raw =
    `{"e":"outboundAccountPosition","E":1788446892253,"u":1788446892253,` +
    `"B":[{"a":"ETH","f":"1.00000000","l":"0.00000000"}]}`
  const withFix = receive(raw, 'spot', true)
  const without = receive(raw, 'spot', false)
  assert.deepEqual(withFix, without)
})
