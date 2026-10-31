/**
 * Spec 020 — a Hyperliquid cancel whose `sz` shrank without a fill must not be
 * relayed as partly filled. The executed quantity of a non-filled terminal
 * update comes from Hyperliquid's own fill history, not from `origSz − sz`.
 *
 * The cancel frame below is the production one from the spec's §2 evidence
 * (reduce-only HYPE perp SELL, sz 1.02 → 0.97, fills:[]).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'
import HyperliquidSymbolMap from '../src/utils/hyperliquidSymbols'
import { fetchHyperliquidOrderFills } from '../src/utils/hyperliquidFillPark'
import { ExchangeEnum } from '../src/utils/common'
import logger from '../src/utils/logger'

// prepareHyperliquidOrder waits for spotMeta once; keep the tests offline.
const symbols = HyperliquidSymbolMap.getInstance() as any
symbols.hasSpotTokens = () => true
symbols.ensureSpotTokens = async () => undefined

const OID = 566139172745
const CLOID = '0x074c03a35a085f183e49d7fd92b1410b'
const PLACED = 1791230157981
const CANCELED = 1791338391279

const cancelFrame = (over: Record<string, unknown> = {}) => ({
  order: {
    coin: 'HYPE',
    side: 'A',
    limitPx: '96.175',
    sz: '0.97',
    oid: OID,
    timestamp: PLACED,
    origSz: '1.02',
    reduceOnly: true,
    cloid: CLOID,
    ...over,
  },
  status: 'canceled',
  statusTimestamp: CANCELED,
})

const fill = (over: Record<string, unknown> = {}) => ({
  coin: 'HYPE',
  px: '96.2',
  sz: '0.03',
  side: 'A',
  time: PLACED + 1000,
  oid: OID,
  tid: 1,
  fee: '0.0013',
  feeToken: 'USDC',
  cloid: CLOID,
  ...over,
})

const ctx = {
  roomId: 'room',
  user: '0xabc',
  exchange: ExchangeEnum.hyperliquidLinear,
  key: '0xabc',
}

type Page = { startTime: number; endTime: number; user: string }

const connector = (pages: (p: Page) => Promise<unknown[]>) => {
  const uc = new UserConnector(true) as any
  const calls: Page[] = []
  const logs: string[] = []
  uc.hlFetchFillsPage = (user: string, startTime: number, endTime: number) => {
    calls.push({ user, startTime, endTime })
    return pages({ user, startTime, endTime })
  }
  ;(logger as any).warn = (msg: string) => logs.push(msg)
  return { uc, calls, logs }
}

test('§4.1 cancel with shrunk sz and no fill in HL history → 0 executed, no fee', async () => {
  // HL's real answer for this window: two fills, neither for this oid.
  const { uc, calls } = connector(async () => [
    fill({ oid: 565056346750, tid: 10, sz: '1.08' }),
    fill({ oid: 566211066756, tid: 11, sz: '5.36' }),
  ])
  const [report] = await uc.prepareHyperliquidOrder([cancelFrame()], ctx)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].user, '0xabc')
  assert.equal(calls[0].startTime, PLACED)
  assert.ok(calls[0].endTime >= CANCELED)
  assert.equal(report.orderStatus, 'CANCELED')
  assert.equal(+report.totalTradeQuantity, 0)
  assert.equal(+report.totalQuoteTradeQuantity, 0)
  assert.equal(report.feePaid, undefined)
})

test('§4.2 cancel with fills in HL history → their sum, price and fee (perp)', async () => {
  const { uc } = connector(async () => [
    fill({ tid: 1, sz: '0.02', px: '96.1', fee: '0.001' }),
    fill({ oid: 1, tid: 2, sz: '9' }),
    fill({ tid: 3, sz: '0.03', px: '96.2', fee: '0.002' }),
  ])
  const [report] = await uc.prepareHyperliquidOrder([cancelFrame()], ctx)
  assert.equal(report.orderStatus, 'CANCELED')
  assert.equal(+report.totalTradeQuantity, 0.05)
  assert.ok(
    Math.abs(+report.totalQuoteTradeQuantity - (0.02 * 96.1 + 0.03 * 96.2)) <
      1e-9,
  )
  assert.equal(+report.feePaid, 0.003)
  assert.equal(report.feeAsset, 'USDC')
})

test('§4.2 spot coin (@N) is matched by oid the same way', async () => {
  const { uc } = connector(async () => [fill({ coin: '@107', sz: '0.01' })])
  const [report] = await uc.prepareHyperliquidOrder(
    [cancelFrame({ coin: '@107' })],
    { ...ctx, exchange: ExchangeEnum.hyperliquid },
  )
  assert.equal(+report.totalTradeQuantity, 0.01)
})

// A failed lookup defers the report; the retries run on the instance's own
// delay, zeroed here so the tests don't wait out the real backoff.
const deferred = (pages: (p: Page) => Promise<unknown[]>) => {
  const c = connector(pages)
  const emitted: { roomId: string; event: any }[] = []
  const errors: string[] = []
  c.uc.hlHistoryRetryDelayMs = 0
  c.uc.userStreamEvent = (roomId: string, event: any) =>
    emitted.push({ roomId, event })
  ;(logger as any).error = (msg: string) => errors.push(msg)
  return { ...c, emitted, errors }
}

const settle = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) {
    await new Promise((r) => setTimeout(r, 1))
  }
}

test('§4.3 history lookup fails → no report yet; a later successful lookup decides the quantity', async () => {
  let n = 0
  const { uc, calls, emitted, logs } = deferred(async () => {
    if (++n < 3) throw new Error('timeout')
    return [fill({ oid: 565056346750, tid: 10, sz: '1.08' })]
  })
  const out = await uc.prepareHyperliquidOrder([cancelFrame()], ctx)
  assert.equal(out.length, 0, 'origSz − sz must not be reported inline')
  await settle(() => emitted.length > 0)
  assert.equal(calls.length, 3)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].roomId, 'room')
  assert.equal(emitted[0].event.orderStatus, 'CANCELED')
  assert.equal(+emitted[0].event.totalTradeQuantity, 0)
  assert.equal(emitted[0].event.feePaid, undefined)
  assert.ok(logs.some((l) => l.includes(CLOID) && l.includes(`${OID}`)))
})

test('§4.3 a deferred cancel does not hold back the rest of the batch', async () => {
  const { uc, emitted } = deferred(async () => {
    throw new Error('timeout')
  })
  const other = cancelFrame({ cloid: '0x01', oid: 1, sz: '1.02' })
  const out = await uc.prepareHyperliquidOrder([cancelFrame(), other], ctx)
  assert.equal(out.length, 1)
  assert.equal(out[0].orderStatus, 'CANCELED')
  await settle(() => emitted.length > 0)
})

test('§4.3 every lookup fails → origSz − sz reported once, error names cloid, oid and attempts', async () => {
  const { uc, calls, emitted, errors } = deferred(async () => {
    throw new Error('timeout')
  })
  const out = await uc.prepareHyperliquidOrder([cancelFrame()], ctx)
  assert.equal(out.length, 0)
  await settle(() => emitted.length > 0)
  const attempts = 1 + uc.hlHistoryRetries
  assert.equal(calls.length, attempts)
  assert.equal(emitted.length, 1)
  assert.ok(Math.abs(+emitted[0].event.totalTradeQuantity - 0.05) < 1e-9)
  assert.ok(
    errors.some(
      (l) =>
        l.includes(CLOID) &&
        l.includes(`${OID}`) &&
        l.includes(`${attempts} attempt`),
    ),
  )
})

test('§4.3 the same cancel replayed while deferred is reported once', async () => {
  const { uc, emitted } = deferred(async () => {
    throw new Error('timeout')
  })
  await uc.prepareHyperliquidOrder([cancelFrame()], ctx)
  await uc.prepareHyperliquidOrder([cancelFrame()], ctx)
  await settle(() => emitted.length > 0)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(emitted.length, 1)
})

test('§4.4 no history request when sz did not shrink, for open, or with buffered fills', async () => {
  const { uc, calls } = connector(async () => [])
  const [unshrunk] = await uc.prepareHyperliquidOrder(
    [cancelFrame({ sz: '1.02' })],
    ctx,
  )
  assert.equal(+unshrunk.totalTradeQuantity, 0)
  const [open] = await uc.prepareHyperliquidOrder(
    [{ ...cancelFrame(), status: 'open' }],
    ctx,
  )
  assert.equal(open.orderStatus, 'PARTIALLY_FILLED')
  assert.equal(calls.length, 0)
})

test('§4.5 pages forward on a full page, de-duplicates by tid, filters by oid', async () => {
  const seen: number[] = []
  const pages: Record<number, unknown[]> = {
    100: [
      { oid: 7, tid: 1, time: 100, sz: '1' },
      { oid: 8, tid: 2, time: 150, sz: '1' },
      { oid: 7, tid: 3, time: 200, sz: '1' },
    ],
    200: [
      { oid: 7, tid: 3, time: 200, sz: '1' },
      { oid: 7, tid: 4, time: 250, sz: '1' },
    ],
  }
  const out = await fetchHyperliquidOrderFills(
    async (start) => {
      seen.push(start)
      return pages[start] as any
    },
    { oid: 7, startTime: 100, endTime: 300, pageSize: 3 },
  )
  assert.deepEqual(seen, [100, 200])
  assert.deepEqual(
    out.map((f) => f.tid),
    [1, 3, 4],
  )
})

test('§4.3/§4.5 more pages than the cap → throws (caller retries the lookup)', async () => {
  let t = 0
  await assert.rejects(
    fetchHyperliquidOrderFills(
      async () => {
        t += 10
        return [
          { oid: 7, tid: t, time: t, sz: '1' },
          { oid: 7, tid: t + 1, time: t + 1, sz: '1' },
        ]
      },
      { oid: 7, startTime: 0, endTime: 1e9, pageSize: 2, maxPages: 3 },
    ),
  )
})
