/**
 * Bitget inverse perpetuals (`BTCUSD`) on the unified line.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * The venue moved these contracts off v2 entirely: their tickers and candles
 * are quoted only on the v3 public topics, under a `_CM` name, and their
 * fills arrive on the v3 private socket sized in 1-USD contracts. The
 * platform keeps the name and the base-coin unit it has always used
 * (exchange-connector spec 014). Nothing here opens a socket.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import BitgetConnector from '../src/price/bitget'
import UserConnector from '../src/userStream'
import { ExchangeEnum } from '../src/utils/common'
import {
  bitgetInverseKlineInterval,
  bitgetInverseQtyUnit,
  setBitgetInversePerps,
  splitBitgetCoinmMarkets,
} from '../src/utils/bitgetInverse'

const proto = BitgetConnector.prototype as any

function fake() {
  const subscribed: unknown[] = []
  const trades: { trade: any; exchange: ExchangeEnum }[] = []
  const tickers: { data: any; exchange: ExchangeEnum }[] = []
  const self: any = {
    inverseChannels: new Map<string, string>(),
    mainData: {},
    base: {},
    bitgetClientV3CoinmCandle: [
      {
        client: { subscribe: (t: unknown) => subscribed.push(t) },
        subs: 0,
        id: 0,
      },
    ],
    bitgetClientV3CoinmTicker: [
      {
        client: { subscribe: (t: unknown) => subscribed.push(t) },
        subs: 0,
        id: 0,
      },
    ],
    cbWsTrade: (trade: any, exchange: ExchangeEnum) =>
      trades.push({ trade, exchange }),
    cbWs: (data: any, exchange: ExchangeEnum) =>
      tickers.push({ data, exchange }),
  }
  self.subscribeBitgetInverseCandle =
    proto.subscribeBitgetInverseCandle.bind(self)
  self.subscribeBitgetInverseTickers =
    proto.subscribeBitgetInverseTickers.bind(self)
  self.bitgetInverseCb = proto.bitgetInverseCb.bind(self)
  return { self, subscribed, trades, tickers }
}

test('only the UTC-aligned v3 intervals are streamed for inverse perpetuals', () => {
  assert.deepEqual(
    [
      'candle1m',
      'candle5m',
      'candle30m',
      'candle1H',
      'candle4H',
      'candle6Hutc',
      'candle1Dutc',
      'candle1Wutc',
    ].map(bitgetInverseKlineInterval),
    ['1m', '5m', '30m', '1H', '4H', undefined, undefined, undefined],
  )
})

test('subscriptions carry the venue name, once per symbol and interval', () => {
  const { self, subscribed } = fake()
  self.subscribeBitgetInverseTickers(['BTCUSD'])
  self.subscribeBitgetInverseCandle('BTCUSD', 'candle1H')
  self.subscribeBitgetInverseCandle('BTCUSD', 'candle1H')
  assert.deepEqual(subscribed, [
    { instType: 'coin-futures', topic: 'ticker', symbol: 'BTCUSD_CM' },
    {
      instType: 'coin-futures',
      topic: 'kline',
      symbol: 'BTCUSD_CM',
      interval: '1H',
    },
  ])
})

test('a v3 push publishes under the platform name, on bitgetCoinm', () => {
  const { self, trades, tickers } = fake()
  self.subscribeBitgetInverseCandle('BTCUSD', 'candle1H')
  self.bitgetInverseCb({
    action: 'snapshot',
    ts: 1789903158254,
    arg: { instType: 'coin-futures', topic: 'ticker', symbol: 'BTCUSD_CM' },
    data: [
      {
        lastPrice: '80274.3',
        openPrice24h: '81264.8',
        highPrice24h: '81893.2',
        lowPrice24h: '80126.4',
        volume24h: '111.3103',
        turnover24h: '9001977',
        bid1Price: '80274.5',
        ask1Price: '80305.5',
        bid1Size: '7500',
        ask1Size: '10195',
      },
    ],
  })
  assert.equal(tickers.length, 1)
  assert.equal(tickers[0].exchange, ExchangeEnum.bitgetCoinm)
  assert.equal(tickers[0].data[0].symbol, 'BTCUSD')
  assert.equal(tickers[0].data[0].curDayClose, '80274.3')
  assert.equal(tickers[0].data[0].volumeQuote, '9001977')

  self.bitgetInverseCb({
    action: 'update',
    ts: 1789903158254,
    arg: {
      instType: 'coin-futures',
      topic: 'kline',
      symbol: 'BTCUSD_CM',
      interval: '1H',
    },
    data: [
      {
        start: '1789902000000',
        open: '80252.5',
        high: '80318.1',
        low: '80208.5',
        close: '80295.5',
        volume: '5.7226',
        turnover: '458960',
      },
    ],
  })
  assert.equal(trades.length, 1)
  assert.equal(trades[0].exchange, ExchangeEnum.bitgetCoinm)
  assert.equal(trades[0].trade.s, 'BTCUSD')
  // published on the channel main-app subscribed, with the quote volume
  assert.equal(trades[0].trade.k.i, 'candle1H')
  assert.equal(trades[0].trade.k.v, '458960')
  assert.equal(trades[0].trade.k.t, 1789902000000)
})

test('the perpetuals are known from the venue, not from their spelling', async () => {
  setBitgetInversePerps(['BTCUSD', 'ETHUSD'])
  const { getBitgetInversePerps } = await import('../src/utils/bitgetInverse')
  const perps = await getBitgetInversePerps()
  assert.equal(perps.has('BTCUSD'), true)
  // the quarterly delivery contracts stayed on the classic line
  assert.equal(perps.has('BTCUSDU26'), false)
})

const inverseOrder = (o: Record<string, unknown> = {}) => ({
  category: 'coin-futures',
  symbol: 'BTCUSD_CM',
  orderId: '222',
  clientOid: 'D-BO-2',
  price: '80000',
  qty: '800',
  holdMode: 'one_way_mode',
  orderType: 'limit',
  side: 'buy',
  reduceOnly: 'no',
  cumExecQty: '800',
  cumExecValue: '0.01',
  avgPrice: '80000',
  orderStatus: 'filled',
  feeDetail: [{ feeCoin: 'BTC', fee: '0.000006' }],
  createdTime: '1789900000000',
  updatedTime: '1789900001000',
  ...o,
})

test('an inverse fill reports the platform name and a base-coin quantity', () => {
  const [r] = (new UserConnector(true) as any).prepareBitgetUtaOrderMsg(
    [inverseOrder()],
    ExchangeEnum.bitgetCoinm,
  )
  assert.equal(r.symbol, 'BTCUSD')
  assert.equal(r.orderStatus, 'FILLED')
  assert.equal(r.totalTradeQuantity, '0.01')
  assert.equal(r.quantity, '0.01')
  // the contracts themselves are the traded notional
  assert.equal(r.totalQuoteTradeQuantity, '800')
  assert.equal(r.feeAsset, 'BTC')
})

test('a venue that reports the base coin instead is taken at its word', () => {
  const [r] = (new UserConnector(true) as any).prepareBitgetUtaOrderMsg(
    [
      inverseOrder({
        qty: '0.01',
        cumExecQty: '0.01',
        cumExecValue: '800',
      }),
    ],
    ExchangeEnum.bitgetCoinm,
  )
  assert.equal(r.totalTradeQuantity, '0.01')
  assert.equal(r.totalQuoteTradeQuantity, '800')
  assert.equal(
    bitgetInverseQtyUnit({
      cumExecQty: '0.01',
      cumExecValue: '800',
      avgPrice: '80000',
    }),
    'base',
  )
})

test('a linear connection does not report the inverse categories, and vice versa', () => {
  const connector = new UserConnector(true) as any
  assert.equal(
    connector.prepareBitgetUtaOrderMsg(
      [inverseOrder()],
      ExchangeEnum.bitgetUsdm,
    ).length,
    0,
  )
  assert.equal(
    connector.prepareBitgetUtaOrderMsg(
      [inverseOrder({ category: 'usdt-futures', symbol: 'BTCUSDT' })],
      ExchangeEnum.bitgetCoinm,
    ).length,
    0,
  )
})

test('the perpetuals are added to the coin-margined tickers, not filtered out of them', () => {
  // the classic contract listing the connector builds its markets from kept
  // only the quarterly contracts, so an intersection would open nothing
  const split = splitBitgetCoinmMarkets(
    ['BTCUSDU26', 'ETHUSDU26'],
    new Set(['BTCUSD', 'ETHUSD']),
  )
  assert.deepEqual(split.classic, ['BTCUSDU26', 'ETHUSDU26'])
  assert.deepEqual(split.inverse, ['BTCUSD', 'ETHUSD'])
})
