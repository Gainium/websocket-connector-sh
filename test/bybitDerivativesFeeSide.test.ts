/**
 * Bybit user stream: a derivatives order's fee is placed on the settle coin.
 *
 * Bybit fills `feeCurrency` for spot only — on linear/inverse orders it is
 * "" in the prod stream (every MARKET order on bybitLinear carried a fee with a
 * blank currency), so consumers could not place the fee on the pair and booked
 * the estimate. The report now names the side instead: quote for linear, base
 * for inverse — the same rule exchange-connector's REST `orderFee` applies.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'

const order = (over: Record<string, unknown>) => ({
  createType: 'CreateByUser',
  symbol: 'EVAAUSDT',
  orderId: 'o1',
  side: 'Buy',
  orderType: 'Market',
  price: '1.3472',
  qty: '0.2',
  orderStatus: 'Filled',
  orderLinkId: 'c1',
  cumExecQty: '0.2',
  cumExecValue: '0.26944',
  avgPrice: '1.3472',
  cumExecFee: '0.00029639',
  createdTime: '1000',
  updatedTime: '2000',
  category: 'linear',
  feeCurrency: '',
  ...over,
})

const report = (over: Record<string, unknown>, category: string) =>
  (new UserConnector(true) as any).prepareBybitOrderMsg(
    { creationTime: '1', data: [order({ category, ...over })] },
    category,
  )[0]

test('linear with blank feeCurrency: fee on the quote side, no blank feeAsset', () => {
  const r = report({}, 'linear')
  assert.equal(r.feePaid, '0.00029639')
  assert.equal(r.feeSide, 'quote')
  assert.equal('feeAsset' in r, false)
})

test('inverse with blank feeCurrency: fee on the base side', () => {
  const r = report({ symbol: 'BTCUSD' }, 'inverse')
  assert.equal(r.feeSide, 'base')
  assert.equal('feeAsset' in r, false)
})

test('a named feeCurrency still wins and sets no side', () => {
  const r = report({ feeCurrency: 'USDT' }, 'linear')
  assert.equal(r.feeAsset, 'USDT')
  assert.equal('feeSide' in r, false)
})

test('spot with blank feeCurrency: nothing guessed', () => {
  const r = report({ symbol: 'BTCUSDT' }, 'spot')
  assert.equal('feeSide' in r, false)
  assert.equal('feeAsset' in r, false)
})
