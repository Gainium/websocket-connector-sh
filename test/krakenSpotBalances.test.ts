/**
 * Kraken SPOT WebSocket v2 `balances` channel → OutboundAccountPosition.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * Kraken spot v2 wraps the payload as `{channel, type, data:[…]}`. The
 * converter only understood a bare array (v1-style), the futures `holding`
 * object and `flex_futures`, so every spot message returned undefined and no
 * balance update was ever published for a Kraken spot account — dashboards
 * showed the 00:45 daily REST snapshot all day (2026-09-03, Alessandro's
 * account: 13.5 ETH shown, 1.53 on Kraken). Futures messages must keep
 * working unchanged.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'
import { ExchangeEnum } from '../src/utils/common'

function connector() {
  const uc = new UserConnector(true) as any
  uc.getKrakenMaps = async () => ({
    assetNameMap: new Map([
      ['XBT', 'BTC'],
      ['XETH', 'ETH'],
    ]),
  })
  return uc
}

/** Shapes per Kraken docs (WebSocket v2, private `balances` channel). */
const SNAPSHOT = {
  channel: 'balances',
  type: 'snapshot',
  data: [
    {
      asset: 'ETH',
      asset_class: 'currency',
      balance: 1.53,
      wallets: [{ type: 'spot', id: 'main', balance: 1.53 }],
    },
    { asset: 'USD', asset_class: 'currency', balance: 56231.2587, wallets: [] },
  ],
}
const UPDATE = {
  channel: 'balances',
  type: 'update',
  data: [
    {
      asset: 'ETH',
      amount: -12.0,
      balance: 1.53,
      fee: 0,
      ledger_id: 'L2OWSE-YJTX5-MCNW3F',
      ref_id: 'TB4QGE-K7WSN-M3L2J7',
      timestamp: '2026-09-03T14:56:00.000000Z',
      type: 'trade',
      wallet: { type: 'spot', id: 'main' },
    },
  ],
}

test('spot v2 snapshot becomes an outboundAccountPosition with free only', async () => {
  const uc = connector()
  const out = await uc.prepareKrakenBalanceMsg(
    SNAPSHOT,
    1_000,
    'uuid-1',
    ExchangeEnum.kraken,
  )
  assert.ok(out, 'a spot snapshot must not fall through')
  assert.equal(out.eventType, 'outboundAccountPosition')
  assert.deepEqual(
    out.balances.map((b: any) => [b.asset, b.free, b.locked]),
    [
      ['ETH', '1.53', undefined],
      ['USD', '56231.2587', undefined],
    ],
  )
})

test('spot v2 update carries the new total as free', async () => {
  const uc = connector()
  const out = await uc.prepareKrakenBalanceMsg(
    UPDATE,
    2_000,
    'uuid-1',
    ExchangeEnum.kraken,
  )
  assert.ok(out)
  assert.deepEqual(out.balances, [{ asset: 'ETH', free: '1.53' }])
  assert.equal('locked' in out.balances[0], false)
})

test('spot v2 asset names go through the Kraken asset map', async () => {
  const uc = connector()
  const out = await uc.prepareKrakenBalanceMsg(
    { channel: 'balances', type: 'snapshot', data: [{ asset: 'XBT', balance: 0.12 }] },
    3_000,
    'uuid-1',
    ExchangeEnum.kraken,
  )
  assert.deepEqual(out.balances, [{ asset: 'BTC', free: '0.12' }])
})

test('an empty spot payload still returns undefined', async () => {
  const uc = connector()
  const out = await uc.prepareKrakenBalanceMsg(
    { channel: 'balances', type: 'update', data: [] },
    4_000,
    'uuid-1',
    ExchangeEnum.kraken,
  )
  assert.equal(out, undefined)
})

test('futures `holding` messages are unchanged', async () => {
  const uc = connector()
  const out = await uc.prepareKrakenBalanceMsg(
    { feed: 'balances', holding: { USD: 100.5, XBT: 0.01 } },
    5_000,
    'uuid-2',
    ExchangeEnum.krakenUsdm,
  )
  assert.deepEqual(
    out.balances.map((b: any) => [b.asset, b.free, b.locked]),
    [
      ['USD', '100.5', '0'],
      ['BTC', '0.01', '0'],
    ],
  )
})
