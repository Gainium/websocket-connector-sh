import { WSClientConfigurableOptions } from 'binance'
import { parseBinanceWsFrame } from './losslessOrderId'

/**
 * Give a Binance websocket client a frame parser that keeps venue order ids exact.
 *
 * The vendor client parses every incoming frame with a bare `JSON.parse`
 * (`parseRawWsMessage`, `binance/lib/util/websockets/websocket-util.js:798`), which
 * rounds any integer above 2^53 to the nearest double — so a 19-digit USDM order id
 * reached this connector with its low digits already gone, and distinct orders
 * collapsed onto one id (spec `004.binance-user-stream-order-id-precision-loss.md`).
 *
 * `customParseJSONFn` is the SDK's own supported hook for replacing that parse
 * (`WSClientConfigurableOptions`, `lib/types/websockets/ws-general.d.ts:100`), so
 * this needs no vendored fork of the client — unlike `bybit-custom`, whose SDK
 * offers no such seam. It is the websocket counterpart of the axios
 * `transformResponse` injection that fixed the REST half in `exchange-connector-sh`.
 *
 * Applied per call site rather than by subclassing, so the price/candle connectors
 * (`src/price/binance.ts`) and every other venue are untouched by construction.
 */
export function withLosslessOrderIds(
  options: WSClientConfigurableOptions,
): WSClientConfigurableOptions {
  // A caller that has already chosen its own parser wins — we only supply the default.
  if (options.customParseJSONFn) return options
  return { ...options, customParseJSONFn: parseBinanceWsFrame }
}
