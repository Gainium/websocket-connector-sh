/**
 * WhiteBit private stream: JSON-RPC request/response correlation + the
 * `authorize` handshake, and the order normalizer's numeric `side`.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Correlation is the one piece of plumbing this integration adds that no other
 * exchange branch in `userStream.ts` needed — every other venue's SDK owns it.
 * WhiteBit answers `authorize` with `{id, result:{status:'success'}}` on the
 * same socket that also carries unsolicited pushes and `ping` acks, so a
 * response must resolve THE pending request that carries its id and nothing
 * else. The transport is a fake EventEmitter double; no socket is opened.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'events'
import WhitebitWsClient from '../src/utils/whitebitWsClient'
import UserConnector from '../src/userStream'

class FakeSocket extends EventEmitter {
  sent: string[] = []
  closed = false

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.closed = true
    this.emit('close', 1000, '')
  }

  frames(): { id: number; method: string; params: unknown }[] {
    return this.sent.map((s) => JSON.parse(s))
  }
}

/** Answers `authorize` the way WhiteBit does, on the next tick. */
class AuthorizingSocket extends FakeSocket {
  authorizeResult: unknown = { status: 'success' }

  override send(data: string) {
    super.send(data)
    const frame = JSON.parse(data)
    if (frame.method === 'authorize') {
      setImmediate(() =>
        this.emit(
          'message',
          JSON.stringify({
            id: frame.id,
            result: this.authorizeResult,
            error: null,
          }),
        ),
      )
    }
  }
}

function connect(socket: FakeSocket, onOpen?: () => Promise<void> | void) {
  const client = new WhitebitWsClient({
    tag: 'test',
    // Ping off: the keepalive is a timer, not part of what is under test.
    pingIntervalMs: 0,
    createSocket: () => socket,
    onOpen,
  })
  return client
}

test('a response resolves the pending request carrying its id, out of order', async () => {
  const socket = new FakeSocket()
  const client = connect(socket)
  const started = client.start(1_000)
  socket.emit('open')
  await started

  const first = client.request('authorize', ['token', 'public'], 1_000)
  const second = client.request('ping', [], 1_000)
  const [firstFrame, secondFrame] = socket.frames()
  assert.notEqual(firstFrame.id, secondFrame.id, 'ids must be unique')
  assert.equal(firstFrame.method, 'authorize')
  assert.deepEqual(firstFrame.params, ['token', 'public'])

  // Answer the SECOND request first — the first must stay pending.
  socket.emit(
    'message',
    JSON.stringify({ id: secondFrame.id, result: 'pong', error: null }),
  )
  assert.equal(await second, 'pong')

  socket.emit(
    'message',
    JSON.stringify({
      id: firstFrame.id,
      result: { status: 'success' },
      error: null,
    }),
  )
  assert.deepEqual(await first, { status: 'success' })
  client.close()
})

test('a response for an unknown id resolves nothing', async () => {
  const socket = new FakeSocket()
  const client = connect(socket)
  const started = client.start(1_000)
  socket.emit('open')
  await started

  const pending = client.request('authorize', ['token', 'public'], 1_000)
  const [frame] = socket.frames()
  let settled = false
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  )

  socket.emit(
    'message',
    JSON.stringify({ id: frame.id + 999, result: 'pong', error: null }),
  )
  await new Promise((r) => setImmediate(r))
  assert.equal(settled, false, 'a foreign id must not settle our request')

  socket.emit(
    'message',
    JSON.stringify({
      id: frame.id,
      result: { status: 'success' },
      error: null,
    }),
  )
  assert.deepEqual(await pending, { status: 'success' })
  client.close()
})

test('an error response rejects the matching request', async () => {
  const socket = new FakeSocket()
  const client = connect(socket)
  const started = client.start(1_000)
  socket.emit('open')
  await started

  const pending = client.request('authorize', ['bad', 'public'], 1_000)
  const [frame] = socket.frames()
  socket.emit(
    'message',
    JSON.stringify({
      id: frame.id,
      result: null,
      error: { code: 4, message: 'Unauthorized request' },
    }),
  )
  await assert.rejects(pending, /Unauthorized request/)
  client.close()
})

test('a pending request times out instead of hanging forever', async () => {
  const socket = new FakeSocket()
  const client = connect(socket)
  const started = client.start(1_000)
  socket.emit('open')
  await started
  const rejected = assert.rejects(
    client.request('authorize', ['token', 'public'], 20),
    /timed out/,
  )
  // The request's own timer is unref'd (a pending call must never hold the
  // process open); a real socket keeps the loop alive, this stand-in does the
  // same for the test.
  await new Promise((resolve) => setTimeout(resolve, 60))
  await rejected
  client.close()
})

test('an unsolicited push (id null) is dispatched, never correlated', async () => {
  const socket = new FakeSocket()
  const pushes: { method: string; params: unknown }[] = []
  const client = new WhitebitWsClient({
    tag: 'test',
    pingIntervalMs: 0,
    createSocket: () => socket,
    onPush: (method, params) => pushes.push({ method, params }),
  })
  const started = client.start(1_000)
  socket.emit('open')
  await started

  socket.emit(
    'message',
    JSON.stringify({
      id: null,
      method: 'balanceSpot_update',
      params: [{ USDT: { available: '10', freeze: '1' } }],
    }),
  )
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0].method, 'balanceSpot_update')
  client.close()
})

test('start() completes only after the authorize handshake and subscribes', async () => {
  const socket = new AuthorizingSocket()
  const client: WhitebitWsClient = new WhitebitWsClient({
    tag: 'test',
    pingIntervalMs: 0,
    createSocket: () => socket,
    onOpen: async () => {
      const result = (await client.request('authorize', [
        'minted-token',
        'public',
      ])) as { status?: string }
      assert.equal(result.status, 'success')
      client.notify('balanceSpot_subscribe', [])
      client.notify('ordersExecuted_subscribe', [[], 0])
    },
  })
  const started = client.start(1_000)
  socket.emit('open')
  await started

  const methods = socket.frames().map((f) => f.method)
  assert.deepEqual(methods, [
    'authorize',
    'balanceSpot_subscribe',
    'ordersExecuted_subscribe',
  ])
  client.close()
})

test('a rejected authorize fails start() rather than leaving a half-open stream', async () => {
  const socket = new AuthorizingSocket()
  socket.authorizeResult = { status: 'failed' }
  const client: WhitebitWsClient = new WhitebitWsClient({
    tag: 'test',
    pingIntervalMs: 0,
    createSocket: () => socket,
    onOpen: async () => {
      const result = (await client.request('authorize', [
        'stale-token',
        'public',
      ])) as { status?: string }
      if (result.status !== 'success') {
        throw new Error('WhiteBit authorize did not succeed')
      }
    },
  })
  const started = client.start(1_000)
  socket.emit('open')
  await assert.rejects(started, /authorize did not succeed/)
  assert.equal(socket.closed, true, 'a failed handshake must close the socket')
  client.close()
})

test('ordersExecuted_update normalizes into an executionReport', () => {
  const uc = new UserConnector(true) as any
  const [report] = uc.prepareWhitebitOrderMsg([
    {
      id: 4180284,
      market: 'BTC_USDT',
      type: 'limit',
      side: 1,
      ctime: 1700000100.5,
      mtime: 1700000200.25,
      price: '35000',
      amount: '0.1',
      left: '0',
      deal_stock: '0.1',
      deal_money: '3500',
      deal_fee: '3.5',
      client_order_id: 'GRID-TP-1',
      status: 'FILLED',
    },
  ])
  assert.ok(report)
  assert.equal(report.eventType, 'executionReport')
  assert.equal(report.symbol, 'BTC_USDT')
  // 1 = sell (the opposite polarity to Kraken Futures' numeric direction).
  assert.equal(report.side, 'SELL')
  assert.equal(report.orderStatus, 'FILLED')
  assert.equal(report.orderType, 'LIMIT')
  assert.equal(report.quantity, '0.1')
  assert.equal(report.totalTradeQuantity, '0.1')
  assert.equal(report.totalQuoteTradeQuantity, '3500')
  assert.equal(report.newClientOrderId, 'GRID-TP-1')
  // Float seconds → epoch ms.
  assert.equal(report.creationTime, 1700000100500)
  assert.equal(report.orderTime, 1700000200250)
})

test('a partially filled order with side 2 maps to BUY / PARTIALLY_FILLED', () => {
  const uc = new UserConnector(true) as any
  const [report] = uc.prepareWhitebitOrderMsg([
    {
      id: 42,
      market: 'ETH_PERP',
      side: 2,
      price: '0',
      amount: '2',
      left: '1',
      deal_stock: '1',
      deal_money: '2000',
    },
  ])
  assert.equal(report.side, 'BUY')
  assert.equal(report.orderStatus, 'PARTIALLY_FILLED')
  // No limit price on a market order — the executed average is the only price.
  assert.equal(report.orderType, 'MARKET')
  assert.equal(report.price, '2000')
})

test('balanceSpot_update becomes an outboundAccountPosition', () => {
  const uc = new UserConnector(true) as any
  const out = uc.prepareWhitebitBalanceMsg(
    [{ USDT: { available: '100.5', freeze: '2.5' } }],
    1_000,
    'uuid-1',
  )
  assert.ok(out)
  assert.equal(out.eventType, 'outboundAccountPosition')
  assert.deepEqual(out.balances, [
    { asset: 'USDT', free: '100.5', locked: '2.5' },
  ])
  assert.equal(
    uc.prepareWhitebitBalanceMsg([], 1_000, 'uuid-1'),
    undefined,
    'an empty payload publishes nothing',
  )
})
