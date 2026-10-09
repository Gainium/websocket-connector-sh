/**
 * One silent Bitget socket among several live ones.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Bitget spot is spread over several v2 sockets of up to 900 subscriptions.
 * The exchange-wide watchdog reads one timestamp for the whole exchange, so a
 * socket that stays open but delivers nothing after a reconnect was never
 * noticed while its peers kept the timestamp fresh. Nothing here opens a
 * socket: the connector methods run against a fake `this`, and the WS client
 * against a fake socket.
 */

import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import BitgetConnector from '../src/price/bitget'
import { findSilentClients } from '../src/price/clientSilence'
import { stallOf } from '../src/price/stallEscalation'
import { WebsocketClientV2 } from '../bitget-custom/websocket-client-v2'
import { ExchangeEnum } from '../src/utils/common'

const opts = { timeout: 120_000, peerWindow: 50_000, minSubs: 25 }
const NOW = 10_000_000

const live = (id: string) => ({
  id,
  subs: 800,
  lastData: NOW - 1_000,
  since: NOW - 3_600_000,
  lastFrame: NOW - 1_000,
})

test('a socket answering pongs but delivering no data among live peers is silent', () => {
  const quiet = {
    id: 'bitgetClient#2',
    subs: 800,
    lastData: NOW - 900_000,
    since: NOW - 600_000, // reconnected 10 min ago, nothing since
    lastFrame: NOW - 5_000, // pong 5 s ago
  }
  const silent = findSilentClients(
    [
      live('bitgetClient#0'),
      live('bitgetClient#1'),
      quiet,
      live('bitgetClient#3'),
    ],
    NOW,
    opts,
  )
  assert.deepEqual(silent, [
    { id: 'bitgetClient#2', staleSeconds: 600, socketAlive: true },
  ])
})

test('a quiet market is not a dead socket: no live peer, nothing is flagged', () => {
  const quiet = (id: string) => ({
    ...live(id),
    lastData: NOW - 300_000,
    lastFrame: NOW - 5_000,
  })
  assert.deepEqual(
    findSilentClients([quiet('a'), quiet('b'), quiet('c')], NOW, opts),
    [],
  )
})

test('thin sockets and freshly reopened sockets are not judged', () => {
  const thin = { ...live('thin'), subs: 3, lastData: 0, since: 0 }
  const reopened = { ...live('reopened'), lastData: 0, since: NOW - 30_000 }
  assert.deepEqual(
    findSilentClients([live('a'), thin, reopened], NOW, opts),
    [],
  )
})

const proto = BitgetConnector.prototype as any

function fakeClient(topics: object[][] = []) {
  const subscribed: object[][] = []
  return {
    subscribed,
    lastOpenAt: NOW - 3_600_000,
    lastFrameAt: NOW - 1_000,
    getWsStore: () => ({
      getKeys: () => ['v2Public'],
      getTopics: () => new Set(topics),
    }),
    subscribe: (t: object[]) => subscribed.push(t),
  }
}

function fakeConnector(spot: ReturnType<typeof fakeClient>[]) {
  const published: any[] = []
  const created: { exchange: string; type: string; replaced: unknown }[] = []
  const self: any = {
    timeout: 50_000,
    maxTargetedRestarts: 2,
    clientRestarts: new Map(),
    clientStallReported: new Map(),
    clientStallReportInterval: 5 * 60 * 1000,
    clientActivity: new WeakMap(),
    redis: { publish: (ch: string, msg: string) => published.push([ch, msg]) },
    bitgetClient: spot.map((client, id) => ({ client, subs: 800, id })),
    bitgetClientUsdm: [],
    bitgetClientCoinm: [],
    bitgetClientCandle: [],
    bitgetClientCandleUsdm: [],
    bitgetClientCandleCoinm: [],
  }
  self.getBitgetClient = (exchange: string, type: string, current: unknown) => {
    created.push({ exchange, type, replaced: current })
    const client = fakeClient()
    self.clientActivity.set(client, { lastData: 0, createdAt: NOW })
    return client
  }
  for (const m of [
    'checkClientStalls',
    'recreateClient',
    'handleClientStall',
    'noteClientData',
    'reportStall',
  ]) {
    self[m] = proto[m].bind(self)
  }
  return { self, published, created }
}

test('only the silent spot socket is recreated, with its own subscriptions', () => {
  const topics = [[{ instType: 'SPOT', channel: 'ticker', instId: 'BNBUSDT' }]]
  const clients = [fakeClient(), fakeClient(), fakeClient(topics), fakeClient()]
  const { self, published, created } = fakeConnector(clients)
  clients.forEach((c, i) =>
    self.clientActivity.set(c, {
      lastData: i === 2 ? NOW - 900_000 : NOW - 1_000,
      createdAt: NOW - 3_600_000,
    }),
  )
  clients[2].lastOpenAt = NOW - 600_000

  self.checkClientStalls(NOW)

  assert.equal(created.length, 1)
  assert.equal(created[0].exchange, ExchangeEnum.bitget)
  assert.equal(created[0].type, 'ticker')
  assert.equal(created[0].replaced, clients[2])
  const replacement = self.bitgetClient.find((e: any) => e.id === 2)
  assert.notEqual(replacement.client, clients[2])
  assert.deepEqual(replacement.client.subscribed, [topics.flat()])
  assert.equal(replacement.subs, 800)
  // Peers are untouched.
  for (const i of [0, 1, 3]) {
    assert.equal(self.bitgetClient[i].client, clients[i])
  }
  // Reported to the watchdog alert path once.
  assert.equal(published.length, 1)
  const { exchange, kind, staleSeconds } = JSON.parse(
    published[0][1],
  ).watchdogStall
  assert.deepEqual(
    { exchange, kind, staleSeconds },
    { exchange: ExchangeEnum.bitget, kind: 'price', staleSeconds: 600 },
  )
})

test('a socket that stays silent after its recreations escalates to the regular stall', () => {
  const clients = [fakeClient(), fakeClient(), fakeClient()]
  const { self, published } = fakeConnector(clients)
  clients.forEach((c, i) =>
    self.clientActivity.set(c, {
      lastData: i === 1 ? 0 : NOW - 1_000,
      createdAt: NOW - 3_600_000,
    }),
  )
  const peersLive = (now: number) =>
    self.bitgetClient
      .filter((e: any) => e.id !== 1)
      .forEach((e: any) =>
        self.clientActivity.set(e.client, {
          lastData: now - 1_000,
          createdAt: NOW - 3_600_000,
        }),
      )

  let now = NOW
  self.checkClientStalls(now) // recreation 1
  now += 200_000
  peersLive(now)
  self.checkClientStalls(now) // recreation 2: the new socket never delivered
  now += 200_000
  peersLive(now)
  let err: Error | undefined
  try {
    self.checkClientStalls(now)
  } catch (e) {
    err = e as Error
  }
  assert.ok(err, 'third silence throws')
  assert.deepEqual(stallOf(err.message), {
    exchange: ExchangeEnum.bitget,
    kind: 'price',
  })
  // Reports are rate-limited per feed, not one per pass.
  assert.equal(published.length, 1)
})

test('data from a recreated socket restores its budget', () => {
  const clients = [fakeClient(), fakeClient()]
  const { self, created } = fakeConnector(clients)
  self.clientActivity.set(clients[0], { lastData: NOW - 1_000, createdAt: 0 })
  self.clientActivity.set(clients[1], { lastData: 0, createdAt: 0 })

  let now = NOW
  for (let round = 0; round < 4; round++) {
    self.checkClientStalls(now)
    const fresh = self.bitgetClient[1].client
    // The replacement delivers, then goes silent again later.
    self.clientActivity.get(fresh).lastData = now + 10_000
    now += 10_000
    self.checkClientStalls(now)
    now += 200_000
    self.clientActivity.set(self.bitgetClient[0].client, {
      lastData: now - 1_000,
      createdAt: 0,
    })
  }
  assert.equal(created.length, 4, 'never escalated')
})

/** A fake open socket, so the client sends without connecting. */
function openClient() {
  const sent: string[] = []
  const client = new WebsocketClientV2({ market: 'v5' } as any)
  const ws = { readyState: 1, OPEN: 1, send: (m: string) => sent.push(m) }
  client.getWsStore().setWs('v2Public', ws as any)
  return { client: client as any, sent }
}

const topicsOf = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({
    instType: 'SPOT',
    channel: 'ticker',
    instId: `${prefix}${i}USDT`,
  }))

test('subscribe spacing is per connection: one socket does not queue behind another', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const a = openClient()
    const b = openClient()
    // 3 batches of 100 on `a` — 30 s of spacing before its last batch.
    a.client.requestSubscribeTopics('v2Public', topicsOf(300, 'A'))
    b.client.requestSubscribeTopics('v2Public', topicsOf(100, 'B'))
    await new Promise((r) => setImmediate(r))
    assert.equal(a.sent.length, 1)
    assert.equal(b.sent.length, 1, 'b sent at once, not after a')
    mock.timers.tick(15_000)
    await new Promise((r) => setImmediate(r))
    assert.equal(a.sent.length, 2)
  } finally {
    mock.timers.reset()
  }
})

test('batches queued for a socket that has since reopened are dropped', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const a = openClient()
    a.client.requestSubscribeTopics('v2Public', topicsOf(300, 'A'))
    await new Promise((r) => setImmediate(r))
    assert.equal(a.sent.length, 1)
    // The socket reopens: the client resubscribes everything itself on open.
    a.client.wsGeneration.set('v2Public', 1)
    for (let i = 0; i < 3; i++) {
      mock.timers.tick(15_000)
      await new Promise((r) => setImmediate(r))
    }
    assert.equal(a.sent.length, 1, 'stale batches were not sent')
  } finally {
    mock.timers.reset()
  }
})
