/**
 * WhiteBit shared helpers — pure parsing/mapping plus the one authenticated
 * REST call the private WS handshake needs.
 *
 * WhiteBit ships no npm SDK (spec 003 §2.2), so everything here is written
 * against the venue's documented wire shapes. The functions are deliberately
 * side-effect free (except `fetchWhitebitWsToken`, which is the REST call) so
 * both the public price connector (`src/price/whitebit.ts`) and the private
 * user stream (`src/userStream.ts`) can share them and so the column-order
 * gotchas below can be pinned by tests.
 */

import crypto from 'crypto'
import axios from 'axios'
import { ExchangeEnum } from './common'

/** Single public+private WebSocket endpoint (spec §2.2). */
export const WHITEBIT_WS_URL = 'wss://wss.whitebit.com/ws'

/** Public/private REST base. Only used for the markets list + WS token. */
export const WHITEBIT_REST_URL =
  process.env.WHITEBIT_REST_URL || 'https://whitebit.com'

/**
 * Docs are explicit: send a ping every 50s, the server closes connections idle
 * for 60s. Shared by the public connector and the private stream so both keep
 * exactly one keepalive convention.
 */
export const WHITEBIT_PING_INTERVAL_MS = 50_000

/** `POST /api/v4/profile/websocket_token` — mints the `authorize` token. */
export const WHITEBIT_WS_TOKEN_PATH = '/api/v4/profile/websocket_token'

/**
 * Gainium's canonical interval strings → WhiteBit's `candles_subscribe`
 * interval, which is an **integer number of seconds** — not the `'15m'` string
 * form WhiteBit's own REST kline endpoint takes, and not this repo's
 * `ExchangeIntervals` enum either (spec §2.2).
 *
 * TODO §3.5: this covers every interval WhiteBit's docs list and every member
 * of `ExchangeIntervals`, but the full set WhiteBit accepts was never
 * confirmed against a live subscribe. Anything absent here is skipped with a
 * warning rather than sent — an unsupported value would be rejected on every
 * reconnect and leave the timeframe silently candle-less.
 */
const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '6h': 21600,
  '8h': 28800,
  '12h': 43200,
  '1d': 86400,
  '3d': 259200,
  '1w': 604800,
}

/** Bare-minutes form ("240"), the way Kraken's candle rooms can arrive. */
const MINUTES_TO_INTERVAL: Record<number, string> = {
  1: '1m',
  3: '3m',
  5: '5m',
  15: '15m',
  30: '30m',
  60: '1h',
  120: '2h',
  240: '4h',
  360: '6h',
  480: '8h',
  720: '12h',
  1440: '1d',
  4320: '3d',
  10080: '1w',
}

/**
 * Coerce a candle-room interval to WhiteBit's integer seconds, or null when
 * WhiteBit has no equivalent (caller skips the subscribe and logs).
 */
export const toWhitebitIntervalSeconds = (interval: string): number | null => {
  if (!interval) return null
  const named = /^\d+$/.test(interval)
    ? MINUTES_TO_INTERVAL[Number(interval)]
    : interval.toLowerCase()
  if (!named) return null
  return INTERVAL_SECONDS[named] ?? null
}

/**
 * WhiteBit market names are used verbatim as the Gainium symbol on both sides
 * of the integration (spot `BTC_USDT`, USDⓈ-M perp `BTC_PERP`), so the
 * product family is readable straight off the market string — which is why one
 * connector class serves both variants (plan, Contract decisions).
 */
export const isWhitebitPerpMarket = (market: string): boolean =>
  /_PERP$/i.test(market ?? '')

export const whitebitExchangeForMarket = (
  market: string,
): ExchangeEnum.whitebit | ExchangeEnum.whitebitUsdm =>
  isWhitebitPerpMarket(market)
    ? ExchangeEnum.whitebitUsdm
    : ExchangeEnum.whitebit

export type WhitebitCandle = {
  market: string
  /** Candle open time, epoch **ms** (WhiteBit sends integer seconds). */
  start: number
  open: string
  high: string
  low: string
  close: string
  /** Base-asset volume (`volume_stock`). */
  volume: string
}

/**
 * Parse one `candles_update` row.
 *
 * Column order is `[time, open, close, high, low, volume_stock, volume_money,
 * market]` — **open and close come BEFORE high and low**, the same ordering
 * WhiteBit's REST kline endpoint uses and the opposite of the o/h/l/c order
 * every other venue in this repo sends. Read strictly by index; a copy of
 * another exchange's parser silently swaps close↔high and low↔close and
 * produces candles that look plausible.
 */
export const parseWhitebitCandleRow = (row: unknown): WhitebitCandle | null => {
  if (!Array.isArray(row) || row.length < 8) return null
  const [time, open, close, high, low, volumeStock, , market] = row as [
    number,
    string | number,
    string | number,
    string | number,
    string | number,
    string | number,
    string | number,
    string,
  ]
  if (typeof market !== 'string' || !market) return null
  const seconds = Number(time)
  if (!isFinite(seconds)) return null
  return {
    market,
    start: Math.round(seconds * 1000),
    open: `${open}`,
    high: `${high}`,
    low: `${low}`,
    close: `${close}`,
    volume: `${volumeStock}`,
  }
}

/**
 * `candles_update`'s `params`. The documented shape is a single flat row; a
 * batched form (an array of rows) is accepted too so a batched push is not
 * dropped on the floor.
 */
export const parseWhitebitCandleUpdate = (
  params: unknown,
): WhitebitCandle[] => {
  if (!Array.isArray(params)) return []
  if (Array.isArray(params[0])) {
    return params
      .map((row) => parseWhitebitCandleRow(row))
      .filter((c): c is WhitebitCandle => c !== null)
  }
  const one = parseWhitebitCandleRow(params)
  return one ? [one] : []
}

export type WhitebitTrade = {
  id: number | string
  /** Epoch **ms**. */
  time: number
  price: string
  amount: string
  side: 'buy' | 'sell'
}

/**
 * Parse `trades_update`, whose `params` are `[market, [trade, …]]`.
 *
 * `trade.time` is a **float Unix timestamp in SECONDS** — a different unit
 * convention from the candle channel's integer-seconds `time`, and from the
 * milliseconds every other venue here sends. Converted explicitly rather than
 * by reusing the candle parser's handling.
 */
export const parseWhitebitTradesUpdate = (
  params: unknown,
): { market: string; trades: WhitebitTrade[] } | null => {
  if (!Array.isArray(params) || params.length < 2) return null
  const [market, rawTrades] = params as [string, unknown]
  if (typeof market !== 'string' || !market || !Array.isArray(rawTrades)) {
    return null
  }
  const trades: WhitebitTrade[] = []
  for (const raw of rawTrades) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as {
      id?: number | string
      time?: number | string
      price?: number | string
      amount?: number | string
      type?: string
    }
    const seconds = Number(t.time)
    trades.push({
      id: t.id ?? '',
      time: isFinite(seconds) ? Math.round(seconds * 1000) : Date.now(),
      price: `${t.price ?? 0}`,
      amount: `${t.amount ?? 0}`,
      side: t.type === 'sell' ? 'sell' : 'buy',
    })
  }
  return { market, trades }
}

/**
 * WhiteBit private-REST signing (HMAC-SHA512 over a base64 payload).
 *
 * Duplicated here on purpose rather than imported from `exchange-connector-sh`
 * (plan, Build order step 2): the two repos share no dependency, and ~20 lines
 * of signing is cheaper than inventing a cross-repo one.
 */
export const signWhitebitRequest = (
  secret: string,
  body: Record<string, unknown>,
): { payload: string; signature: string; json: string } => {
  const json = JSON.stringify(body)
  const payload = Buffer.from(json).toString('base64')
  const signature = crypto
    .createHmac('sha512', secret)
    .update(payload)
    .digest('hex')
  return { payload, signature, json }
}

/**
 * Mint a WebSocket `authorize` token.
 *
 * TODO §3.6: the token's lifetime, whether it is single-use and whether it
 * survives a reconnect are all unconfirmed. Callers therefore mint a FRESH
 * token on every connect and reconnect — the safe default. Once the lifetime
 * is confirmed this can cache and reuse a still-valid token instead of paying
 * a signed REST round trip per reconnect.
 */
export const fetchWhitebitWsToken = async (
  apiKey: string,
  apiSecret: string,
  timeoutMs = 10_000,
): Promise<string> => {
  const body = {
    request: WHITEBIT_WS_TOKEN_PATH,
    nonce: `${Date.now()}`,
    nonceWindow: true,
  }
  const { payload, signature, json } = signWhitebitRequest(apiSecret, body)
  const res = await axios.post<Record<string, unknown>>(
    `${WHITEBIT_REST_URL}${WHITEBIT_WS_TOKEN_PATH}`,
    json,
    {
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'X-TXC-APIKEY': apiKey,
        'X-TXC-PAYLOAD': payload,
        'X-TXC-SIGNATURE': signature,
      },
    },
  )
  const data = (res.data ?? {}) as Record<string, any>
  // Read defensively: the response envelope was not part of the confirmed
  // excerpt (see TODO §3.6), only that this endpoint is what mints the token.
  const token =
    data.websocket_token ?? data.token ?? data.result?.websocket_token
  if (typeof token !== 'string' || !token) {
    throw new Error(
      `WhiteBit websocket_token response carried no token (keys: ${Object.keys(
        data,
      ).join(',')})`,
    )
  }
  return token
}

/**
 * `ordersExecuted_update.side` is NUMERIC on WhiteBit: **1 = sell, 2 = buy**.
 *
 * Checked against this repo's existing normalizers before mapping (spec §3.7):
 * every branch in `userStream.ts` emits the `'BUY'`/`'SELL'` strings of
 * `OrderSide_LT`, and the one other venue with a numeric side — Kraken
 * Futures' `open_orders`, `order.direction === 1 ? 'BUY' : 'SELL'` — uses the
 * OPPOSITE polarity. So this must not be copied from there.
 */
export const whitebitSideToOrderSide = (side: unknown): 'BUY' | 'SELL' =>
  Number(side) === 1 ? 'SELL' : 'BUY'
