/**
 * Coverage for the user-stream flap detector's burst debounce.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * The SDK's routine periodic reconnect occasionally stutters through 3-4
 * quick retries inside a few seconds and then holds. Counting each retry
 * reached the 4-in-10min threshold and raised a "connected but dead" alert
 * for a stream that was healthy. Retries inside one burst now count once;
 * a sustained storm still alerts because a new burst opens every `burstMs`.
 *
 * Drives the real `noteReconnect` against a fake `this`, with a fake clock.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'

const SEC = 1000
const MIN = 60 * SEC

function makeHarness() {
  const published: any[] = []
  const fake: any = {
    streamFlaps: new Map<string, number[]>(),
    binanceAuthErrors: new Map<string, number[]>(),
    authCooldownUntil: new Map<string, number>(),
    redis: {
      publish: (_ch: string, msg: string) => {
        published.push(JSON.parse(msg))
      },
    },
    noteReconnect: (UserConnector.prototype as any).noteReconnect,
  }
  return { fake, published }
}

function withClock(fn: (at: (ms: number) => void) => void) {
  const realNow = Date.now
  let t = 1_000_000_000_000
  try {
    fn((ms) => {
      t = 1_000_000_000_000 + ms
      Date.now = () => t
    })
  } finally {
    Date.now = realNow
  }
}

test('a 4-retry stutter inside a few seconds does not alert', () => {
  const { fake, published } = makeHarness()
  withClock((at) => {
    for (const ms of [0, 1 * SEC, 2 * SEC, 3 * SEC]) {
      at(ms)
      fake.noteReconnect('room', 'binanceCoinm')
    }
  })
  assert.equal(published.length, 0)
})

test('routine stutters an hour apart never accumulate', () => {
  const { fake, published } = makeHarness()
  withClock((at) => {
    for (let cycle = 0; cycle < 6; cycle++) {
      for (const s of [0, 1, 2, 3]) {
        at(cycle * 50 * MIN + s * SEC)
        fake.noteReconnect('room', 'binanceCoinm')
      }
    }
  })
  assert.equal(published.length, 0)
})

test('4 separate reconnects inside the window still alert', () => {
  const { fake, published } = makeHarness()
  withClock((at) => {
    for (const ms of [0, 2 * MIN, 4 * MIN, 6 * MIN]) {
      at(ms)
      fake.noteReconnect('room', 'binanceCoinm')
    }
  })
  assert.equal(published.length, 1)
  assert.equal(published[0].userStreamFlap.reconnects, 4)
})

test('a sustained reconnect storm still alerts', () => {
  const { fake, published } = makeHarness()
  withClock((at) => {
    // a reconnect every 5s for 3 minutes
    for (let ms = 0; ms <= 3 * MIN; ms += 5 * SEC) {
      at(ms)
      fake.noteReconnect('room', 'binanceCoinm')
    }
  })
  assert.ok(published.length >= 1)
})
