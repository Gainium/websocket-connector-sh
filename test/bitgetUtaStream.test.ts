/**
 * Bitget Unified Trading Account (v3) private stream → ExecutionReport /
 * OutboundAccountPosition.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * A unified account's orders and balances are published only on the v3
 * private socket, as `{instType:'UTA', topic:'order'|'account'}` pushes that
 * carry every category at once. Payloads below are the documented push shapes
 * (docs/uta/websocket/private/Order-Channel, Account-Channel).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'
import { ExchangeEnum } from '../src/utils/common'
import { bitgetAccountModeFromSettings } from '../src/utils/bitgetAccountMode'

const connector = () => new UserConnector(true) as any

const order = (o: Record<string, unknown>) => ({
  category: 'usdt-futures',
  symbol: 'BTCUSDT',
  orderId: '111',
  clientOid: 'D-BO-1',
  price: '',
  qty: '0.001',
  amount: '1000',
  holdMode: 'hedge_mode',
  holdSide: 'long',
  tradeSide: 'open',
  orderType: 'market',
  side: 'buy',
  reduceOnly: 'no',
  cumExecQty: '0.001',
  cumExecValue: '83.1315',
  avgPrice: '83131.5',
  orderStatus: 'filled',
  feeDetail: [{ feeCoin: 'USDT', fee: '0.0332526' }],
  createdTime: '1742367838101',
  updatedTime: '1742367838115',
  ...o,
})

test('UTA order push: a futures fill becomes a FILLED executionReport', () => {
  const [r] = connector().prepareBitgetUtaOrderMsg(
    [order({})],
    ExchangeEnum.bitgetUsdm,
  )
  assert.equal(r.orderStatus, 'FILLED')
  assert.equal(r.newClientOrderId, 'D-BO-1')
  assert.equal(r.price, '83131.5')
  assert.equal(r.totalTradeQuantity, '0.001')
  assert.equal(r.totalQuoteTradeQuantity, '83.1315')
  assert.equal(r.side, 'BUY')
  assert.equal(r.orderType, 'MARKET')
  assert.equal(r.feePaid, '0.0332526')
  assert.equal(r.feeAsset, 'USDT')
})

test('UTA order push: each connection only reports its own categories', () => {
  const uc = connector()
  const mixed = [
    order({ category: 'spot', symbol: 'RAAPLUSDT', clientOid: 'spot-1' }),
    order({ category: 'usdc-futures', symbol: 'BTCUSDC', clientOid: 'usdc-1' }),
    order({ category: 'margin', clientOid: 'margin-1' }),
  ]
  assert.deepEqual(
    uc
      .prepareBitgetUtaOrderMsg(mixed, ExchangeEnum.bitget)
      .map((r: any) => r.newClientOrderId),
    ['spot-1'],
  )
  assert.deepEqual(
    uc
      .prepareBitgetUtaOrderMsg(mixed, ExchangeEnum.bitgetUsdm)
      .map((r: any) => r.newClientOrderId),
    ['usdc-1'],
  )
})

test('UTA order push: live and new are NEW, a resting limit uses its price', () => {
  const uc = connector()
  const [live, fresh] = uc.prepareBitgetUtaOrderMsg(
    [
      order({
        category: 'spot',
        orderType: 'limit',
        orderStatus: 'live',
        price: '330.5',
        avgPrice: '0',
        cumExecQty: '0',
        cumExecValue: '0',
      }),
      order({ category: 'spot', orderStatus: 'new' }),
    ],
    ExchangeEnum.bitget,
  )
  assert.equal(live.orderStatus, 'NEW')
  assert.equal(live.price, '330.5')
  assert.equal(live.orderType, 'LIMIT')
  assert.equal(fresh.orderStatus, 'NEW')
})

const ACCOUNT = [
  {
    totalEquity: '4976919.05',
    coin: [
      { coin: 'ETH', balance: '0.9992', available: '0.9992', locked: '0' },
      {
        coin: 'USDT',
        balance: '354411.45536458',
        available: '344282.65536458',
        locked: '0',
      },
      { coin: 'rAAPL', balance: '2', available: '1.5', locked: '0.5' },
    ],
  },
]

test('UTA account push: free + locked is the balance; spot reports every coin', () => {
  const msg = connector().prepareBitgetUtaOutboundAccountInfo(
    ACCOUNT,
    1740546523244,
    'u1',
    ExchangeEnum.bitget,
  )
  assert.equal(msg.eventType, 'outboundAccountPosition')
  assert.deepEqual(
    msg.balances.map((b: any) => b.asset),
    ['ETH', 'USDT', 'rAAPL'],
  )
  const raapl = msg.balances.find((b: any) => b.asset === 'rAAPL')
  assert.equal(raapl.free, '1.5')
  assert.equal(raapl.locked, '0.5')
})

test('UTA account push: futures reports only its margin coins', () => {
  const msg = connector().prepareBitgetUtaOutboundAccountInfo(
    ACCOUNT,
    1740546523244,
    'u1',
    ExchangeEnum.bitgetUsdm,
  )
  assert.deepEqual(
    msg.balances.map((b: any) => b.asset),
    ['USDT'],
  )
  assert.equal(+msg.balances[0].free + +msg.balances[0].locked, 354411.45536458)
})

// exchange-connector-sh spec 030. Snapshot from a live COIN-M account with a
// resting DCA ladder: balance and equity both shrank to the unreserved part;
// totalEquity (USD) is the venue's own total (Est. value 0.007488 BTC).
const LADDER = {
  coin: 'BTC',
  balance: '0.00088924',
  equity: '0.00088924',
  locked: '0.00587569',
  available: '-0.00498646',
  usdValue: '75.3740391',
}

test('UTA account push: a resting ladder does not shrink the total', () => {
  const msg = connector().prepareBitgetUtaOutboundAccountInfo(
    [{ totalEquity: '634.73', unrealisedPnL: '0', coin: [LADDER] }],
    1740546523244,
    'u1',
    ExchangeEnum.bitgetCoinm,
  )
  assert.equal(msg.balances[0].free, '0')
  assert.equal(+(+msg.balances[0].locked).toFixed(7), 0.0074884)
})

test('UTA account push: open P&L stays out of the total', () => {
  const msg = connector().prepareBitgetUtaOutboundAccountInfo(
    [
      {
        totalEquity: '350',
        unrealisedPnL: '50',
        coin: [
          { coin: 'BTC', balance: '0.001', available: '0', usdValue: '100' },
        ],
      },
    ],
    1740546523244,
    'u1',
    ExchangeEnum.bitgetCoinm,
  )
  assert.equal(+(+msg.balances[0].locked).toFixed(8), 0.003)
})

test('UTA account push: without an account total the coin figures stand', () => {
  const msg = connector().prepareBitgetUtaOutboundAccountInfo(
    [{ coin: [{ coin: 'BTC', balance: '0.5', available: '0.2' }] }],
    1740546523244,
    'u1',
    ExchangeEnum.bitgetCoinm,
  )
  assert.equal(msg.balances[0].free, '0.2')
  assert.equal(msg.balances[0].locked, '0.3')
})

test('account mode: unified/hybrid/upgrading are UTA, switching is classic', () => {
  assert.equal(bitgetAccountModeFromSettings({ accountMode: 'unified' }), 'uta')
  assert.equal(bitgetAccountModeFromSettings({ accountMode: 'hybrid' }), 'uta')
  assert.equal(
    bitgetAccountModeFromSettings({ accountMode: 'switching' }),
    'classic',
  )
  assert.equal(bitgetAccountModeFromSettings({}), undefined)
})
