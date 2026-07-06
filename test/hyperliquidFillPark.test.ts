/**
 * Unit coverage for the HL two-channel fill park-and-retry resolver.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * The resolver is generic over order/fill/event, so these tests use tiny local
 * shapes and injected timers/deps — no live HL WS or REST is touched. `buildEvent`
 * simply echoes the fills it was priced with, so each test can assert WHICH fills
 * a resolution used (buffer real px, REST real px, or `[]` = limitPx last resort).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HyperliquidFillParkResolver,
  ingestUserFills,
} from '../src/utils/hyperliquidFillPark'
import { ExchangeEnum } from '../../core/src/utils/common'
import { CommonOrder } from '../../core/type'

type Order = { id: string }
type Fill = { cloid?: string; px: string; sz: string }
type Event = { cloid: string; fills: Fill[] }

const flush = () => new Promise((res) => setImmediate(res))

interface Harness {
  resolver: HyperliquidFillParkResolver<Order, Fill, Event>
  buffer: Map<string, Fill[]>
  emitted: Array<{ roomId: string; event: Event }>
  fireTimers: () => void
  restCalls: string[]
  bufferDeps: {
    appendFill: (cloid: string, fill: Fill) => void
    isParked: (cloid: string) => boolean
    notifyFillArrived: (cloid: string) => void
  }
}

function makeHarness(opts?: {
  restLookup?: (cloid: string) => Promise<CommonOrder | null>
  graceMs?: number
  maxSize?: number
}): Harness {
  const buffer = new Map<string, Fill[]>()
  const emitted: Array<{ roomId: string; event: Event }> = []
  const restCalls: string[] = []

  // Deterministic fake timers: capture callbacks, fire on demand.
  let seq = 1
  let timers: Array<{ id: number; fn: () => void }> = []
  const setTimer = (fn: () => void) => {
    const id = seq++
    timers.push({ id, fn })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  const clearTimer = (h: ReturnType<typeof setTimeout>) => {
    timers = timers.filter((t) => t.id !== (h as unknown as number))
  }
  const fireTimers = () => {
    const pending = timers
    timers = []
    for (const t of pending) t.fn()
  }

  const resolver = new HyperliquidFillParkResolver<Order, Fill, Event>({
    graceMs: opts?.graceMs ?? 5000,
    maxSize: opts?.maxSize ?? 5000,
    getBufferedFills: (cloid) => buffer.get(cloid),
    clearBufferedFills: (cloid) => {
      buffer.delete(cloid)
    },
    restLookup: async (ctx) => {
      restCalls.push(ctx.cloid)
      return opts?.restLookup ? opts.restLookup(ctx.cloid) : null
    },
    buildEvent: (order, fills) => ({ cloid: order.id, fills }),
    buildEventFromCommonOrder: (order, _commonOrder) => ({
      cloid: order.id,
      fills: [],
    }),
    emit: (roomId, event) => emitted.push({ roomId, event }),
    log: () => {},
    setTimer,
    clearTimer,
  })

  const bufferDeps = {
    appendFill: (cloid: string, fill: Fill) => {
      const arr = buffer.get(cloid) ?? []
      arr.push(fill)
      buffer.set(cloid, arr)
    },
    isParked: (cloid: string) => resolver.has(cloid),
    notifyFillArrived: (cloid: string) => resolver.notifyFillArrived(cloid),
  }

  return { resolver, buffer, emitted, fireTimers, restCalls, bufferDeps }
}

function park(h: Harness, cloid: string) {
  h.resolver.park({
    cloid,
    roomId: `room-${cloid}`,
    oid: 1,
    user: '0xuser',
    statusTimestamp: 1000,
    order: { id: cloid },
    key: '',
    exchange: ExchangeEnum.hyperliquid,
  })
}

test('fill-after-park: resolves from buffer with the real fill price, no REST', async () => {
  const h = makeHarness()
  park(h, 'X')
  assert.equal(h.resolver.size, 1)

  // Fills land on userFills while parked → immediate resolve with real px.
  ingestUserFills(
    { isSnapshot: false, fills: [{ cloid: 'X', px: '100', sz: '2' }] },
    h.bufferDeps,
  )
  await flush()

  assert.equal(h.emitted.length, 1)
  assert.equal(h.emitted[0].roomId, 'room-X')
  assert.deepEqual(h.emitted[0].event.fills, [
    { cloid: 'X', px: '100', sz: '2' },
  ])
  assert.equal(
    h.restCalls.length,
    0,
    'REST must not be called when fills arrive',
  )
  assert.equal(h.resolver.size, 0, 'entry cleared after resolve')
  assert.equal(h.buffer.has('X'), false, 'consumed fills removed from buffer')
})

test('grace → REST fallback: no buffered fill, grace expires, REST supplies real fills', async () => {
  const h = makeHarness({
    restLookup: async () => ({
      symbol: '',
      clientOrderId: 'Y',
      price: '50',
      executedQty: '1',
      orderId: '1',
      updateTime: Date.now(),
      origQty: '1',
      status: 'FILLED',
      type: 'MARKET',
      side: 'BUY',
    }),
  })
  park(h, 'Y')
  h.fireTimers() // grace window elapses
  await flush()

  assert.equal(h.restCalls.length, 1)
  assert.equal(h.emitted.length, 1)
  assert.deepEqual(h.emitted[0].event.fills, [
    { cloid: 'Y', px: '50', sz: '1' },
  ])
  assert.equal(h.resolver.size, 0)
})

test('REST fails → limitPx last resort (empty fills passed to buildEvent)', async () => {
  const h = makeHarness({
    restLookup: async () => {
      throw new Error('HL 500')
    },
  })
  park(h, 'Z')

  h.fireTimers()
  await flush()

  assert.equal(h.restCalls.length, 1)
  assert.equal(h.emitted.length, 1)
  assert.deepEqual(
    h.emitted[0].event.fills,
    [],
    'empty fills => builder prices at limitPx',
  )
  assert.equal(h.resolver.size, 0)
})

test('REST returns no fills → limitPx last resort', async () => {
  const h = makeHarness({ restLookup: async () => null })
  park(h, 'E')

  h.fireTimers()
  await flush()

  assert.equal(h.emitted.length, 1)
  assert.deepEqual(h.emitted[0].event.fills, [])
})

test('snapshot fill matches a parked update (and is gated to parked cloids)', async () => {
  const h = makeHarness()
  park(h, 'W')

  // Reconnect snapshot: one fill for the parked cloid W, one for an unrelated
  // cloid OTHER that has no parked order.
  ingestUserFills(
    {
      isSnapshot: true,
      fills: [
        { cloid: 'W', px: '10', sz: '3' },
        { cloid: 'OTHER', px: '1', sz: '1' },
      ],
    },
    h.bufferDeps,
  )
  await flush()

  // W resolves from the snapshot fill with its real price.
  assert.equal(h.emitted.length, 1)
  assert.equal(h.emitted[0].roomId, 'room-W')
  assert.deepEqual(h.emitted[0].event.fills, [
    { cloid: 'W', px: '10', sz: '3' },
  ])
  assert.equal(h.restCalls.length, 0)
  // Unrelated snapshot fill must NOT pollute the buffer (why snapshots were skipped).
  assert.equal(h.buffer.has('OTHER'), false)
  assert.equal(h.resolver.size, 0)
})

test('ingestUserFills buffers live fills for not-yet-parked cloids (fills-before-orderUpdates)', () => {
  const h = makeHarness()
  ingestUserFills(
    { isSnapshot: false, fills: [{ cloid: 'LIVE', px: '2', sz: '2' }] },
    h.bufferDeps,
  )
  // Buffered for the later FILLED orderUpdate; nothing emitted yet.
  assert.deepEqual(h.buffer.get('LIVE'), [{ cloid: 'LIVE', px: '2', sz: '2' }])
  assert.equal(h.emitted.length, 0)
})

test('size cap force-resolves the oldest parked order', async () => {
  const h = makeHarness({ maxSize: 1, restLookup: async () => null })
  park(h, 'A')
  park(h, 'B') // overflow → A force-resolved via REST(empty) → limitPx
  await flush()

  assert.equal(h.resolver.size, 1, 'only newest remains parked')
  assert.equal(h.resolver.has('B'), true)
  assert.equal(h.emitted.length, 1)
  assert.equal(h.emitted[0].roomId, 'room-A', 'oldest (A) was the one resolved')
})
