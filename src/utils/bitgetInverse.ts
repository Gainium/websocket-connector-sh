import axios from 'axios'
import logger from './logger'

/**
 * Bitget's inverse perpetuals (`BTCUSD`), which now live only on the venue's
 * unified line.
 *
 * There they carry a `_CM` name (`BTCUSD_CM`) and are quoted only on the v3
 * market surface: the classic COIN-FUTURES ticker and candle channels answer
 * them with nothing, and the classic listing kept only the quarterly delivery
 * contracts (`BTCUSDU26`), which stay where they are. The platform keeps the
 * name the perpetual has always had — exchange-connector's spec 014 §3.2 —
 * so the suffix is added when subscribing and stripped when publishing.
 */

const TTL_MS = 60 * 60 * 1000
const RETRY_MS = 60 * 1000

let cache: { symbols: Set<string>; at: number; attemptAt: number } = {
  symbols: new Set(),
  at: 0,
  attemptAt: 0,
}

/** Platform names of the inverse perpetuals the venue currently lists. */
export async function getBitgetInversePerps(): Promise<Set<string>> {
  const now = Date.now()
  if (now - cache.at <= TTL_MS || now - cache.attemptAt <= RETRY_MS) {
    return cache.symbols
  }
  cache = { ...cache, attemptAt: now }
  try {
    const res = await axios.get(
      'https://api.bitget.com/api/v3/market/instruments',
      { params: { category: 'COIN-FUTURES' }, timeout: 30000 },
    )
    const rows = (res.data?.data ?? []) as {
      symbol?: string
      type?: string
      status?: string
    }[]
    cache = {
      symbols: new Set(
        rows
          .filter(
            (r) =>
              r.symbol &&
              `${r.type}`.toLowerCase() === 'perpetual' &&
              `${r.status}`.toLowerCase() === 'online',
          )
          .map((r) => bitgetInversePlatformSymbol(r.symbol as string)),
      ),
      at: now,
      attemptAt: now,
    }
  } catch (e) {
    logger.warn(
      `Bitget v3 instruments (inverse perpetuals) failed: ${
        (e as Error)?.message
      }`,
    )
  }
  return cache.symbols
}

/** Test hook. */
export const setBitgetInversePerps = (symbols: string[]) => {
  cache = { symbols: new Set(symbols), at: Date.now(), attemptAt: Date.now() }
}

export const bitgetInverseVenueSymbol = (pair: string): string =>
  pair.endsWith('_CM') ? pair : `${pair}_CM`

export const bitgetInversePlatformSymbol = (symbol: string): string =>
  symbol.replace(/_CM$/, '')

/**
 * The v3 kline interval that serves a candle channel main-app asks for, or
 * `undefined` where the venue streams nothing that matches it. The v3 kline
 * topic has no weekly interval and no UTC-aligned variants, and its `1D`
 * bucket opens at 16:00 UTC, so the daily, weekly and 8h channels — which are
 * UTC-aligned by name (`candle1Dutc`) — are left to the REST back-fill.
 */
export const bitgetInverseKlineInterval = (
  channel: string,
): string | undefined =>
  (
    ({
      candle1m: '1m',
      candle3m: '3m',
      candle5m: '5m',
      candle15m: '15m',
      candle30m: '30m',
      candle1H: '1H',
      candle4H: '4H',
    }) as Record<string, string>
  )[channel]

/**
 * Which unit a v3 inverse order reports its quantity in. The venue documents
 * one answer for every category and its request format says another
 * (exchange-connector spec 014 §2.4/§3.4), so the answer is taken from
 * figures that have to agree with each other: an order that has traded
 * reports `cumExecValue` in the currency its quantity is not in. Without
 * fills there is nothing to check against and the request's unit — the
 * contracts — stands.
 */
export const bitgetInverseQtyUnit = (order: {
  cumExecQty?: string
  cumExecValue?: string
  avgPrice?: string
}): 'base' | 'quote' => {
  const qty = parseFloat(`${order.cumExecQty ?? ''}`)
  const value = parseFloat(`${order.cumExecValue ?? ''}`)
  const price = parseFloat(`${order.avgPrice ?? ''}`)
  if (!(qty > 0) || !(value > 0) || !(price > 0)) {
    return 'quote'
  }
  return Math.abs(qty * price - value) <= Math.abs(qty / price - value)
    ? 'base'
    : 'quote'
}

/**
 * Which coin-margined tickers to open on which line. The classic contract
 * listing the price connector builds its markets from kept only the quarterly
 * delivery contracts, so the perpetuals cannot be filtered out of it — they
 * are added from the venue's own v3 listing.
 */
export const splitBitgetCoinmMarkets = (
  classicListing: string[],
  perps: Set<string>,
): { classic: string[]; inverse: string[] } => ({
  classic: classicListing.filter((m) => !perps.has(m)),
  inverse: [...perps],
})
