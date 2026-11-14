/**
 * Kraken spot candle sockets resubscribe in paced batches after a reconnect.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 * Spec: specs/022.kraken-spot-candle-reconnect-replay-burst.md
 *
 * The kraken-api client stores every `subscribe()` call as its own topic and,
 * on reconnect, replays all of them back-to-back. Candle subscribes are sent as
 * one message per 500 ms flush, so a socket filled by many small flushes
 * replayed one message per flush at once and Kraken answered the tail with
 * "Exceeded msg rate". Those rejections arrived with nothing pending on our
 * side, so the symbols were neither dropped nor retried — silently candle-less.
 *
 * This drives the REAL kraken-api WebsocketClient (its topic store and its
 * onWsOpen → onWsReadyForEvents replay); only the network send is stubbed.
 */

import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import KrakenConnector from '../src/price/kraken'
import { ExchangeEnum } from '../src/utils/common'

const proto = KrakenConnector.prototype as any
const wsKey = 'spotPublicV2'
const CONNECTED = 2
const RECONNECTING = 4

function harness(symbols: string[]) {
  const sent: { symbol: string[]; interval: number }[] = []
  const clients: any[] = []
  const subscribed = new Map<ExchangeEnum, Set<string>>()
  const self: any = {
    wsReconnect: 3500,
    krakenSpotCandleClients: [],
    subscribedCandlesMap: subscribed,
    spotSymbolMaps: {
      normalizedToWsname: new Map(symbols.map((s) => [s, `${s}/USD`])),
    },
    ensureSymbolMaps: async () => undefined,
    krakenCandleCb: () => () => undefined,
  }
  for (const m of [
    'getKrakenClient',
    'connectKrakenCandleStream',
    'getSpotCandleClient',
    'scheduleCandleFlush',
    'scheduleCandleRetry',
    'dropCandleRoom',
    'getCandleRoomName',
  ]) {
    self[m] = proto[m]?.bind(self)
  }
  // Wrap the real client factory: keep the real store/replay, stub the wire.
  const realGet = self.getKrakenClient
  self.getKrakenClient = (...args: any[]) => {
    const client = realGet(...args)
    client.connect = async () => undefined
    client.getWsStore().create(wsKey)
    client.getWsStore().setConnectionState(wsKey, CONNECTED)
    client.tryWsSend = (_k: string, raw: string) => {
      const msg = JSON.parse(raw)
      if (msg.method === 'subscribe') {
        sent.push({ symbol: msg.params.symbol, interval: msg.params.interval })
      }
    }
    clients.push(client)
    return client
  }
  const request = async (symbol: string) => {
    const room = self.getCandleRoomName(symbol, ExchangeEnum.kraken, '1h')
    const set = subscribed.get(ExchangeEnum.kraken) ?? new Set<string>()
    set.add(room)
    subscribed.set(ExchangeEnum.kraken, set)
    await self.connectKrakenCandleStream(symbol, '1h')
  }
  const reconnect = async () => {
    const client = clients[0]
    client.getWsStore().setConnectionState(wsKey, RECONNECTING)
    await client.onWsOpen({}, wsKey, 'wss://test', {})
    clearInterval(client.getWsStore().get(wsKey).activePingTimer)
  }
  const rooms = () => subscribed.get(ExchangeEnum.kraken) ?? new Set<string>()
  return { self, sent, clients, request, reconnect, rooms }
}

// The real client sends after an await; drain microtasks after each tick.
const drain = () => new Promise<void>((r) => setImmediate(r))
const tick = async (ms: number) => {
  mock.timers.tick(ms)
  await drain()
  await drain()
}

const names = (n: number) => Array.from({ length: n }, (_, i) => `C${i}`)
const allOf = (sent: { symbol: string[] }[]) =>
  new Set(sent.flatMap((s) => s.symbol))

test('§3.1 a reconnect resubscribes every symbol in paced batches, not one message per stored flush', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    // main-app's requests trickle in: 12 flush windows of 3 symbols each.
    const f = harness(names(36))
    for (let w = 0; w < 12; w++) {
      for (const s of names(36).slice(w * 3, w * 3 + 3)) await f.request(s)
      await tick(500)
    }
    assert.equal(f.sent.length, 12, 'one message per flush window')

    f.sent.length = 0
    await f.reconnect()
    // The moment of reconnect is what Kraken rate-limits: at most one message.
    assert.ok(
      f.sent.length <= 1,
      `reconnect burst sent ${f.sent.length} subscribe messages at once`,
    )
    for (let i = 0; i < 4; i++) await tick(500)
    assert.equal(f.sent.length, 1, '36 symbols fit in one chunk')
    assert.deepEqual(
      allOf(f.sent),
      new Set(names(36).map((s) => `${s}/USD`)),
      'every symbol is resubscribed',
    )
    assert.ok(f.sent.every((s) => s.interval === 60))

    // A second reconnect replays the same set again — still one message, so
    // the client's own topic cache is not accumulating stale flushes.
    f.sent.length = 0
    await f.reconnect()
    for (let i = 0; i < 4; i++) await tick(500)
    assert.equal(f.sent.length, 1)
    assert.equal(f.sent[0].symbol.length, 36)
  } finally {
    mock.timers.reset()
  }
})

test('§3.2 a rate-limit rejection of a replayed batch is tracked, not silently lost', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const f = harness(names(4))
    for (const s of names(2)) await f.request(s)
    await tick(500)
    for (const s of names(4).slice(2)) await f.request(s)
    await tick(500)
    const client = f.clients[0]
    // Both initial batches acked.
    for (const s of names(4)) {
      client.emit('response', {
        method: 'subscribe',
        success: true,
        result: { symbol: `${s}/USD` },
      })
    }
    await f.reconnect()
    await tick(500)
    f.sent.length = 0
    // Kraken refuses the replayed batch.
    client.emit('exception', {
      error: 'Exceeded msg rate',
      method: 'subscribe',
      req_id: 1,
      success: false,
      wsKey,
    })
    // Either dropped for main-app to re-request, or re-sent — never neither.
    await tick(10_000)
    await tick(500)
    const resent = allOf(f.sent)
    for (const s of names(4)) {
      const room = `${s}@kraken@1hCandle`
      assert.ok(
        !f.rooms().has(room) || resent.has(`${s}/USD`),
        `${s} is still "subscribed" but was neither dropped nor re-sent`,
      )
    }
  } finally {
    mock.timers.reset()
  }
})

test('§3.3 "Exceeded msg rate" with nothing pending re-queues the unacked symbols after a backoff', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  try {
    const f = harness(names(3))
    for (const s of names(3)) await f.request(s)
    await tick(500)
    const client = f.clients[0]
    // C0 acked; C1/C2 acks never come and the batch is no longer pending
    // (e.g. a send the client replayed on its own).
    client.emit('response', {
      method: 'subscribe',
      success: true,
      result: { symbol: 'C0/USD' },
    })
    f.self.krakenSpotCandleClients[0].pending.length = 0
    f.sent.length = 0
    client.emit('exception', {
      error: 'Exceeded msg rate',
      method: 'subscribe',
      req_id: 9,
      success: false,
      wsKey,
    })
    client.emit('exception', {
      error: 'Exceeded msg rate',
      method: 'subscribe',
      req_id: 10,
      success: false,
      wsKey,
    })
    await tick(500)
    assert.equal(f.sent.length, 0, 'backs off before retrying')
    await tick(10_000)
    await tick(500) // the flush window the retry queued into
    assert.equal(
      f.sent.length,
      1,
      'repeated rejections coalesce into one retry',
    )
    assert.deepEqual(f.sent[0].symbol.sort(), ['C1/USD', 'C2/USD'])
  } finally {
    mock.timers.reset()
  }
})
