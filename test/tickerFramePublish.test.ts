/**
 * A ticker frame is published promptly and in order.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * `cbWs` used to wait on a timer after every ticker, so a frame of N tickers
 * took at least N timer ticks and frames overlapped. Nothing here opens a
 * socket or reaches Redis: `cbWs` runs against a fake `this`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import CommonConnector from '../src/price/common'
import { ExchangeEnum } from '../src/utils/common'

const proto = CommonConnector.prototype as any
const e = ExchangeEnum.binance

function fake() {
  const published: { channel: string; msg: any }[] = []
  const self: any = {
    mainData: { [e]: { lastData: 0, connectTime: 0 } },
    targetedRestarts: new Map(),
    tickerTail: new Map(),
    tickerYieldEvery: 200,
    redis: {
      publish: (channel: string, msg: string) => {
        published.push({ channel, msg: JSON.parse(msg) })
      },
    },
  }
  self.cbWs = proto.cbWs.bind(self)
  self.publishTickers = proto.publishTickers.bind(self)
  return { self, published }
}

const frame = (n: number, eventTime: number, price = '1') =>
  Array.from({ length: n }, (_, i) => ({
    eventType: '24hrMiniTicker',
    eventTime,
    symbol: `S${i}USDT`,
    curDayClose: price,
    bestBid: price,
    bestBidQnt: '2',
    bestAsk: price,
    bestAskQnt: '2',
    open: '1',
    high: '1',
    low: '1',
    volume: '3',
    volumeQuote: '3',
  })) as any

/** Count timers that fire while `fn` runs. */
async function countTimers(fn: () => Promise<void>) {
  const realSetTimeout = global.setTimeout
  let timers = 0
  ;(global as any).setTimeout = (...a: any[]) => {
    timers++
    return (realSetTimeout as any)(...a)
  }
  try {
    await fn()
  } finally {
    global.setTimeout = realSetTimeout
  }
  return timers
}

test('a frame is published whole, in order, without a timer per ticker', async () => {
  const { self, published } = fake()
  const n = 1000
  const started = Date.now()
  const timers = await countTimers(() => self.cbWs(frame(n, 111), e))
  const took = Date.now() - started

  assert.equal(published.length, n)
  assert.deepEqual(
    published.map((p) => p.channel),
    Array.from({ length: n }, (_, i) => `trade@S${i}USDT@${e}`),
  )
  assert.equal(timers, 0)
  // 1000 timer ticks are >= 1s; this leaves a wide margin for a slow machine.
  assert.ok(took < 500, `took ${took}ms`)
  assert.equal(self.tickerTail.size, 0)
})

test('the published payload keeps its shape', async () => {
  const { self, published } = fake()
  await self.cbWs(frame(1, 111, '5'), e)
  const { eventTime, ...rest } = published[0].msg
  assert.equal(typeof eventTime, 'number')
  assert.deepEqual(rest, {
    symbol: 'S0USDT',
    time: 111,
    price: 5,
    volume: 3,
    bestAsk: 5,
    bestBid: 5,
    bestAskQnt: 2,
    bestBidQnt: 2,
    uniqueMessageId: `S0USDT@111@${e}535522`,
    exchange: e,
  })
})

test('a small frame is published before cbWs returns', () => {
  const { self, published } = fake()
  self.cbWs(frame(200, 111), e)
  assert.equal(published.length, 200)
})

test('a large frame yields to the event loop between chunks', async () => {
  const { self, published } = fake()
  const seen: number[] = []
  const done = self.cbWs(frame(450, 111), e)
  assert.equal(published.length, 200)
  setImmediate(() => seen.push(published.length))
  await done
  assert.equal(published.length, 450)
  // The immediate queued behind the first yield ran before the frame ended.
  assert.deepEqual(seen, [400])
})

test('a frame arriving mid-publish does not overtake the one in flight', async () => {
  const { self, published } = fake()
  const a = self.cbWs(frame(450, 1, '1'), e)
  const b = self.cbWs(frame(450, 2, '2'), e)
  const c = self.cbWs(frame(1, 3, '3'), e)
  await Promise.all([a, b, c])
  assert.equal(published.length, 901)
  const times = published.map((p) => p.msg.time)
  assert.deepEqual(
    times,
    [...times].sort((x, y) => x - y),
  )
  // Last message for a symbol is the newest frame's.
  const last = new Map(published.map((p) => [p.msg.symbol, p.msg.price]))
  assert.equal(last.get('S0USDT'), 3)
  assert.equal(last.get('S449USDT'), 2)
  assert.equal(self.tickerTail.size, 0)
})

test('frames of different exchanges do not wait for each other', () => {
  const { self, published } = fake()
  const other = ExchangeEnum.binanceUsdm
  self.mainData[other] = { lastData: 0, connectTime: 0 }
  self.cbWs(frame(450, 1), e)
  self.cbWs(frame(10, 2), other)
  assert.equal(published.filter((p) => p.msg.exchange === other).length, 10)
})
