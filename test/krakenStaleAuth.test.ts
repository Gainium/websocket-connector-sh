/**
 * Kraken Futures private socket: an auth promise left over from a dead socket
 * must not survive into the next connection.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * `@siebly/kraken-api` skips the reserved AUTHENTICATION_IN_PROGRESS promise
 * when a socket closes. A close that lands between the Futures challenge and
 * its answer leaves the promise pending forever; the next reconnect awaits it
 * in `assertIsAuthenticated` and never re-authenticates or resubscribes. The
 * socket stays up, so the room looks healthy while no fill ever arrives.
 * These tests use the SDK's real WsStore, so the first one fails loudly if an
 * upgrade fixes the SDK (and the workaround can then be retired).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { clearStaleKrakenAuth } from '../src/userStream'

// WsStore is not in the package's `exports` map; load the very file the
// installed client uses, next to its resolved CommonJS entry point.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WsStore } = require(
  path.join(
    path.dirname(require.resolve('@siebly/kraken-api')),
    'lib/websocket/WsStore.js',
  ),
)

const WS_KEY = 'derivativesPrivateV1'
const quietLogger = {
  trace: () => null,
  info: () => null,
  error: () => null,
}

test('SDK: closing a socket does not settle a pending auth promise', () => {
  const store = new WsStore(quietLogger as any)
  store.createAuthenticationInProgressPromise(WS_KEY as any, false)
  // What `onWsClose` does on an unintentional close.
  store.rejectAllDeferredPromises(
    WS_KEY as any,
    'connection lost, reconnecting',
  )
  assert.ok(
    store.getAuthenticationInProgressPromise(WS_KEY as any),
    'the stale auth promise survives the close (the SDK bug this works around)',
  )
})

test('clearStaleKrakenAuth drops the stale promise so the next socket re-auths', () => {
  const store = new WsStore(quietLogger as any)
  store.createAuthenticationInProgressPromise(WS_KEY as any, false)
  store.rejectAllDeferredPromises(
    WS_KEY as any,
    'connection lost, reconnecting',
  )

  assert.equal(clearStaleKrakenAuth(store as any, WS_KEY), true)
  assert.equal(
    store.getAuthenticationInProgressPromise(WS_KEY as any),
    undefined,
  )
})

test('clearStaleKrakenAuth is a no-op when nothing is pending', () => {
  const store = new WsStore(quietLogger as any)
  assert.equal(clearStaleKrakenAuth(store as any, WS_KEY), false)
})
