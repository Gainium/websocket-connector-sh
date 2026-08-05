/**
 * Regression coverage for the user-stream auth-rejection breaker's log
 * hygiene (bug #289).
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Two defects, both of which show up as error-log volume rather than as user
 * impact — the breaker itself was already correct:
 *
 *   1. The post-cooldown self-heal retry was a FLAT 30min. A key that is
 *      permanently revoked (or simply lacks Kraken's "WebSocket interface"
 *      permission) therefore reproduced its rejection + circuit-broken pair
 *      48x a day, forever, per account. Across ~20 accounts that was the
 *      largest single source of error lines in the service log. The retry now
 *      escalates 30min → 1h → 2h → … → 24h, so a dead key converges to one
 *      cycle a day (~95% fewer lines) while a key fixed in place still
 *      self-heals.
 *   2. The retry timer was untracked, so tearing a room down could not cancel
 *      it. A circuit-broken room has already had its subscriber count and
 *      user entry deleted by the breaker, so an unsubscribe for it hit the
 *      "has no subscribers" branch and did nothing — and 30min later the
 *      orphan timer reopened a stream for a credential the user had deleted.
 *
 * No live WS or REST is touched: every test drives the real methods against a
 * fake `this` holding just the maps they use.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'

const MIN = 60 * 1000
const HOUR = 60 * MIN

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms))

/**
 * Fake `this` carrying only the state the breaker helpers touch, with the
 * real methods borrowed off the prototype.
 */
function makeHarness() {
  const proto = UserConnector.prototype as any
  const opened: Array<{ msg: any; uuid: any }> = []
  const logs: string[] = []

  const fake: any = {
    // state
    authCooldownUntil: new Map<string, number>(),
    authCooldownSkipsSuppressed: new Map<string, number>(),
    authCooldownStrikes: new Map<string, number>(),
    authLastRejectAt: new Map<string, number>(),
    authRetryTimers: new Map<string, NodeJS.Timeout>(),
    subscribeMsgsMap: new Map<string, any>(),
    subscribersMap: new Map<string, number>(),
    users: [] as any[],
    // leaves
    logger: (m: any) => {
      logs.push(String(m))
    },
    openStreamCallback: (msg: any, uuid: any) => {
      opened.push({ msg, uuid })
    },
    removeAccountFromWatchlist: () => undefined,
    onAfterCloseStream: () => undefined,
    // real implementations under test
    authCooldownMs: proto.authCooldownMs,
    armAuthCooldown: proto.armAuthCooldown,
    scheduleAuthSelfHeal: proto.scheduleAuthSelfHeal,
    clearAuthRetryTimer: proto.clearAuthRetryTimer,
    forgetSubscription: proto.forgetSubscription,
    releaseAuthCooldownLogLatch: proto.releaseAuthCooldownLogLatch,
    closeStreamCallback: proto.closeStreamCallback,
  }

  return { fake, opened, logs }
}

test('cooldown ladder doubles from 30min and caps at 24h', () => {
  const { fake } = makeHarness()

  assert.equal(fake.authCooldownMs(0), 30 * MIN)
  assert.equal(fake.authCooldownMs(1), 1 * HOUR)
  assert.equal(fake.authCooldownMs(2), 2 * HOUR)
  assert.equal(fake.authCooldownMs(3), 4 * HOUR)
  assert.equal(fake.authCooldownMs(4), 8 * HOUR)
  assert.equal(fake.authCooldownMs(5), 16 * HOUR)
  // 32h would exceed the cap.
  assert.equal(fake.authCooldownMs(6), 24 * HOUR)
  // And it stays there without overflowing to Infinity/NaN.
  assert.equal(fake.authCooldownMs(50), 24 * HOUR)
  assert.equal(fake.authCooldownMs(5000), 24 * HOUR)
})

test('a permanently rejected key escalates instead of retrying every 30min', () => {
  const { fake } = makeHarness()
  const id = 'room-dead-key'

  // Each retry comes straight back rejected, i.e. the next rejection lands
  // right after the cooldown it was scheduled for.
  let now = 1_000_000
  const earned: number[] = []
  for (let i = 0; i < 8; i++) {
    const { cooldownMs, strikes } = fake.armAuthCooldown(id, 'user-1', now)
    assert.equal(strikes, i + 1, `strike count at cycle ${i}`)
    earned.push(cooldownMs)
    now += cooldownMs + 5_000 // retry fires, rejects ~immediately
  }

  assert.deepEqual(earned, [
    30 * MIN,
    1 * HOUR,
    2 * HOUR,
    4 * HOUR,
    8 * HOUR,
    16 * HOUR,
    24 * HOUR,
    24 * HOUR,
  ])

  // Volume check: the whole point of the change. Over 7 days a flat 30min
  // retry burns 336 cycles; the ladder must be an order of magnitude fewer.
  const week = 7 * 24 * HOUR
  let t = 0
  let cycles = 0
  const sim = makeHarness().fake
  while (t < week) {
    t += sim.armAuthCooldown('sim', 'user-1', t).cooldownMs
    cycles++
  }
  assert.ok(cycles <= 12, `expected <=12 cycles/week, got ${cycles}`)
})

test('a rejection long after the last one restarts the ladder at 30min', () => {
  const { fake } = makeHarness()
  const id = 'room-later-revoked'

  const first = fake.armAuthCooldown(id, 'user-1', 1_000_000)
  assert.equal(first.cooldownMs, 30 * MIN)
  const second = fake.armAuthCooldown(
    id,
    'user-1',
    1_000_000 + 30 * MIN + 5_000,
  )
  assert.equal(second.cooldownMs, 1 * HOUR, 'consecutive rejection escalates')

  // Now the key works for a week and is revoked again: that is a new fault,
  // not strike 3 — it must not inherit the 2h step.
  const later = fake.armAuthCooldown(
    id,
    'user-1',
    1_000_000 + 30 * MIN + 5_000 + 7 * 24 * HOUR,
  )
  assert.equal(later.cooldownMs, 30 * MIN)
  assert.equal(later.strikes, 1)
})

test('the self-heal retry reopens the room once per subscriber', async () => {
  const { fake, opened } = makeHarness()
  const id = 'room-self-heal'
  const msg = { userId: 'user-1' }

  fake.authCooldownUntil.set(id, Date.now() + 10)
  fake.scheduleAuthSelfHeal(id, 2, msg, id, 20)

  await sleep(80)
  assert.equal(opened.length, 2, 'reopened once per subscriber')
  assert.equal(opened[0].uuid, id)
  assert.equal(fake.authCooldownUntil.has(id), false, 'gate cleared on retry')
  assert.equal(fake.authRetryTimers.has(id), false, 'timer entry cleaned up')
})

test('closing a circuit-broken room cancels its pending self-heal retry', async () => {
  const { fake, opened } = makeHarness()
  const id = 'room-deleted-connection'
  const msg = { userId: 'user-1' }

  // Reproduce the state the breaker leaves behind: subscriber count and user
  // entry already deleted, subscribe payload retained, retry pending.
  fake.subscribeMsgsMap.set(id, msg)
  fake.armAuthCooldown(id, 'user-1')
  fake.scheduleAuthSelfHeal(id, 1, msg, id, 20)

  // The user deletes the connection; main-app sends "close stream".
  fake.closeStreamCallback(id)

  await sleep(80)
  assert.equal(opened.length, 0, 'must not resurrect a removed connection')
  assert.equal(fake.authRetryTimers.has(id), false)
  assert.equal(fake.subscribeMsgsMap.has(id), false)
  // The gate itself survives: the room is still circuit-broken, and callers
  // re-request it several times a minute.
  assert.ok((fake.authCooldownUntil.get(id) ?? 0) > Date.now())
  assert.ok(fake.authCooldownStrikes.has(id))
})

test('the last unsubscribe drops the subscribe payload and breaker state', () => {
  const { fake } = makeHarness()
  const id = 'room-normal'
  const msg = { userId: 'user-1' }

  fake.subscribeMsgsMap.set(id, msg)
  fake.subscribersMap.set(id, 1)
  fake.users.push({ id, close: () => undefined, provider: 'binance' })

  fake.closeStreamCallback(id)

  assert.equal(fake.subscribeMsgsMap.has(id), false)
  assert.equal(fake.users.length, 0)
  assert.equal(fake.authCooldownUntil.has(id), false)
  assert.equal(fake.authCooldownStrikes.has(id), false)
})

test('a remaining subscriber keeps the room and its payload', () => {
  const { fake } = makeHarness()
  const id = 'room-shared'
  const msg = { userId: 'user-1' }

  fake.subscribeMsgsMap.set(id, msg)
  fake.subscribersMap.set(id, 2)
  fake.users.push({ id, close: () => undefined, provider: 'binance' })

  fake.closeStreamCallback(id)

  assert.equal(fake.subscribersMap.get(id), 1)
  assert.equal(fake.subscribeMsgsMap.get(id), msg, 'payload still needed')
  assert.equal(fake.users.length, 1)
})
