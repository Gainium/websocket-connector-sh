/**
 * Coinbase user channel → ExecutionReport status contract.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Coinbase Advanced Trade has no PARTIALLY_FILLED order status. A resting
 * order that has taken some size stays `OPEN` and reports the progress in
 * `cumulative_quantity`; only the terminal states change `status`. Mapping
 * `OPEN` straight to `NEW` therefore meant this venue never emitted a single
 * PARTIALLY_FILLED report, so a consumer that books partial fills never heard
 * about the executed part.
 *
 * The payloads below are the real prod messages for TP order
 * D-TP-n4FvLiQneUyABqhrR0DTN7By3DQwpA on MASK-USDC (forum topic 2663): a
 * 140.26 sell that filled 51.5 and was then canceled so the TP could be
 * re-sized after a safety order filled. Reported as NEW, the 51.5 was never
 * recorded, the deal kept counting base the account no longer held, and every
 * later TP was sized 51.5 above the free balance and rejected.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'

/** Real prod order snapshots, verbatim from the user-stream log (2026-08-25). */
const BASE = {
  order_id: '3d9689ab-6e9e-4cde-8759-ce1f15c1db3a',
  client_order_id: 'D-TP-n4FvLiQneUyABqhrR0DTN7By3DQwpA',
  product_id: 'MASK-USDC',
  order_side: 'SELL',
  order_type: 'Limit',
  creation_time: '2026-08-25T00:43:56.428Z',
  avg_price: '0.44',
  cumulative_quantity: '0',
  leaves_quantity: '140.26',
  status: 'OPEN',
}

/** testMode skips rabbit/redis. */
const connector = () => new UserConnector(true) as any

const emit = (uc: any, order: Record<string, unknown>) =>
  uc.prepareCoinbaseOrderMsg({
    sequence_num: 1,
    timestamp: '2026-08-25T08:14:22.349Z',
    events: [{ orders: [order] }],
  })

test('a resting order with no fills is NEW', () => {
  const [report] = emit(connector(), BASE)
  assert.equal(report.orderStatus, 'NEW')
  assert.equal(report.totalTradeQuantity, '0')
})

test('an OPEN order that has taken size is PARTIALLY_FILLED', () => {
  const [report] = emit(connector(), {
    ...BASE,
    cumulative_quantity: '51.5',
    leaves_quantity: '88.76',
  })
  assert.equal(report.orderStatus, 'PARTIALLY_FILLED')
  assert.equal(report.totalTradeQuantity, '51.5')
})

test('the terminal states are unchanged by the partial-fill check', () => {
  const uc = connector()
  const filled = emit(uc, {
    ...BASE,
    status: 'FILLED',
    cumulative_quantity: '140.26',
    leaves_quantity: '0',
  })[0]
  assert.equal(filled.orderStatus, 'FILLED')

  // The cancel that ended this order still carries the 51.5 it took.
  const canceled = emit(uc, {
    ...BASE,
    status: 'CANCELLED',
    cumulative_quantity: '51.5',
    leaves_quantity: '0',
  })[0]
  assert.equal(canceled.orderStatus, 'CANCELED')
  assert.equal(canceled.totalTradeQuantity, '51.5')
})

test('a malformed cumulative_quantity does not become PARTIALLY_FILLED', () => {
  const uc = connector()
  for (const cumulative_quantity of ['', 'n/a']) {
    const [report] = emit(uc, { ...BASE, cumulative_quantity })
    assert.equal(report.orderStatus, 'NEW')
  }
})
