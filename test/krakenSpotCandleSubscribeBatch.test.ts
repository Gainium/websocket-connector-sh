/**
 * Kraken spot candle subscribes go out in batches, not one message per symbol.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * The kraken-api client replays every cached subscribe back-to-back on each
 * reconnect. With one ohlc subscribe per symbol that was a burst of 100+
 * messages per socket, and Kraken rejected the tail with "Exceeded msg rate".
 * The rejected symbols then had no candles until main-app re-requested them. Nothing here
 * opens a socket: the connector runs against a fake `this` and a fake client.
 */

import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import KrakenConnector from '../src/price/kraken'
import { ExchangeEnum } from '../src/utils/common'

const proto = KrakenConnector.prototype as any

function fake(symbols: string[]) {
  const sent: { symbol: string[]; interval: number }[] = []
  const handlers: Record<string, (data: any) => void> = {}
  let describe: ((data: any) => string) | undefined
  const subscribed = new Map<ExchangeEnum, Set<string>>()
  const self: any = {
    krakenSpotCandleClients: [],
    subscribedCandlesMap: subscribed,
    spotSymbolMaps: {
      normalizedToWsname: new Map(symbols.map((s) => [s, `${s}/USD`])),
    },
    ensureSymbolMaps: async () => undefined,
    krakenCandleCb: () => () => undefined,
    getKrakenClient: (
      _type: string,
      _futures: boolean,
      _current: unknown,
      _label: string,
      onError: (data: any) => string,
    ) => {
      describe = onError
      return {
        on: (event: string, cb: (data: any) => void) => (handlers[event] = cb),
        subscribe: (topics: any[]) => sent.push(topics[0].payload),
      }
    },
  }
  for (const m of [
    'connectKrakenCandleStream',
    'getSpotCandleClient',
    'scheduleCandleFlush',
    'dropCandleRoom',
    'getCandleRoomName',
  ]) {
    self[m] = proto[m].bind(self)
  }
  const request = async (symbol: string) => {
    const room = self.getCandleRoomName(symbol, ExchangeEnum.kraken, '1h')
    const set = subscribed.get(ExchangeEnum.kraken) ?? new Set<string>()
    set.add(room)
    subscribed.set(ExchangeEnum.kraken, set)
    await self.connectKrakenCandleStream(symbol, '1h')
  }
  const rooms = () => subscribed.get(ExchangeEnum.kraken) ?? new Set<string>()
  return { sent, handlers, request, rooms, reject: (d: any) => describe!(d) }
}

const names = (n: number) => Array.from({ length: n }, (_, i) => `C${i}`)

test('symbols requested together go out as one ohlc subscribe per 100', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const f = fake(names(130))
    for (const s of names(130)) await f.request(s)
    assert.equal(f.sent.length, 0, 'nothing is sent before the flush window')
    mock.timers.tick(500)
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0].symbol.length, 100)
    assert.equal(f.sent[0].interval, 60)
    mock.timers.tick(500)
    assert.equal(f.sent.length, 2)
    assert.deepEqual(
      f.sent[1].symbol,
      names(130)
        .slice(100)
        .map((s) => `${s}/USD`),
    )
  } finally {
    mock.timers.reset()
  }
})

test('a rejection that names no symbol drops the whole batch it belongs to', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const f = fake(names(3))
    for (const s of names(2)) await f.request(s)
    mock.timers.tick(500)
    await f.request('C2')
    mock.timers.tick(500)
    // Kraken processes messages in order: the first batch is rejected whole.
    const line = f.reject({
      error: 'Exceeded msg rate',
      method: 'subscribe',
      success: false,
    })
    assert.match(line, /C0\/USD, C1\/USD/)
    assert.deepEqual([...f.rooms()], ['C2@kraken@1hCandle'])
  } finally {
    mock.timers.reset()
  }
})

test('acks settle their own symbol; a named rejection drops only that symbol', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const f = fake(names(3))
    for (const s of names(3)) await f.request(s)
    mock.timers.tick(500)
    f.handlers.response({
      method: 'subscribe',
      success: true,
      result: { symbol: 'C0/USD' },
    })
    const line = f.reject({
      error: 'Currency pair not supported',
      method: 'subscribe',
      success: false,
      symbol: 'C2/USD',
    })
    assert.match(line, /for C2\/USD at/)
    assert.deepEqual([...f.rooms()].sort(), [
      'C0@kraken@1hCandle',
      'C1@kraken@1hCandle',
    ])
    // C1 is still awaiting its ack, so an unnamed rejection now maps to it.
    assert.match(
      f.reject({
        error: 'Exceeded msg rate',
        method: 'subscribe',
        success: false,
      }),
      /for C1\/USD at/,
    )
  } finally {
    mock.timers.reset()
  }
})

test('a symbol requested twice at one interval is subscribed once', async () => {
  // Boot order on prod: main-app's candle requests arrive before the symbol
  // maps load, then init() replays every room already in the set.
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const f = fake(names(2))
    for (const s of names(2)) await f.request(s)
    for (const s of names(2)) await f.request(s)
    mock.timers.tick(500)
    mock.timers.tick(500)
    assert.equal(f.sent.length, 1)
    assert.deepEqual(f.sent[0].symbol, ['C0/USD', 'C1/USD'])
  } finally {
    mock.timers.reset()
  }
})

test('"Already subscribed" names no symbol but drops nothing', async () => {
  // Verbatim shape of Kraken's answer to a repeated ohlc subscribe: the other
  // symbols of the same message are acked, the repeat gets this.
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const f = fake(names(2))
    for (const s of names(2)) await f.request(s)
    mock.timers.tick(500)
    const line = f.reject({
      error: 'Already subscribed to one ohlc interval on this symbol',
      method: 'subscribe',
      req_id: 1,
      success: false,
    })
    assert.match(line, /already subscribed; nothing to retry/)
    assert.equal(f.rooms().size, 2)
  } finally {
    mock.timers.reset()
  }
})
