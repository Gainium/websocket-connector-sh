/**
 * Binance spot WS-API user data stream survives a transport reconnect (spec 008).
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * These drive the REAL vendor `WebsocketAPIClient`: only the socket send
 * (`sendWSAPIRequest`) is stubbed, and a reconnect is the same `reconnected`
 * event the SDK emits once a dropped connection is open again. Everything
 * between that event and the resubscribe request is the SDK's own code.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'crypto'
import {
  BINANCE_WS_API_USER_STREAM_KEY,
  createBinanceWsApiUserStream,
} from '../src/binance-custom/wsApiUserStream'

const silentLogger = {
  trace: () => {},
  info: () => {},
  error: () => {},
}

const ed25519Secret = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString()

/** The SDK's handler reads only `wsKey`; the socket fields are irrelevant here. */
const reconnectedEvent = {
  wsKey: BINANCE_WS_API_USER_STREAM_KEY,
} as never

/** A stream whose socket sends are recorded instead of written. */
function harness() {
  const sent: string[] = []
  let resubscribed = 0
  const stream = createBinanceWsApiUserStream(
    {
      api_key: 'test',
      api_secret: ed25519Secret,
      // Production keeps the SDK default (2s); the delay is not under test.
      resubscribeUserDataStreamDelaySeconds: 0,
    },
    silentLogger as never,
    () => {
      resubscribed++
    },
  )
  ;(
    stream.client as unknown as {
      sendWSAPIRequest: (wsKey: string, method: string) => Promise<object>
    }
  ).sendWSAPIRequest = async (_wsKey, method) => {
    sent.push(method)
    return {}
  }
  const reconnect = async () => {
    stream.client.emit('reconnected', reconnectedEvent)
    // The SDK queues the resubscribe on a timer; let it and its await settle.
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return {
    stream,
    sent,
    reconnect,
    resubscribed: () => resubscribed,
  }
}

test('§1.1.1 a reconnect resubscribes the user data stream', async (t) => {
  const h = harness()
  t.after(() => h.stream.stop())
  await h.stream.start()
  assert.deepEqual(h.sent, ['userDataStream.subscribe'])

  await h.reconnect()

  assert.deepEqual(h.sent, [
    'userDataStream.subscribe',
    'userDataStream.subscribe',
  ])
})

test('§1.1.1 the user stream`s own reconnected listener does not displace the SDK`s', async (t) => {
  const h = harness()
  t.after(() => h.stream.stop())
  // What userStream.ts attaches after construction.
  h.stream.client.on('reconnected', () => {})
  await h.stream.start()

  await h.reconnect()

  assert.equal(h.sent.length, 2)
})

test('§3 baseline: stripping the reconnected listeners (the old code) loses the resubscribe', async (t) => {
  const h = harness()
  t.after(() => h.stream.stop())
  h.stream.client.removeAllListeners('reconnected')
  await h.stream.start()

  await h.reconnect()

  assert.deepEqual(
    h.sent,
    ['userDataStream.subscribe'],
    'baseline changed — re-derive spec 008 §3 before trusting the rest of this file',
  )
})

test('§1.1.2 the reconcile callback fires after the resubscribe, not on the initial subscribe', async (t) => {
  const h = harness()
  t.after(() => h.stream.stop())
  await h.stream.start()
  assert.equal(h.resubscribed(), 0)

  await h.reconnect()

  assert.equal(h.resubscribed(), 1)
})

test('§1.1.3 a resubscribe queued before stop() sends nothing', async () => {
  const h = harness()
  await h.stream.start()
  h.stream.client.emit('reconnected', reconnectedEvent)
  h.stream.stop()
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(h.sent, ['userDataStream.subscribe'])
  assert.equal(h.resubscribed(), 0)
})

test('§4.1 the SDK`s console-logging listeners are not attached', (t) => {
  const h = harness()
  t.after(() => h.stream.stop())
  for (const event of ['open', 'reconnecting', 'authenticated', 'exception']) {
    assert.equal(h.stream.client.listenerCount(event), 0, event)
  }
  // …but the required reconnect/close handling is.
  assert.equal(h.stream.client.listenerCount('reconnected'), 1)
})
