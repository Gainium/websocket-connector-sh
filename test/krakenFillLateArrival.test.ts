/**
 * Kraken futures `fills` feed: fills delivered AFTER the fill that closed the
 * order (`remaining_order_qty: 0`) must still be in the FILLED report.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * The feed reorders an order's fills, sometimes by seconds. main-app books a
 * deal's close on the FIRST FILLED of its take-profit and treats any later one
 * as already processed, so the stream accumulator alone reported FILLED for
 * whatever had arrived by then: 19 of a 59 XAG close, 0.015 of 0.027 ETH. The
 * connector now reads the order's fills from REST before reporting it FILLED
 * (utils/krakenFillSettle).
 *
 * Every sequence below is the real prod delivery order, verbatim from the
 * user-stream log (fields the mapper does not read dropped). A capped
 * reduce-only close — one fill, remaining 0, smaller than the size placed —
 * must stay at its partial size: that is what the venue executed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'
import { ExchangeEnum } from '../src/utils/common'
import {
  KrakenRestFill,
  krakenQty,
  mergeKrakenRestFills,
} from '../src/utils/krakenFillSettle'

type Fill = {
  instrument: string
  time: number
  price: number
  buy: boolean
  qty: number
  remaining_order_qty: number
  order_id: string
  cli_ord_id: string
  fill_id: string
  order_type: string
  seq: number
}

const base = (
  instrument: string,
  time: number,
  buy: boolean,
  order_id: string,
  cli_ord_id: string,
) => ({ instrument, time, buy, order_id, cli_ord_id, order_type: 'market' })

/** [qty, remaining_order_qty, price, fill_id, seq] in DELIVERY order. */
type Row = [number, number, number, string, number]
const sequence = (b: ReturnType<typeof base>, rows: Row[]): Fill[] =>
  rows.map(([qty, remaining_order_qty, price, fill_id, seq]) => ({
    ...b,
    qty,
    remaining_order_qty,
    price,
    fill_id,
    seq,
  }))

const CASES: {
  name: string
  expected: number
  storedBefore: number
  fills: Fill[]
}[] = [
  {
    name: 'XAG D-TP-DoMi14gIJ6yhBJpxLZeUFR6XMKzuwn',
    expected: 59,
    storedBefore: 19,
    fills: sequence(
      base(
        'PF_XAGUSD',
        1793347202332,
        true,
        'a31a9e4b-973e-4a86-9d6f-93baf1bd4ddd',
        'D-TP-DoMi14gIJ6yhBJpxLZeUFR6XMKzuwn',
      ),
      [
        [19, 0, 50.6888, 'f4975029-7b8c-4f9f-bc57-75874a6f04fd', 126],
        [29.9, 29.1, 50.6598, '095d8ceb-f2b9-4255-9b76-a3e0c811cceb', 122],
        [0.2, 28.9, 50.6599, '755ec3bd-9db6-48cd-943a-6a56fc3ec36d', 123],
        [0.1, 28.8, 50.66, '85130385-b09d-4ea3-996b-62b13130ed8e', 124],
        [9.8, 19, 50.6713, 'c8840533-341b-4863-9346-d6e7b667771d', 125],
      ],
    ),
  },
  {
    name: 'ETH D-TP-DfrVakrz6D7MBqNu9bcL504efrIc2q',
    expected: 0.027,
    storedBefore: 0.015,
    // Two connections relayed this order: each fill arrives twice.
    fills: sequence(
      base(
        'PF_ETHUSD',
        1793318406706,
        true,
        'a319f2a8-fbe5-454c-9f2b-615f1e0df409',
        'D-TP-DfrVakrz6D7MBqNu9bcL504efrIc2q',
      ),
      [
        [0.015, 0, 2248.2, '4ad395b1-b3dd-4813-a16b-3c20596d11a3', 104],
        [0.012, 0.015, 2248.1, 'f0d6349c-55d3-4690-9e2e-755114eb2671', 103],
        [0.015, 0, 2248.2, '4ad395b1-b3dd-4813-a16b-3c20596d11a3', 103],
        [0.012, 0.015, 2248.1, 'f0d6349c-55d3-4690-9e2e-755114eb2671', 102],
      ],
    ),
  },
  {
    name: 'BTC D-TP-idRV00wlc7RGhmr0GIGQgZrRmRSzh2',
    expected: 0.0296,
    storedBefore: 0.0291,
    fills: sequence(
      base(
        'PF_XBTUSD',
        1793318409536,
        true,
        'a319f2ad-4d24-4a55-afd9-e3a4ad3fba06',
        'D-TP-idRV00wlc7RGhmr0GIGQgZrRmRSzh2',
      ),
      [
        [0.0291, 0, 77848, '08a5e331-66ab-4c82-a6ec-7dd2b05d9091', 103],
        [0.0002, 0.0291, 77847, '6d78fa21-37cf-4ae6-b6ed-cbce7704ec75', 102],
        [0.0002, 0.0294, 77834, 'bf0ed739-433a-4c5d-bd6c-449b89e6dd1e', 100],
        [0.0001, 0.0293, 77834, '3eb91dfa-c5ac-4518-be87-1c1d773305d8', 101],
      ],
    ),
  },
  {
    name: 'XAUT D-TP-HZoB5Kc0lz9SLjd4BpU1o557J2XJxo',
    expected: 0.977,
    storedBefore: 0.976,
    fills: sequence(
      base(
        'PF_XAUTUSD',
        1793347202100,
        true,
        'a31a9e4b-4492-474f-a609-9acb862b5aa3',
        'D-TP-HZoB5Kc0lz9SLjd4BpU1o557J2XJxo',
      ),
      [
        [0.643, 0.333, 3979.6, 'eb7e2403-b4c5-4b3c-883f-2b273747ade9', 120],
        [0.333, 0, 3979.7, 'd07e09ac-0817-410c-81cd-45a3aaafb5fb', 121],
        [0.001, 0.976, 3974.7, '16df3803-ca8a-4601-b668-e5d6675e35dc', 119],
      ],
    ),
  },
  {
    name: 'BTC D-TP-aao3t5AgHB9eBCUTriWBSNiH4UsLAJ',
    expected: 0.0305,
    storedBefore: 0.030399999999999996,
    fills: sequence(
      base(
        'PF_XBTUSD',
        1793685602018,
        true,
        'a3227f50-9061-40d7-b55a-856d86f80cd7',
        'D-TP-aao3t5AgHB9eBCUTriWBSNiH4UsLAJ',
      ),
      [
        [0.0214, 0.0087, 76548, 'aa05e141-4a8a-4aa0-8942-24915cb9bc71', 103],
        [0.0002, 0.0301, 76547, 'fbb0eca6-333a-4662-b90a-8355c68ab9ef', 102],
        [0.0001, 0.0304, 76543, 'd9c8ed6b-9a02-46a0-8d0b-1b3cf5ca14f1', 100],
        [0.0087, 0, 76548, '33cbe4aa-7935-449f-b038-b060080afbe8', 104],
        [0.0001, 0.0303, 76547, '2bb9cc33-366d-448e-bb0f-a626df333b58', 101],
      ],
    ),
  },
]

/** Reduce-only close Kraken capped to a nearly flat shared position. */
const CAPPED = sequence(
  base(
    'PF_XBTUSD',
    1793505995050,
    false,
    'a31e50c6-14a8-488a-9265-0f3867b55c7d',
    'D-TP-KeM1eyTgcs4DkpqBvWZwzSdeV5z7q7',
  ),
  [[0.0002, 0, 77635, '06a65455-e5be-4d22-b16f-84c1205e4e83', 100]],
)

function connector() {
  const uc = new UserConnector(true) as any
  uc.getKrakenMaps = async () => ({ wsnameToNormalized: new Map() })
  return uc
}

/**
 * The accumulator is module-level, as in production; each test gets its own
 * order/fill id namespace so they cannot see each other's totals.
 */
const ns = (id: string, fills: Fill[]): Fill[] =>
  fills.map((f) => ({
    ...f,
    order_id: `${id}-${f.order_id}`,
    fill_id: `${id}-${f.fill_id}`,
  }))

/** What `GET /fills` returns for these fills. */
const asRest = (fills: Fill[]): KrakenRestFill[] => {
  const seen = new Map<string, KrakenRestFill>()
  for (const f of fills) {
    seen.set(f.fill_id, {
      fill_id: f.fill_id,
      order_id: f.order_id,
      size: f.qty,
      price: f.price,
    })
  }
  return [...seen.values()]
}

/** Deliver each fill as its own WS message, in the order given. */
async function replay(
  uc: any,
  fills: Fill[],
  settle?: (orderId: string) => Promise<KrakenRestFill[] | null>,
) {
  const reports: any[] = []
  for (const fill of fills) {
    reports.push(
      ...(await uc.prepareKrakenOrderMsg(
        { feed: 'fills', fills: [fill] },
        'fills',
        ExchangeEnum.krakenUsdm,
        settle,
      )),
    )
  }
  return reports
}

for (const c of CASES) {
  test(`${c.name}: FILLED carries every fill, not ${c.storedBefore}`, async () => {
    const fills = ns(`late-${c.name}`, c.fills)
    const rest = asRest(fills)
    const calls: string[] = []
    const reports = await replay(connector(), fills, async (orderId) => {
      calls.push(orderId)
      return rest
    })

    const filled = reports.filter((r) => r.orderStatus === 'FILLED')
    assert.equal(filled.length, 1, 'FILLED is reported exactly once')
    assert.equal(+filled[0].totalTradeQuantity, c.expected)
    // Exactly the decimal string — not 0.030399999999999996.
    assert.equal(filled[0].totalTradeQuantity, `${c.expected}`)
    assert.equal(+filled[0].quantity, c.expected)
    // Nothing after it: a late fill's stale remaining must not reopen it.
    assert.equal(reports[reports.length - 1], filled[0])
    // Cumulative notional is the sum over every fill, so quote/base is VWAP.
    const cost = rest.reduce((a, f) => a + +f.size * +f.price, 0)
    assert.ok(Math.abs(+filled[0].totalQuoteTradeQuantity - cost) < 1e-6)
    assert.equal(calls.length, 1, 'one REST lookup per order')
  })
}

test('fills that land while the REST lookup is out are counted, not emitted', async () => {
  // REST has nothing yet; the stream delivers the late XAG fills while the
  // lookup for the remaining-0 fill is still out.
  const uc = connector()
  const [closing, ...late] = ns('during-settle', CASES[0].fills)
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const pending = replay(uc, [closing], async () => {
    await gate
    return []
  })
  const lateReports = await replay(uc, late)
  release()
  const [report, ...rest] = await pending

  assert.deepEqual(lateReports, [])
  assert.deepEqual(rest, [])
  assert.equal(report.orderStatus, 'FILLED')
  assert.equal(report.totalTradeQuantity, '59')
})

test('capped reduce-only close stays at the size Kraken executed', async () => {
  const fills = ns('capped', CAPPED)
  const reports = await replay(connector(), fills, async () => asRest(fills))
  assert.equal(reports.length, 1)
  assert.equal(reports[0].orderStatus, 'FILLED')
  assert.equal(reports[0].totalTradeQuantity, '0.0002')
  assert.equal(reports[0].quantity, '0.0002')
})

test('capped close with REST unavailable also stays at 0.0002', async () => {
  const fills = ns('capped-no-rest', CAPPED)
  const [report] = await replay(connector(), fills, async () => null)
  assert.equal(report.orderStatus, 'FILLED')
  assert.equal(report.totalTradeQuantity, '0.0002')
})

test('REST failure falls back to the stream total and still reports once', async () => {
  const fills = ns('no-rest', CASES[1].fills)
  const reports = await replay(connector(), fills, async () => null)
  const filled = reports.filter((r) => r.orderStatus === 'FILLED')
  assert.equal(filled.length, 1)
  assert.equal(filled[0].totalTradeQuantity, '0.015')
  assert.equal(reports.length, 1)
})

test('mergeKrakenRestFills ignores other orders and fills already counted', () => {
  const totals = { qty: 1, cost: 10, fillIds: new Set(['a']) }
  const added = mergeKrakenRestFills(totals, 'o1', [
    { fill_id: 'a', order_id: 'o1', size: 1, price: 10 },
    { fill_id: 'b', order_id: 'o1', size: '2', price: '11' },
    { fill_id: 'c', order_id: 'o2', size: 5, price: 10 },
  ])
  assert.equal(added, 1)
  assert.equal(totals.qty, 3)
  assert.equal(totals.cost, 32)
})

test('krakenQty strips float noise from a fill-size sum', () => {
  assert.equal(krakenQty(0.0001 + 0.0001 + 0.0002 + 0.0214 + 0.0087), 0.0305)
  assert.equal(krakenQty(0.030399999999999996), 0.0304)
  assert.equal(krakenQty(59), 59)
})
