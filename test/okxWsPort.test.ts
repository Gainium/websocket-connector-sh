/**
 * OKX stops accepting WebSocket connections on port 8443 after 31 Oct 2026.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Nothing here opens a socket. The assertion is on the URL okx-api resolves
 * for every ws key once `utils/okxWsPort` is loaded: that is the string each
 * OKX client (user stream without a `wsUrl`, price and candle sockets) dials.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { getWsUrlForWsKey, WS_KEY_MAP } from 'okx-api/lib/util/websocket-util'
import {
  OKX_EEA_PRIVATE_WS_URL,
  OKX_US_PRIVATE_WS_URL,
  stripOkxWsPort,
} from '../src/utils/okxWsPort'

const noopLogger = {
  silly: () => null,
  debug: () => null,
  notice: () => null,
  info: () => null,
  warning: () => null,
  error: () => null,
} as any

test('every okx-api ws key resolves to a URL without port 8443', () => {
  for (const wsKey of Object.values(WS_KEY_MAP)) {
    const url = getWsUrlForWsKey(wsKey as any, {} as any, noopLogger)
    assert.ok(url.startsWith('wss://'), `${wsKey}: ${url}`)
    assert.ok(!url.includes(':8443'), `${wsKey}: ${url}`)
  }
})

test('host, path and query are kept', () => {
  assert.equal(
    getWsUrlForWsKey('prodPrivate' as any, {} as any, noopLogger),
    'wss://ws.okx.com/ws/v5/private',
  )
  assert.equal(
    getWsUrlForWsKey('businessDemoPublic' as any, {} as any, noopLogger),
    'wss://wspap.okx.com/ws/v5/business?brokerId=9999',
  )
  assert.equal(
    stripOkxWsPort('wss://wseea.okx.com:8443/ws/v5/private'),
    OKX_EEA_PRIVATE_WS_URL,
  )
  assert.equal(
    stripOkxWsPort('wss://wsus.okx.com:8443/ws/v5/private'),
    OKX_US_PRIVATE_WS_URL,
  )
})
