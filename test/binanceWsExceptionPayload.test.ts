/**
 * Regression coverage for spec 012 — the Binance `exception` handler logs an
 * empty payload, so nothing says why a Binance socket faulted.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * The first test drives the REAL vendor `WebsocketClient` (`binance@3.6.3`)
 * against a local HTTP server that answers 404 to the upgrade — the same
 * condition the venue produced — and hands the SDK's own `exception` payload to
 * the REAL `binanceErrorCb`. Nothing about the payload is hand-built: the shape
 * under test is exactly what `BaseWSClient.parseWsError` emits (spec §2.1).
 *
 * `stopBinance`/`init` are stubbed because the restart they perform is a
 * separate defect and is not what this spec changes (spec §5).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { WebsocketClient, WS_KEY_MAP } from 'binance'
import { ExchangeEnum } from '../src/utils/common'
import logger from '../src/utils/logger'
import BinanceConnector from '../src/price/binance'

type AnyConnector = any

const silentWsLogger = {
  silly: () => undefined,
  debug: () => undefined,
  notice: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  trace: () => undefined,
}

/**
 * A connector off the prototype (no constructor ⇒ no Redis/worker port) whose
 * restart is a counter and whose `logger.error` output is captured.
 */
function buildConnector(): {
  c: AnyConnector
  lines: string[]
  restarts: () => number
  restore: () => void
} {
  const c: AnyConnector = Object.create(BinanceConnector.prototype)
  let restarts = 0
  c.stopBinance = () => {
    restarts++
  }
  c.init = () => {
    restarts++
  }

  const lines: string[] = []
  const prevError = logger.error
  logger.error = ((...msg: unknown[]) => {
    lines.push(msg.map((m) => `${m}`).join(' '))
  }) as never

  return {
    c,
    lines,
    restarts: () => restarts,
    restore: () => {
      logger.error = prevError
    },
  }
}

/** Resolve with the SDK's own `exception` payload for a 404 upgrade. */
function realSdkExceptionPayload(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end('not found')
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('no port'))
        return
      }
      const url = `ws://127.0.0.1:${address.port}/ws`
      const client = new WebsocketClient(
        { wsUrl: url, reconnectTimeout: 60_000, beautify: false } as never,
        silentWsLogger as never,
      )
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        client.removeAllListeners()
        client.on('exception', () => null)
        try {
          client.closeAll(false)
        } catch {
          /* the socket never opened */
        }
        server.close()
        fn()
      }
      client.on('exception', (data: unknown) =>
        finish(() => resolve(data as unknown)),
      )
      setTimeout(
        () => finish(() => reject(new Error('no exception raised'))),
        15_000,
      ).unref()
      // `connectToWsUrl` is private on the SDK client; `src/price/binance.ts`
      // dials it the same way.
      //@ts-expect-error private
      void client.connectToWsUrl(url, WS_KEY_MAP.main)
    })
  })
}

test('spec 012 §2.1 — a real SDK exception logs why the socket faulted', async () => {
  const payload = await realSdkExceptionPayload()
  const { c, lines, restarts, restore } = buildConnector()
  try {
    c.binanceErrorCb(ExchangeEnum.binance)(payload)
  } finally {
    restore()
  }

  assert.equal(lines.length, 1)
  const line = lines[0]

  // §3.1 — the prefix and the single-line shape are the log contract every
  // existing grep and the /findings collectors match on.
  assert.ok(line.startsWith('BINANCE error: main '), `prefix changed: ${line}`)
  assert.equal(line.includes('\n'), false, `line is not single-line: ${line}`)

  // §2.1 — the whole defect: the reason was dropped, leaving `{"wsKey":"main"}`.
  assert.ok(
    line.includes('Unexpected server response: 404'),
    `payload carries no reason: ${line}`,
  )

  // §5 — the restart behaviour is untouched by this change.
  assert.equal(restarts(), 2)
})

test('spec 012 §2.2 — an `exception` carrying a plain Error still reports it', () => {
  const { c, lines, restore } = buildConnector()
  try {
    // The shape the SDK's other `exception` sites emit, e.g.
    // `websocket-client.js` `subscribeIsolatedMarginUserDataStream()`.
    c.binanceErrorCb(ExchangeEnum.binanceUsdm)({
      wsKey: 'usdm',
      functionRef: 'subscribeUsdFuturesUserDataStream()',
      error: new Error('listenKey request failed'),
    })
  } finally {
    restore()
  }

  const line = lines[0]
  assert.ok(line.startsWith('BINANCEUSDM error: usdm '), line)
  assert.ok(line.includes('listenKey request failed'), line)
  assert.ok(line.includes('subscribeUsdFuturesUserDataStream()'), line)
})

test('spec 012 §3.2 — credentials are never serialized into the error line', () => {
  const { c, lines, restore } = buildConnector()
  try {
    c.binanceErrorCb(ExchangeEnum.binance)({
      wsKey: 'main',
      message: 'auth frame rejected',
      requestParams: { apiKey: 'REAL_KEY_VALUE', secret: 'REAL_SECRET_VALUE' },
    })
  } finally {
    restore()
  }

  const line = lines[0]
  assert.ok(line.includes('auth frame rejected'), line)
  assert.equal(line.includes('REAL_KEY_VALUE'), false, line)
  assert.equal(line.includes('REAL_SECRET_VALUE'), false, line)
})
