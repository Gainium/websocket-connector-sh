/**
 * Kraken futures `fills` feed → `ExecutionReport.liquidation`.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Kraken closes a liquidated position in chunks, each its own venue order with
 * no `cli_ord_id`, tagged by `fill_type`. Every Kraken futures fill used to go
 * out as `liquidation: false`, so main-app dropped the chunks as orders it did
 * not place: the deal stayed open on a position the venue had closed, and the
 * liquidation loss was never booked. Shapes below follow a real short closed
 * by nine 0.03 / 0.02 buy chunks; ids are synthetic.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'
import { ExchangeEnum } from '../src/utils/common'
import { isKrakenLiquidationFill } from '../src/utils/krakenOpenOrders'

const LIQ_CHUNK = {
  instrument: 'PF_ZECUSD',
  time: 1795443398015,
  price: 877.27,
  buy: true,
  qty: 0.03,
  remaining_order_qty: 0,
  order_id: 'liq-chunk-order-1',
  fill_id: 'liq-chunk-fill-1',
  fill_type: 'liquidation',
  order_type: 'liquidation',
  seq: 101,
}

function connector() {
  const uc = new UserConnector(true) as any
  uc.getKrakenMaps = async () => ({
    wsnameToNormalized: new Map([['PF_ZECUSD', 'ZEC-USD']]),
  })
  return uc
}

const emit = (uc: any, fill: unknown) =>
  uc.prepareKrakenOrderMsg({ fills: [fill] }, 'fills', ExchangeEnum.krakenUsdm)

test('a liquidation chunk is reported as a filled liquidation', async () => {
  const [report] = await emit(connector(), LIQ_CHUNK)
  assert.equal(report.liquidation, true)
  assert.equal(report.orderStatus, 'FILLED')
  assert.equal(report.side, 'BUY')
  assert.equal(report.symbol, 'ZEC-USD')
  // No cli_ord_id on a venue liquidation: the venue order id stands in.
  assert.equal(report.newClientOrderId, 'liq-chunk-order-1')
  assert.equal(+report.totalTradeQuantity, 0.03)
})

test('an ordinary fill of our own order is not a liquidation', async () => {
  const [report] = await emit(connector(), {
    ...LIQ_CHUNK,
    order_id: 'own-order-1',
    fill_id: 'own-fill-1',
    cli_ord_id: 'D-TP-ownTakeProfit',
    fill_type: 'maker',
    order_type: 'limit',
  })
  assert.equal(report.liquidation, false)
})

test('fill_type classification', () => {
  for (const t of [
    'liquidation',
    'Liquidation',
    'partialLiquidation',
    'PartialLiquidation',
    'unwindBankrupt',
    'unwindCounterparty',
  ]) {
    assert.equal(isKrakenLiquidationFill({ fill_type: t }), true, t)
  }
  // REST spells it fillType.
  assert.equal(isKrakenLiquidationFill({ fillType: 'liquidation' }), true)
  for (const t of ['maker', 'taker', 'takerAfterEdit', 'assignor', 'assignee', '', undefined]) {
    assert.equal(isKrakenLiquidationFill({ fill_type: t }), false, `${t}`)
  }
})
