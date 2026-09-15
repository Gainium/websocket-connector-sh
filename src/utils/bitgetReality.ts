import axios from 'axios'
import logger from './logger'

/**
 * Bitget Reality stock tokens (rAAPL, `RAAPLUSDT`) — which spot symbols they
 * are, and how their candles are streamed.
 *
 * Their candles are only pushed on the v3 `kline` topic, and only at 1m, 5m,
 * 15m, 1H, 4H and 1D. The v2 `candle*` channels accept a subscription for them
 * and then stay silent. Identification comes from the exchange (v3 instruments
 * `isReality`), never from the symbol's spelling.
 */

const TTL_MS = 60 * 60 * 1000
const RETRY_MS = 60 * 1000

let cache: { symbols: Set<string>; at: number; attemptAt: number } = {
  symbols: new Set(),
  at: 0,
  attemptAt: 0,
}

export async function getBitgetRealitySymbols(): Promise<Set<string>> {
  const now = Date.now()
  if (now - cache.at <= TTL_MS || now - cache.attemptAt <= RETRY_MS) {
    return cache.symbols
  }
  cache = { ...cache, attemptAt: now }
  try {
    const res = await axios.get(
      'https://api.bitget.com/api/v3/market/instruments',
      { params: { category: 'SPOT' }, timeout: 30000 },
    )
    const rows = (res.data?.data ?? []) as {
      symbol?: string
      isReality?: string
    }[]
    cache = {
      symbols: new Set(
        rows
          .filter((r) => `${r.isReality}`.toLowerCase() === 'yes' && r.symbol)
          .map((r) => r.symbol as string),
      ),
      at: now,
      attemptAt: now,
    }
  } catch (e) {
    logger.warn(
      `Bitget v3 instruments (Reality symbols) failed: ${(e as Error)?.message}`,
    )
  }
  return cache.symbols
}

/** Test hook. */
export const setBitgetRealitySymbols = (symbols: string[]) => {
  cache = { symbols: new Set(symbols), at: Date.now(), attemptAt: Date.now() }
}

/**
 * The v3 kline interval that serves a v2 candle channel name main-app asks
 * for, or `undefined` when Bitget streams no matching candle for a Reality
 * token. Only 1m/5m/15m/1H/4H qualify: v3 has no 30m or 1W, and its 1D bucket
 * starts at 16:00 UTC while the channel main-app subscribes (`candle1Dutc`)
 * is a UTC-midnight bucket. Closed candles for the rest still reach the
 * indicators through their REST back-fill, which exchange-connector serves
 * aggregated and UTC-aligned.
 */
export const bitgetRealityKlineInterval = (
  channel: string,
): string | undefined =>
  (
    ({
      candle1m: '1m',
      candle5m: '5m',
      candle15m: '15m',
      candle1H: '1H',
      candle4H: '4H',
    }) as Record<string, string>
  )[channel]
