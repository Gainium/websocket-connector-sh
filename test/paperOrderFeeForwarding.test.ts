/**
 * Spec: specs/005.paper-order-fee-forwarding.md §1.2/§3,
 * specs/006.paper-order-fee-asset-forwarding.md.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * paper-trading now reports `feePaid`/`feeSide` (spec 003 there) and, for a
 * symbol configured for third-asset fee testing, `feePaid`/`feeAsset`
 * instead (spec 004 there) on its socket.io `order` push.
 * `preparePaperOrderMsg` builds the outgoing `ExecutionReport` from a fixed
 * field list — these tests are RED before each field is added/copied, not
 * for a shape mismatch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import UserConnector from '../src/userStream'
import type { PaperOrderMessage } from '../src/userStream'

const connector = () => new UserConnector(true) as any

function paperMsg(overrides: Partial<PaperOrderMessage> = {}): PaperOrderMessage {
  return {
    _id: 'o1',
    price: 50000,
    filledAmount: 0.01,
    filledQuoteAmount: 500,
    amount: 0.01,
    type: 'MARKET',
    symbol: 'BTCUSDT',
    externalId: 'ext-1',
    status: 'FILLED',
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:01.000Z',
    side: 'BUY',
    quoteAmount: 500,
    exchange: 'binance',
    ...overrides,
  }
}

test('preparePaperOrderMsg forwards feePaid/feeSide when present', () => {
  const uc = connector()
  const report = uc.preparePaperOrderMsg(
    paperMsg({ feePaid: '0.005', feeSide: 'base' }),
  )
  assert.equal(report.feePaid, '0.005')
  assert.equal(report.feeSide, 'base')
})

test('preparePaperOrderMsg omits feePaid/feeSide when absent (never a claim of zero)', () => {
  const uc = connector()
  const report = uc.preparePaperOrderMsg(paperMsg())
  assert.equal('feePaid' in report, false)
  assert.equal('feeSide' in report, false)
})

test('preparePaperOrderMsg forwards feePaid/feeAsset for a third-asset-fee symbol', () => {
  const uc = connector()
  const report = uc.preparePaperOrderMsg(
    paperMsg({ feePaid: '0.005', feeAsset: 'GNM' }),
  )
  assert.equal(report.feePaid, '0.005')
  assert.equal(report.feeAsset, 'GNM')
  assert.equal('feeSide' in report, false)
})

test('preparePaperOrderMsg omits feeAsset when absent', () => {
  const uc = connector()
  const report = uc.preparePaperOrderMsg(
    paperMsg({ feePaid: '0.005', feeSide: 'base' }),
  )
  assert.equal('feeAsset' in report, false)
})
