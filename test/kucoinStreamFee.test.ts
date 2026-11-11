/**
 * KuCoin stream fills → venue fee read from REST (utils/kucoinFeeSettle).
 *
 * KuCoin's order topics carry no fee, so a MARKET order's FILLED report waits
 * for the REST record: spot order detail (`fee`/`feeCurrency`), futures fills.
 * Unresolvable → omitted, never 0; third-asset (KCS) fee kept as feeAsset;
 * bounded; one lookup per order across repeat FILLED reports.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createKucoinFeeSettler,
  kucoinFillsFee,
  kucoinSpotOrderFee,
} from '../src/utils/kucoinFeeSettle'

const noSleep = async () => undefined

test('spot order detail: done order yields its fee in the reported currency', () => {
  assert.deepEqual(
    kucoinSpotOrderFee({
      id: 'o1',
      isActive: false,
      dealSize: '0.01',
      fee: '0.6501',
      feeCurrency: 'USDT',
    }),
    { feePaid: '0.6501', feeAsset: 'USDT' },
  )
})

test('spot: KCS discount fee stays KCS', () => {
  assert.deepEqual(
    kucoinSpotOrderFee({ isActive: false, fee: '0.0412', feeCurrency: 'KCS' }),
    { feePaid: '0.0412', feeAsset: 'KCS' },
  )
})

test('spot: still active = retry, zero/blank = omitted (never 0)', () => {
  assert.equal(kucoinSpotOrderFee({ isActive: true, fee: '0' }), null)
  assert.equal(kucoinSpotOrderFee(null), null)
  assert.deepEqual(
    kucoinSpotOrderFee({ isActive: false, fee: '0', feeCurrency: 'USDT' }),
    {},
  )
  assert.deepEqual(
    kucoinSpotOrderFee({ isActive: false, fee: '0.1', feeCurrency: '' }),
    {},
  )
  assert.deepEqual(kucoinSpotOrderFee({ isActive: false, fee: '' }), {})
})

test('futures fills: summed per currency, deduped by tradeId', () => {
  const fee = kucoinFillsFee(
    'f1',
    {
      totalNum: 3,
      items: [
        {
          orderId: 'f1',
          tradeId: 't1',
          size: 3,
          fee: '0.012',
          feeCurrency: 'USDT',
        },
        {
          orderId: 'f1',
          tradeId: 't2',
          size: 2,
          fee: '0.008',
          feeCurrency: 'USDT',
        },
        {
          orderId: 'f1',
          tradeId: 't2',
          size: 2,
          fee: '0.008',
          feeCurrency: 'USDT',
        },
      ],
    },
    5,
  )
  assert.deepEqual(fee, { feePaid: '0.02', feeAsset: 'USDT' })
})

test('futures fills: fewer than the stream executed = retry; more pages / missing fee = omitted', () => {
  assert.equal(
    kucoinFillsFee(
      'f1',
      {
        totalNum: 1,
        items: [
          {
            orderId: 'f1',
            tradeId: 't1',
            size: 3,
            fee: '0.01',
            feeCurrency: 'USDT',
          },
        ],
      },
      5,
    ),
    null,
  )
  assert.equal(kucoinFillsFee('f1', { totalNum: 0, items: [] }, 5), null)
  assert.deepEqual(
    kucoinFillsFee(
      'f1',
      {
        totalNum: 60,
        items: [
          {
            orderId: 'f1',
            tradeId: 't1',
            size: 5,
            fee: '0.01',
            feeCurrency: 'USDT',
          },
        ],
      },
      5,
    ),
    {},
  )
  assert.deepEqual(
    kucoinFillsFee(
      'f1',
      {
        totalNum: 1,
        items: [{ orderId: 'f1', tradeId: 't1', size: 5, feeCurrency: 'USDT' }],
      },
      5,
    ),
    {},
  )
})

test('futures fills: net rebate is not a fee; two currencies → feeBreakdown', () => {
  assert.deepEqual(
    kucoinFillsFee(
      'f1',
      {
        totalNum: 1,
        items: [
          {
            orderId: 'f1',
            tradeId: 't1',
            size: 5,
            fee: '-0.01',
            feeCurrency: 'USDT',
          },
        ],
      },
      5,
    ),
    {},
  )
  assert.deepEqual(
    kucoinFillsFee(
      'f1',
      {
        totalNum: 2,
        items: [
          {
            orderId: 'f1',
            tradeId: 't1',
            size: 2,
            fee: '0.01',
            feeCurrency: 'USDT',
          },
          {
            orderId: 'f1',
            tradeId: 't2',
            size: 3,
            fee: '0.002',
            feeCurrency: 'KCS',
          },
        ],
      },
      5,
    ),
    {
      feeBreakdown: [
        { asset: 'USDT', amount: '0.01' },
        { asset: 'KCS', amount: '0.002' },
      ],
    },
  )
})

test('settler: retries until the spot order is done', async () => {
  const replies = [
    { isActive: true },
    { isActive: false, fee: '0.65', feeCurrency: 'USDT' },
  ]
  let calls = 0
  const settle = createKucoinFeeSettler({
    futures: false,
    getSpotOrder: async () => replies[calls++] ?? null,
    getFuturesFills: async () => assert.fail('spot must not read fills'),
    sleep: noSleep,
  })
  assert.deepEqual(await settle('o1', 0.01), {
    feePaid: '0.65',
    feeAsset: 'USDT',
  })
  assert.equal(calls, 2)
})

test('settler: repeat FILLED of one order shares a single lookup', async () => {
  let calls = 0
  const settle = createKucoinFeeSettler({
    futures: true,
    getSpotOrder: async () => assert.fail('futures must not read spot'),
    getFuturesFills: async () => {
      calls++
      return {
        totalNum: 1,
        items: [
          {
            orderId: 'f1',
            tradeId: 't1',
            size: 5,
            fee: '0.03',
            feeCurrency: 'USDT',
          },
        ],
      }
    },
    sleep: noSleep,
  })
  const [a, b] = await Promise.all([settle('f1', 5), settle('f1', 5)])
  const c = await settle('f1', 5)
  assert.deepEqual(a, { feePaid: '0.03', feeAsset: 'USDT' })
  assert.deepEqual(b, a)
  assert.deepEqual(c, a)
  assert.equal(calls, 1)
})

test('settler: failures, never-settling orders and throws resolve to no fee', async () => {
  const failing = createKucoinFeeSettler({
    futures: false,
    getSpotOrder: async () => null,
    getFuturesFills: async () => null,
    sleep: noSleep,
  })
  assert.deepEqual(await failing('o1', 1), {})

  const throwing = createKucoinFeeSettler({
    futures: true,
    getSpotOrder: async () => null,
    getFuturesFills: async () => {
      throw new Error('429 Too Many Requests')
    },
    sleep: noSleep,
  })
  assert.deepEqual(await throwing('f1', 1), {})
})

test('settler: a hung REST call is cut off at the timeout', async () => {
  const settle = createKucoinFeeSettler({
    futures: false,
    getSpotOrder: () => new Promise(() => undefined),
    getFuturesFills: async () => null,
    attemptDelaysMs: [0],
    timeoutMs: 50,
  })
  const started = Date.now()
  assert.deepEqual(await settle('o1', 1), {})
  assert.ok(Date.now() - started < 1000)
})
