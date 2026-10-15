/**
 * Coverage for spec 019 — a Hyperliquid open that every worker refused is
 * retried by the balancer instead of being dropped for good.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Drives the real `HyperliquidBalancer` (`route` → `routeOpen`, `tick`) with
 * fake Redis and Rabbit clients. The fake worker refuses with `reason: 'cap'`
 * while it is full, the way the worker's pre-check does.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import HyperliquidBalancer from '../src/utils/hyperliquidBalancer'

// Read by the balancer's field initialisers, i.e. at construction time.
process.env.USER_STREAM_HL_WORKERS = 'w1'

type Sent = { queue: string; payload: any; rpc: boolean }

function makeHarness() {
  const kv = new Map<string, string>()
  const sent: Sent[] = []
  const worker = { cap: 10, held: new Set<string>() }
  const accept = (payload: any) => {
    if (payload.event !== 'open stream') return { accepted: true }
    if (!worker.held.has(payload.uuid) && worker.held.size >= worker.cap) {
      return { accepted: false, reason: 'cap', workerId: 'w1' }
    }
    worker.held.add(payload.uuid)
    return { accepted: true, workerId: 'w1' }
  }
  const b: any = new (HyperliquidBalancer as any)()
  b.initPromise = Promise.resolve()
  b.redisSet = {
    // The worker republishes its user list every heartbeat; read it live.
    get: async (k: string) =>
      k === 'userStream:worker:w1:users' && kv.has(k)
        ? JSON.stringify([...worker.held])
        : (kv.get(k) ?? null),
    set: async (k: string, v: string) => {
      kv.set(k, v)
    },
    del: async (k: string) => {
      kv.delete(k)
    },
  }
  b.rabbit = {
    sendWithCallback: async (queue: string, payload: any) => {
      sent.push({ queue, payload, rpc: true })
      return { response: accept(payload) }
    },
    send: async (queue: string, payload: any) => {
      sent.push({ queue, payload, rpc: false })
      accept(payload)
    },
  }
  const publishWorker = (boot: string) => {
    kv.set('userStream:worker:w1:hb', '1')
    kv.set('userStream:worker:w1:boot', boot)
    kv.set('userStream:worker:w1:cap', `${worker.cap}`)
    kv.set('userStream:worker:w1:users', JSON.stringify([...worker.held]))
  }
  const open = (uuid: string) => ({
    event: 'open stream',
    data: { api: { provider: 'hyperliquid' }, userId: `u-${uuid}` },
    uuid,
  })
  const opensFor = (uuid: string) =>
    sent.filter(
      (s) => s.payload.event === 'open stream' && s.payload.uuid === uuid,
    )
  return { b, kv, sent, worker, publishWorker, open, opensFor }
}

/** Fill the worker to its cap with unrelated accounts. */
async function fillWorker(h: ReturnType<typeof makeHarness>) {
  for (let i = 0; i < h.worker.cap; i++) {
    assert.equal(await h.b.route(h.open(`filler-${i}`)), true)
  }
}

test('§2.1 an open refused at cap is routed once a restarted worker has room', async () => {
  const h = makeHarness()
  h.publishWorker('boot-1')
  await h.b.tick() // balancer learns the worker (baseline boot)
  await fillWorker(h)

  await h.b.route(h.open('acct'))
  assert.equal(h.b.has('acct'), false, 'refused open is not an assignment')
  assert.equal(h.worker.held.has('acct'), false)

  // The worker restarts with its full IP pool: cap 10 → 60, users lost.
  h.worker.cap = 60
  h.worker.held.clear()
  h.publishWorker('boot-2')
  await h.b.tick()
  await h.b.tick()

  assert.equal(h.b.has('acct'), true, 'refused open was retried and routed')
  assert.equal(h.worker.held.has('acct'), true, 'worker now holds the stream')
})

test('§2.1 an open refused at cap is routed once the cap rises without a restart', async () => {
  const h = makeHarness()
  h.publishWorker('boot-1')
  await h.b.tick()
  await fillWorker(h)
  await h.b.route(h.open('acct'))
  assert.equal(h.b.has('acct'), false)

  // Late IPs: the same worker publishes a higher cap, same boot epoch.
  h.worker.cap = 60
  h.publishWorker('boot-1')
  await h.b.tick()

  assert.equal(h.b.has('acct'), true)
  assert.equal(h.worker.held.has('acct'), true)
})

test('§2.2 while there is still no room, a tick spends at most one refused attempt', async () => {
  const h = makeHarness()
  h.publishWorker('boot-1')
  await h.b.tick()
  await fillWorker(h)
  for (const id of ['a', 'b', 'c', 'd']) await h.b.route(h.open(id))
  const before = h.sent.filter((s) => s.rpc).length

  h.publishWorker('boot-1')
  await h.b.tick()

  const attempts = h.sent.filter((s) => s.rpc).length - before
  assert.ok(
    attempts <= 1,
    `expected ≤1 refused attempt per tick, got ${attempts}`,
  )
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(h.b.has(id), false)
})

test('§2.3 a close for a refused open cancels its retry', async () => {
  const h = makeHarness()
  h.publishWorker('boot-1')
  await h.b.tick()
  await fillWorker(h)
  await h.b.route(h.open('acct'))

  assert.equal(await h.b.route({ event: 'close stream', uuid: 'acct' }), false)

  h.worker.cap = 60
  h.publishWorker('boot-1')
  await h.b.tick()
  assert.equal(h.b.has('acct'), false, 'closed account must not be reopened')
  assert.equal(h.worker.held.has('acct'), false)
})

test('§2.4 a later open for the same account replaces the parked payload', async () => {
  const h = makeHarness()
  h.publishWorker('boot-1')
  await h.b.tick()
  await fillWorker(h)
  await h.b.route(h.open('acct'))
  const rotated = h.open('acct')
  rotated.data.userId = 'rotated-key'
  await h.b.route(rotated)

  h.worker.cap = 60
  h.publishWorker('boot-1')
  await h.b.tick()
  const last = h.opensFor('acct').at(-1)!
  assert.equal(last.payload.data.userId, 'rotated-key')
  assert.equal(h.b.has('acct'), true)
})

test('§2.1/§2.2 a worker-side cap refusal (balancer view stale) is parked and retried', async () => {
  const h = makeHarness()
  // Worker is full with streams the balancer does not know about, and has
  // not published a user list yet — the balancer believes it has room.
  for (let i = 0; i < 10; i++) h.worker.held.add(`unknown-${i}`)
  h.kv.set('userStream:worker:w1:hb', '1')
  h.kv.set('userStream:worker:w1:boot', 'boot-1')
  h.kv.set('userStream:worker:w1:cap', '10')
  await h.b.tick()

  for (const id of ['a', 'b', 'c']) await h.b.route(h.open(id))
  for (const id of ['a', 'b', 'c']) {
    assert.equal(h.opensFor(id).length, 1, `${id} was refused by the worker`)
    assert.equal(h.b.has(id), false)
  }
  const rpcBefore = h.sent.filter((s) => s.rpc).length
  await h.b.tick()
  assert.ok(h.sent.filter((s) => s.rpc).length - rpcBefore <= 1)

  h.worker.cap = 60
  h.kv.set('userStream:worker:w1:cap', '60')
  await h.b.tick()
  for (const id of ['a', 'b', 'c']) assert.equal(h.b.has(id), true, id)
})
