/**
 * Regression coverage for spec 010 — binanceUS price/candle streams never
 * open, and the boot line hides it.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * `Connector`'s gates are the whole subject: `isBinanceUS` was the only one
 * that did not route through `isFamilyNeeded`, so an allow-list naming
 * `binance` (the family that *serves* binanceUS — there is no separate
 * binanceUS worker) still constructed the family worker with
 * `binance.isUs = false`, and an admin-config set was not consulted at all.
 * `logFamilySelection` then enumerated only `FAMILY_VARIANTS` keys, so the
 * dark venue appeared in neither `streaming:` nor `NOT streaming:`.
 *
 * Nothing here opens a socket. The gates are read off the prototype with
 * `Object.create` (no constructor ⇒ no Redis/Rabbit), `adminConfig` is
 * swapped in `require.cache` so the self-hosted path is exercised without a
 * Redis key, and the last test drives the real `initBinanceWS` against fake
 * clients to show which sockets each gate value actually produces.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { ExchangeEnum } from '../src/utils/common'
import logger from '../src/utils/logger'
import BinanceConnector from '../src/price/binance'

/** CommonJS loader — the cache is the point: each case needs a fresh module. */
const load = createRequire(__filename)
const CONNECTOR = load.resolve('../src/priceConnector')
const ADMIN_CONFIG = load.resolve('../src/utils/adminConfig')

/** Prod's `PRICE_CONNECTOR_EXCHANGES`, as reported by its own boot line. */
const PROD_ENV = 'bybit,binance,okx,kucoin,bitget,hyperliquid,kraken,coinbase'

type Gates = {
  isBinance: boolean
  isBinanceUS: boolean
  /** The single `Price connector families […]` line, verbatim. */
  familyLine: string
}

/**
 * Re-require `priceConnector` with a given env allow-list and a given
 * admin-config snapshot, then read its gates. `exchanges` is module-level and
 * frozen at import, so each case needs a fresh module instance.
 *
 * `adminEnabled === null` = cloud build (no admin-config), which is what prod
 * runs.
 */
function loadGates(
  envValue: string | undefined,
  adminEnabled: string[] | null,
): Gates {
  const prevEnv = process.env.PRICE_CONNECTOR_EXCHANGES
  const realAdminModule = load.cache[ADMIN_CONFIG]
  const realAdminExports = load(ADMIN_CONFIG)
  const prevInfo = logger.info

  if (envValue === undefined) {
    delete process.env.PRICE_CONNECTOR_EXCHANGES
  } else {
    process.env.PRICE_CONNECTOR_EXCHANGES = envValue
  }

  const snapshot = adminEnabled === null ? null : new Set(adminEnabled)
  if (realAdminModule) {
    realAdminModule.exports = {
      ...realAdminExports,
      isAdminConfigEnabled: () => snapshot !== null,
      getEnabledSnapshot: () => (snapshot ? new Set(snapshot) : null),
      isExchangeEnabled: (e: string) => (snapshot ? snapshot.has(e) : true),
      onAdminConfigChange: () => () => undefined,
    }
  }
  delete load.cache[CONNECTOR]

  try {
    const Connector = load(CONNECTOR).default
    const proto = Connector.prototype as any
    // No constructor: it opens Redis and a Rabbit consumer. The gates only
    // need the prototype's accessors and the module-level allow-list.
    const fake = Object.create(proto)

    const lines: string[] = []
    logger.info = (...msg: any[]) => {
      lines.push(msg.map((m) => `${m}`).join(' '))
    }
    try {
      proto.logFamilySelection.call(fake)
    } finally {
      logger.info = prevInfo
    }

    return {
      isBinance: fake.isBinance,
      isBinanceUS: fake.isBinanceUS,
      familyLine:
        lines.find((l) => l.startsWith('Price connector families')) ?? '',
    }
  } finally {
    logger.info = prevInfo
    if (realAdminModule) realAdminModule.exports = realAdminExports
    delete load.cache[CONNECTOR]
    if (prevEnv === undefined) {
      delete process.env.PRICE_CONNECTOR_EXCHANGES
    } else {
      process.env.PRICE_CONNECTOR_EXCHANGES = prevEnv
    }
  }
}

/** `streaming:` / `NOT streaming:` as two token lists. */
function splitFamilyLine(line: string): { on: string[]; off: string[] } {
  const m = line.match(/streaming: (.*) \| NOT streaming: (.*)$/)
  assert.ok(m, `unparseable family line: ${line}`)
  const parse = (s: string) => (s === '(none)' ? [] : s.split(','))
  return { on: parse(m[1]), off: parse(m[2]) }
}

test('§1.1a env allow-list: `binance` enables the binanceUS sockets too', () => {
  // Production's exact allow-list. It has no `binanceus` token, and there is
  // no binanceUS worker to name one for — the binance family worker is what
  // serves it.
  const g = loadGates(PROD_ENV, null)
  assert.equal(g.isBinance, true)
  assert.equal(
    g.isBinanceUS,
    true,
    'binanceUS must stream when the binance family is allow-listed',
  )
})

test('§1.1a env allow-list: `binanceus` alone still enables the family', () => {
  const g = loadGates('binanceus', null)
  assert.equal(g.isBinanceUS, true)
  assert.equal(g.isBinance, true, 'the alias must keep the family worker alive')
})

test('§1.1a/§1.1c no binance token: binanceUS is off AND says so', () => {
  const g = loadGates('bybit,okx', null)
  assert.equal(g.isBinanceUS, false)
  assert.equal(g.isBinance, false)
  const { on, off } = splitFamilyLine(g.familyLine)
  assert.ok(!on.includes('binanceUS'), 'must not claim to stream binanceUS')
  assert.ok(
    off.includes('binanceUS'),
    `a dark venue must appear in NOT streaming: ${g.familyLine}`,
  )
})

test('§1.1b admin-config off for binanceUS wins over an empty env', () => {
  // sh deployment: the operator unticked Binance US in Admin → Exchanges.
  // The env is not consulted once admin-config has a set.
  const g = loadGates('', ['bybit', 'binance', 'binanceUsdm'])
  assert.equal(g.isBinance, true)
  assert.equal(
    g.isBinanceUS,
    false,
    'admin-config is authoritative — do not open a US socket it disabled',
  )
  const { on, off } = splitFamilyLine(g.familyLine)
  assert.ok(off.includes('binanceUS'))
  assert.ok(on.includes('binance'))
})

test('§1.1b admin-config on for binanceUS wins over a stale env', () => {
  const g = loadGates('bybit', [ExchangeEnum.binanceUS])
  assert.equal(
    g.isBinanceUS,
    true,
    'admin-config enabled binanceUS; the legacy env line must not veto it',
  )
  const { on } = splitFamilyLine(g.familyLine)
  assert.ok(on.includes('binanceUS'))
})

test('§1.1c every venue appears in exactly one of the two lists', () => {
  for (const [env, admin] of [
    [PROD_ENV, null],
    ['bybit,okx', null],
    ['', ['bybit', 'binance']],
  ] as [string, string[] | null][]) {
    const { on, off } = splitFamilyLine(loadGates(env, admin).familyLine)
    const seen = [...on, ...off]
    assert.equal(
      new Set(seen).size,
      seen.length,
      `duplicate entry in ${env || '(admin-config)'}`,
    )
    assert.ok(
      seen.includes('binanceUS'),
      `binanceUS missing from both lists for ${env || '(admin-config)'}`,
    )
  }
})

test('§1.2 the gate is what decides whether a binanceUS socket opens', () => {
  // The real `initBinanceWS`, fake clients: this is the step between the gate
  // and the venue going dark. `isUs` reaches it as `binance.isUs` from
  // `initWorker`'s worker payload.
  const run = (isIntl: boolean, isUs: boolean) => {
    const calls: string[] = []
    const fake: any = Object.create(BinanceConnector.prototype)
    fake.isIntl = isIntl
    fake.isUs = isUs
    fake.binanceClient = {
      subscribeSpotAllMini24hrTickers: () => calls.push('intl-spot'),
    }
    fake.binanceClientCoinm = {
      subscribeAll24hrTickers: (m: string) => calls.push(`coinm:${m}`),
    }
    fake.binanceClientUsdm = {
      subscribeAll24hrTickers: (m: string) => calls.push(`usdm:${m}`),
    }
    fake.binanceClientUs = {
      subscribeSpotAllMini24hrTickers: () => calls.push('us-spot'),
    }
    ;(BinanceConnector.prototype as any).initBinanceWS.call(fake)
    return calls
  }

  assert.deepEqual(run(true, false), ['intl-spot', 'coinm:coinm', 'usdm:usdm'])
  assert.ok(
    run(true, true).includes('us-spot'),
    'isUs must open the binance.us ticker stream',
  )
})
