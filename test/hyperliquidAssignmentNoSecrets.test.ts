/**
 * Coverage for websocket-connector spec 002 — the Hyperliquid balancer keeps
 * only routing state in Redis and asks main-app to re-send an open when an
 * account has to move, instead of storing and replaying the open message.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Drives the real `HyperliquidBalancer` with fake Redis and Rabbit clients
 * and two workers.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import HyperliquidBalancer from '../src/utils/hyperliquidBalancer'
import { purgeLegacyHlAssignments } from '../src/scripts/purgeLegacyHlAssignments'

// Read by the balancer's field initialisers, i.e. at construction time.
process.env.USER_STREAM_HL_WORKERS = 'w1,w2'

const KEY = 'WALLET-ADDRESS-0xabc'
const SECRET = 'SIGNING-KEY-0xdeadbeef'
const LEGACY = 'userStream:assignment:'

type Sent = { queue: string; payload: any }

function makeHarness() {
  const kv = new Map<string, string>()
  const reads: string[] = []
  const sent: Sent[] = []
  const published: { channel: string; msg: any }[] = []
  const workers: Record<string, { cap: number; held: Set<string> }> = {
    w1: { cap: 10, held: new Set() },
    w2: { cap: 10, held: new Set() },
  }
  const workerOf = (queue: string) => queue.split(':').at(-1)!
  const accept = (queue: string, payload: any) => {
    const w = workers[workerOf(queue)]
    if (payload.event === 'close stream') {
      w.held.delete(payload.uuid)
      return { accepted: true }
    }
    if (payload.event !== 'open stream') return { accepted: true }
    if (!w.held.has(payload.uuid) && w.held.size >= w.cap) {
      return { accepted: false, reason: 'cap' }
    }
    w.held.add(payload.uuid)
    return { accepted: true }
  }
  const b: any = new (HyperliquidBalancer as any)()
  b.initRedis = async () => {}
  b.startWatchdog = () => {}
  const liveUsers = (k: string) => {
    const m = /^userStream:worker:(w\d):users$/.exec(k)
    return m && kv.has(k) ? JSON.stringify([...workers[m[1]].held]) : null
  }
  b.redisSet = {
    get: async (k: string) => {
      reads.push(k)
      return liveUsers(k) ?? kv.get(k) ?? null
    },
    set: async (k: string, v: string) => {
      kv.set(k, v)
    },
    del: async (k: string) => {
      kv.delete(k)
    },
    publish: async (channel: string, msg: string) => {
      published.push({ channel, msg: JSON.parse(msg) })
    },
    instance: {
      scan: async (_cursor: string, opts: { MATCH: string }) => ({
        cursor: 0,
        keys: [...kv.keys()].filter((k) =>
          k.startsWith(opts.MATCH.replace(/\*$/, '')),
        ),
      }),
      mGet: async (keys: string[]) => {
        reads.push(...keys)
        return keys.map((k) => kv.get(k) ?? null)
      },
    },
  }
  b.rabbit = {
    sendWithCallback: async (queue: string, payload: any) => {
      sent.push({ queue, payload })
      return { response: accept(queue, payload) }
    },
    send: async (queue: string, payload: any) => {
      sent.push({ queue, payload })
      accept(queue, payload)
    },
  }
  const publishWorker = (id: string, boot: string) => {
    kv.set(`userStream:worker:${id}:hb`, '1')
    kv.set(`userStream:worker:${id}:boot`, boot)
    kv.set(`userStream:worker:${id}:cap`, `${workers[id].cap}`)
    kv.set(`userStream:worker:${id}:users`, '[]')
  }
  const killWorker = (id: string) => {
    kv.delete(`userStream:worker:${id}:hb`)
    kv.delete(`userStream:worker:${id}:users`)
    workers[id].held.clear()
  }
  const open = (uuid: string) => ({
    event: 'open stream',
    data: {
      userId: `user-${uuid}`,
      api: {
        provider: 'hyperliquid',
        key: KEY,
        secret: SECRET,
        passphrase: '',
      },
    },
    uuid,
  })
  const opensSent = () => sent.filter((s) => s.payload.event === 'open stream')
  const reopens = () =>
    published.filter(
      (p) => p.channel === 'serviceLog' && p.msg?.reopen === 'userStream',
    )
  return {
    b,
    kv,
    reads,
    sent,
    workers,
    publishWorker,
    killWorker,
    open,
    opensSent,
    reopens,
  }
}

async function boot(h: ReturnType<typeof makeHarness>) {
  h.publishWorker('w1', 'boot-1')
  h.publishWorker('w2', 'boot-1')
  await h.b.init()
  await h.b.tick() // baseline boot epochs
}

test('§4.1 a routed open leaves no credential in Redis, only the worker id', async () => {
  const h = makeHarness()
  await boot(h)
  await h.b.route(h.open('acct'))

  assert.equal(h.b.has('acct'), true)
  const target = [...Object.entries(h.workers)].find(([, w]) =>
    w.held.has('acct'),
  )![0]
  assert.equal(h.kv.get('userStream:hlAssign:acct'), target)
  for (const [k, v] of h.kv) {
    assert.ok(!k.startsWith(LEGACY), `legacy key written: ${k}`)
    for (const s of [KEY, SECRET, 'user-acct']) {
      assert.ok(!v.includes(s), `${k} holds open-payload data`)
    }
  }
})

test('§4.2 a dead worker’s accounts are re-requested from main-app, not replayed', async () => {
  const h = makeHarness()
  await boot(h)
  await h.b.route(h.open('acct'))
  const from = h.workers.w1.held.has('acct') ? 'w1' : 'w2'
  const to = from === 'w1' ? 'w2' : 'w1'
  const opensBefore = h.opensSent().length

  h.killWorker(from)
  await h.b.tick()

  assert.equal(h.opensSent().length, opensBefore, 'balancer sent no open')
  assert.deepEqual(
    h.reopens().map((p) => p.msg.uuids),
    [['acct']],
    'one reopen request naming the account',
  )
  assert.equal(h.b.has('acct'), false)
  assert.equal(h.kv.has('userStream:hlAssign:acct'), false)

  // main-app's bots answer with fresh opens through the normal path.
  await h.b.route(h.open('acct'))
  assert.equal(h.workers[to].held.has('acct'), true)
  assert.equal(h.kv.get('userStream:hlAssign:acct'), to)
})

test('§4.2/§1.1c with no live worker left, the re-sent open is parked and retried', async () => {
  const h = makeHarness()
  await boot(h)
  await h.b.route(h.open('acct'))
  h.killWorker('w1')
  h.killWorker('w2')
  await h.b.tick()
  assert.equal(h.reopens().length, 1)

  await h.b.route(h.open('acct'))
  assert.equal(h.b.has('acct'), false, 'no worker: parked, not assigned')

  h.publishWorker('w2', 'boot-2')
  await h.b.tick()
  assert.equal(h.workers.w2.held.has('acct'), true, 'retried once w2 is back')
})

test('§4.3 a restarted worker gets no replayed open from the balancer', async () => {
  const h = makeHarness()
  await boot(h)
  await h.b.route(h.open('acct'))
  const on = h.workers.w1.held.has('acct') ? 'w1' : 'w2'
  const opensBefore = h.opensSent().length

  h.workers[on].held.clear()
  h.publishWorker(on, 'boot-2')
  await h.b.tick()

  assert.equal(h.opensSent().length, opensBefore)
  assert.equal(h.reopens().length, 0, 'the worker’s boot broadcast covers it')
})

test('§4.4 boot seeds routing from worker reports and never reads legacy values', async () => {
  const h = makeHarness()
  h.kv.set(
    `${LEGACY}acct`,
    JSON.stringify({ workerId: 'w2', openPayload: h.open('acct') }),
  )
  h.publishWorker('w1', 'boot-1')
  h.publishWorker('w2', 'boot-1')
  h.workers.w2.held.add('acct')

  await h.b.init()

  assert.ok(
    !h.reads.some((k) => k.startsWith(LEGACY)),
    'legacy assignment value was read',
  )
  assert.equal(h.b.has('acct'), true)
  assert.equal(h.kv.get('userStream:hlAssign:acct'), 'w2')
  assert.ok(
    h.kv.has(`${LEGACY}acct`),
    'balancer does not delete; the script does',
  )

  // A re-sent open goes back to the worker that already holds it.
  await h.b.route(h.open('acct'))
  assert.equal(h.workers.w1.held.has('acct'), false)
  await h.b.route({ event: 'close stream', uuid: 'acct' })
  assert.equal(h.workers.w2.held.has('acct'), false, 'close reached w2')
})

test('§4.6 the cleanup deletes legacy keys by name only and reports counts', async () => {
  const kv = new Map<string, string>([
    [`${LEGACY}a`, 'secret-a'],
    [`${LEGACY}b`, 'secret-b'],
    ['userStream:hlAssign:a', 'w1'],
    ['userStream:worker:w1:hb', '1'],
  ])
  const calls: string[] = []
  const client = {
    scan: async (_c: string, opts: { MATCH: string; COUNT: number }) => {
      calls.push('scan')
      const p = opts.MATCH.replace(/\*$/, '')
      return { cursor: 0, keys: [...kv.keys()].filter((k) => k.startsWith(p)) }
    },
    unlink: async (keys: string[]) => {
      calls.push('unlink')
      keys.forEach((k) => kv.delete(k))
      return keys.length
    },
  }

  const dry = await purgeLegacyHlAssignments(client, { apply: false })
  assert.deepEqual(dry, { matched: 2, deleted: 0 })
  assert.equal(kv.size, 4)

  const run = await purgeLegacyHlAssignments(client, { apply: true })
  assert.deepEqual(run, { matched: 2, deleted: 2 })
  assert.deepEqual([...kv.keys()].sort(), [
    'userStream:hlAssign:a',
    'userStream:worker:w1:hb',
  ])
  assert.ok(calls.every((c) => c === 'scan' || c === 'unlink'))
})
