import { WebsocketClient as KrakenWsClient } from '@siebly/kraken-api'
import { ExchangeEnum, mapPaperToReal } from '../utils/common'
import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'
import CommonConnector from './common'
import getAllExchangeInfo, {
  getKrakenSymbolMaps,
  type KrakenSymbolMap,
} from '../utils/exchange'
import sleep from '../utils/sleep'

import type { Ticker, StreamType, SubscribeCandlePayload } from './types'

const mutex = new IdMutex()

const isDemo = process.env.KRAKEN_ENV === 'demo'

const maxSubsPerClient = 200 // Conservative limit for Kraken

const chunkSize = 100 // Symbols per subscription request

// Kraken's candle OHLC feed is trade-driven (no periodic kline frames), so thin
// markets legitimately go quiet well past the default candle timeout. Widen the
// stall window for Kraken; the connection-liveness check (isFeedAlive) is the
// real "is this feed dead" signal.
const krakenCandleTradeTimeout = 180000

// wsKey the kraken-api client uses per product family (matches the `subscribe`
// calls below); also what `isConnected(wsKey)` is queried with.
const spotWsKey = 'spotPublicV2'
const derivativesWsKey = 'derivativesPublicV1'

// A Kraken venue outage repeats the SAME exception per client until it clears —
// the derivatives engine answers every connect/subscribe with
// {"event":"alert","message":"Trading engine unavailable"}, and a failing
// connect re-emits through parseWsError on each retry. Unthrottled that is
// ~100 identical lines/min per client, which was 100% of the candle- and
// price-stream error output during the outage and pushed a full day of
// unrelated errors out of the pm2 buffer. Collapse identical payloads to one
// line per window, carrying the hidden count so a storm stays visible as a
// number rather than as thousands of duplicate lines.
const logThrottleWindowMs = 30_000
const maxThrottleKeys = 200

const throttleState = new Map<string, { first: number; hidden: number }>()

/**
 * Call `emit` at most once per `logThrottleWindowMs` for a given `key`. Repeats
 * inside the window are counted and reported on the next emission.
 */
const logThrottled = (key: string, emit: (suffix: string) => void) => {
  const now = Date.now()
  const state = throttleState.get(key)

  if (state && now - state.first < logThrottleWindowMs) {
    state.hidden++
    return
  }

  if (!state && throttleState.size >= maxThrottleKeys) {
    // Bound memory in case payloads ever vary: drop fully elapsed windows.
    for (const [k, v] of throttleState) {
      if (now - v.first >= logThrottleWindowMs) {
        throttleState.delete(k)
      }
    }
  }

  const hidden = state?.hidden ?? 0
  throttleState.set(key, { first: now, hidden: 0 })
  // Count is reported relative to the previous emitted line rather than to a
  // fixed window: once a storm stops, its trailing remainder is only flushed by
  // the next occurrence, which can be hours later.
  emit(hidden ? ` (+${hidden} identical since the previous line)` : '')
}

// Kraken spot OHLC (WS v2) only accepts these interval values, and only as a
// JSON *number* — a numeric string ("240") is rejected with "Subscription ohlc
// interval must be an integer", both on the initial subscribe and on every
// auto-resubscribe after reconnect (the client replays the cached payload
// verbatim). Intervals arrive here as strings from the candle room name.
const KRAKEN_SPOT_OHLC_INTERVALS = new Set([
  1, 5, 15, 30, 60, 240, 1440, 10080, 21600,
])

// Named-interval fallback ("1h") → Kraken minutes, in case a caller ever sends
// the generic ExchangeIntervals form instead of minutes. Unsupported values
// (2h, 8h, …) are deliberately absent — better to skip than spam rejections.
const NAMED_TO_KRAKEN_MINUTES: Record<string, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10080,
}

/** Coerce an interval string to a Kraken-supported integer, or null. */
const toKrakenSpotInterval = (interval: string): number | null => {
  const n = /^\d+$/.test(interval)
    ? Number(interval)
    : NAMED_TO_KRAKEN_MINUTES[interval]
  return n !== undefined && KRAKEN_SPOT_OHLC_INTERVALS.has(n) ? n : null
}

type KrakenClient = {
  client: KrakenWsClient
  subs: number
  id: number
}[]

// Kraken spot allows only ONE ohlc interval per symbol per CONNECTION. Asking
// for a second timeframe on a symbol that already has one is answered with
// {"error":"Already subscribed to one ohlc interval on this symbol"} and that
// timeframe then receives no candles at all — silently, because the room was
// already recorded as subscribed. So spot candle sockets are pooled PER
// INTERVAL and never shared across intervals, with the usual per-client
// subscription cap on top (one interval can still hold plenty of symbols).
type KrakenCandleClient = {
  client: KrakenWsClient
  subs: number
  interval: number
  // wsnames awaiting a subscribe ack, oldest first. Kraken answers subscribes
  // in order on a connection and we subscribe one symbol at a time, so the head
  // of this queue identifies what a rejection refers to — the error payload
  // itself carries only a req_id, which is why the prod log was 24 identical
  // unactionable lines.
  pending: { room: string; wsname: string }[]
}

class KrakenConnector extends CommonConnector {
  private krakenSpotClients: KrakenClient = []
  private krakenUsdmClients: KrakenClient = []
  private krakenSpotCandleClients: KrakenCandleClient[] = []
  private krakenUsdmCandleClient: KrakenWsClient | null = null
  private spotSymbolMaps: KrakenSymbolMap = {
    wsnameToNormalized: new Map(),
    normalizedToWsname: new Map(),
    assetNameMap: new Map(),
  }
  private usdmSymbolMaps: KrakenSymbolMap = {
    wsnameToNormalized: new Map(),
    normalizedToWsname: new Map(),
    assetNameMap: new Map(),
  }
  // In-flight symbol-map load, so a burst of candle subscribes at boot triggers
  // one REST round trip instead of one per symbol.
  private symbolMapsReady: Promise<void> | null = null

  /**
   * Resolve the symbol maps before anything reads them.
   *
   * `init()` loads the maps, but it is fire-and-forget (`service.ts` calls
   * `str.init()` without awaiting) while the constructor already subscribes to
   * `subscribeCandle` messages from main-app. Candle requests therefore land
   * while the maps are still the empty ones from the field initializer — a
   * ~0.2-2.0s window that prod hits on every restart.
   */
  private async ensureSymbolMaps(): Promise<void> {
    if (
      this.spotSymbolMaps.normalizedToWsname.size &&
      this.usdmSymbolMaps.normalizedToWsname.size
    ) {
      return
    }
    if (!this.symbolMapsReady) {
      // Cleared on settle so a failed load (Kraken REST blip) is retried by the
      // next subscribe rather than poisoning every later lookup.
      this.symbolMapsReady = this.loadSymbolMaps().finally(() => {
        this.symbolMapsReady = null
      })
    }
    await this.symbolMapsReady
  }

  private async loadSymbolMaps(): Promise<void> {
    logger.info('Kraken Worker | Loading symbol maps...')
    this.spotSymbolMaps = await getKrakenSymbolMaps(ExchangeEnum.kraken)
    this.usdmSymbolMaps = await getKrakenSymbolMaps(ExchangeEnum.krakenUsdm)
    logger.info(
      `Kraken Worker | Symbol maps loaded: ${this.spotSymbolMaps.wsnameToNormalized.size} spot, ${this.usdmSymbolMaps.wsnameToNormalized.size} usdm`,
    )
  }

  /**
   * Forget a candle room so main-app's next `candlesRequests` message
   * re-subscribes it — same reasoning as the rejected-subscribe handler in
   * `getSpotCandleClient`: a room left in the set is "active" forever while the
   * timeframe is silently dead.
   */
  private dropCandleRoom(room: string, futures = false) {
    const exchanges = futures
      ? [ExchangeEnum.krakenUsdm, ExchangeEnum.paperKrakenUsdm]
      : [ExchangeEnum.kraken, ExchangeEnum.paperKraken]
    for (const ex of exchanges) {
      this.subscribedCandlesMap.get(ex)?.delete(room)
    }
  }

  constructor(
    private subscribedCandlesMap: Map<ExchangeEnum, Set<string>> = new Map(),
  ) {
    super()
    this.mainData = {
      [ExchangeEnum.kraken]: this.base,
      [ExchangeEnum.krakenUsdm]: this.base,
    }
    logger.info(`Kraken Worker | >🚀 Price <-> Backend stream`)
  }

  private getKrakenClient(
    type: StreamType,
    isFutures: boolean = false,
    current?: KrakenWsClient,
    // Appended to this client's log lines (e.g. ` interval=240`) so a candle
    // socket's messages say WHICH timeframe they belong to.
    label: string = '',
    // Called for a `method:"subscribe"` failure to resolve the offending
    // (symbol, interval) — the Kraken payload only carries a req_id. Returns
    // extra text appended to the single error line.
    describeSubscribeError?: () => string,
  ) {
    if (current) {
      current.closeAll(true)
      current.removeAllListeners()
    }

    const client = new KrakenWsClient(
      {
        ...(isFutures && isDemo && { testnet: true }),
        // Every other connector (binance/bybit/okx/bitget) passes the shared
        // `wsReconnect` delay; Kraken never did, so it silently ran on the
        // kraken-api default of 500 ms — 7x more aggressive than the rest of
        // the platform. During a venue outage that is ~2 reconnect attempts a
        // second per client, on every node. Use the same knob as the others.
        reconnectTimeout: this.wsReconnect,
      },
      {
        trace: () => null,
        info: () => null,
        error: () => null,
      },
    )

    const tag = `Kraken ${isFutures ? 'futures' : 'spot'} ${type}${label}`

    client.on('open', (data) => {
      logger.info(`${tag} opened ${data.wsKey}`)
    })

    client.on('reconnected', (data) => {
      const line = `${tag} reconnected ${data?.wsKey}`
      logThrottled(`reconnected|${line}`, (suffix) =>
        logger.info(`${line}${suffix}`),
      )
    })

    client.on('exception', (data) => {
      const extra =
        data?.method === 'subscribe' && describeSubscribeError
          ? describeSubscribeError()
          : ''
      const line = `${tag} exception: ${JSON.stringify(data)}${extra}`
      logThrottled(`exception|${line}`, (suffix) =>
        logger.error(`${line}${suffix}`),
      )
    })

    return client
  }

  private convertKrakenTicker(msg: any, exchange: ExchangeEnum): Ticker[] {
    // Kraken ticker format varies between spot and futures
    // Spot: { channel: 'ticker', type: 'snapshot', data: [...] }
    // Futures: { channel: 'ticker', type: 'snapshot', product_ids: [...], tickers: [...] }

    if (!msg.data && !msg.tickers) {
      return []
    }

    const tickers = msg.data || msg.tickers || []
    const symbolMaps =
      exchange === ExchangeEnum.kraken
        ? this.spotSymbolMaps
        : this.usdmSymbolMaps

    return tickers.map((ticker: any) => {
      const wsname = ticker.symbol || ticker.product_id || ''
      // Convert wsname to normalized symbol (BTC/USD -> BTCUSD)
      const symbol = symbolMaps.wsnameToNormalized.get(wsname) || wsname

      return {
        eventType: '24hrTicker',
        eventTime: ticker.timestamp ? +new Date(ticker.timestamp) : Date.now(),
        symbol,
        curDayClose: ticker.last || ticker.last_price || '0',
        bestBid: ticker.bid || ticker.best_bid || ticker.last || '0',
        bestBidQnt: ticker.bid_qty || ticker.bid_size || '0',
        bestAsk: ticker.ask || ticker.best_ask || ticker.last || '0',
        bestAskQnt: ticker.ask_qty || ticker.ask_size || '0',
        open: ticker.open || ticker.open_24h || '0',
        high: ticker.high || ticker.high_24h || '0',
        low: ticker.low || ticker.low_24h || '0',
        volume: ticker.volume || ticker.volume_24h || '0',
        volumeQuote: ticker.volumeQuote || ticker.volume_quote || '0',
      }
    })
  }

  private krakenTickerCb(exchange: ExchangeEnum) {
    return (msg: any) => {
      if (
        msg.channel === 'ticker' &&
        (msg.type === 'snapshot' || msg.type === 'update')
      ) {
        const tickers = this.convertKrakenTicker(msg, exchange)
        if (tickers.length) {
          this.cbWs(tickers, exchange)
        }
      } else if (msg.feed === 'ticker') {
        if (
          !(msg?.product_id ?? '').startsWith('PI') &&
          !(msg?.product_id ?? '').startsWith('PF')
        ) {
          return
        }
        const symbolMaps =
          exchange === ExchangeEnum.kraken
            ? this.spotSymbolMaps
            : this.usdmSymbolMaps

        this.cbWs(
          [
            {
              eventType: '24hrTicker',
              eventTime: msg.time ? +new Date(msg.time) : Date.now(),
              symbol:
                symbolMaps.wsnameToNormalized.get(msg.product_id) ||
                msg.product_id ||
                '',
              curDayClose: msg.last,
              bestBid: msg.bid,
              bestBidQnt: msg.bid_size,
              bestAsk: msg.ask,
              bestAskQnt: msg.ask_size,
              open: msg.last,
              high: msg.high,
              low: msg.low,
              volume: msg.volume,
              volumeQuote: msg.volumeQuote,
            },
          ],
          exchange,
        )
      }
    }
  }

  private krakenCandleCb(exchange: ExchangeEnum) {
    return (msg: any) => {
      const symbolMaps =
        exchange === ExchangeEnum.kraken
          ? this.spotSymbolMaps
          : this.usdmSymbolMaps

      // Spot OHLC format: { channel: 'ohlc', data: [...] }
      if (msg.channel === 'ohlc' && msg.data) {
        for (const candle of msg.data) {
          const wsname = candle.symbol
          // Convert wsname to normalized symbol
          const symbol = symbolMaps.wsnameToNormalized.get(wsname) || wsname

          this.cbWsTrade(
            {
              e: 'kline',
              E: Date.now(),
              s: symbol,
              k: {
                o: candle.open || '0',
                h: candle.high || '0',
                l: candle.low || '0',
                c: candle.close || '0',
                v: candle.volume || '0',
                i: candle.interval || msg.interval || '1m',
                t: candle.timestamp ? +new Date(candle.timestamp) : Date.now(),
              },
            },
            exchange,
          )
        }
      }
      // Futures candles_trade format: { feed: 'candles_trade_1m', candle: {...} }
      else if (msg.feed?.startsWith('candles_trade_') && msg.candle) {
        const { time, open, high, low, close, volume } = msg.candle
        const product_id = msg.product_id || ''
        // Convert product_id to normalized symbol
        const symbol =
          symbolMaps.wsnameToNormalized.get(product_id) || product_id

        // Extract interval from feed name (e.g., 'candles_trade_1m' -> '1m')
        const interval = msg.feed.replace('candles_trade_', '')

        this.cbWsTrade(
          {
            e: 'kline',
            E: Date.now(),
            s: symbol,
            k: {
              o: open || '0',
              h: high || '0',
              l: low || '0',
              c: close || '0',
              v: volume || '0',
              i: interval,
              t: time ? +new Date(time) : Date.now(),
            },
          },
          exchange,
        )
      }
    }
  }

  override subscribeCandleCb({
    symbol,
    exchange: _exchange,
    interval,
  }: SubscribeCandlePayload) {
    if (!this.isCandle && !this.isAll) {
      return
    }
    const exchange = mapPaperToReal(_exchange, false)
    const data = this.getCandleRoomName(symbol, exchange, interval)
    const set = this.subscribedCandlesMap.get(exchange) ?? new Set()
    let process = false
    if (!set.has(data)) {
      set.add(data)
      this.subscribedCandlesMap.set(exchange, set)
      process = true
    }
    if (process) {
      if ([ExchangeEnum.kraken, ExchangeEnum.paperKraken].includes(exchange)) {
        // Spot: use OHLC WebSocket channel
        this.connectKrakenCandleStream(symbol, interval).catch((e) => {
          // The symbol-map load failed; drop the room so the next
          // `candlesRequests` retries instead of it sitting silently dead.
          this.dropCandleRoom(data)
          logger.error(
            `Kraken spot candle subscribe failed for ${symbol} at interval ${interval}: ${(e as Error)?.message ?? e}`,
          )
        })
      } else if (
        [ExchangeEnum.krakenUsdm, ExchangeEnum.paperKrakenUsdm].includes(
          exchange,
        )
      ) {
        // USDM Futures: use candles_trade WebSocket channel
        this.connectKrakenFuturesCandleStream(
          symbol,
          interval,
          ExchangeEnum.krakenUsdm,
        ).catch((e) => {
          this.dropCandleRoom(data, true)
          logger.error(
            `Kraken futures candle subscribe failed for ${symbol} at interval ${interval}: ${(e as Error)?.message ?? e}`,
          )
        })
      }
    }
  }

  private async connectKrakenCandleStream(symbol: string, interval: string) {
    // Kraken rejects non-integer intervals; an invalid value would also be
    // replayed (and re-rejected) on every reconnect, so drop it up front.
    const krakenInterval = toKrakenSpotInterval(interval)
    if (krakenInterval === null) {
      logger.warn(
        `Kraken spot candle: unsupported interval "${interval}" for ${symbol}, skipping OHLC subscribe`,
      )
      return
    }

    // Convert normalized symbol to wsname format for subscription. The maps
    // must be loaded first: falling back to the normalized symbol sends Kraken
    // a dash pair, which it always rejects with "Currency pair not in ISO
    // 4217-A3 format BTC-USD". The ws client caches the subscribe and replays
    // it on every reconnect, so a single miss at boot leaves that timeframe
    // permanently candle-less.
    await this.ensureSymbolMaps()
    const wsnameSymbol = this.spotSymbolMaps.normalizedToWsname.get(symbol)
    if (!wsnameSymbol) {
      logger.warn(
        `Kraken spot candle: no wsname for "${symbol}" at interval ${interval}, skipping OHLC subscribe`,
      )
      return
    }

    // One socket per interval — sharing one across intervals is what Kraken
    // rejects, leaving the extra timeframes without candles.
    const entry = this.getSpotCandleClient(krakenInterval)

    entry.pending.push({
      room: this.getCandleRoomName(symbol, ExchangeEnum.kraken, interval),
      wsname: wsnameSymbol,
    })
    entry.subs++

    // Subscribe to ohlc for the symbol (spot only)
    entry.client.subscribe(
      [
        {
          topic: 'ohlc',
          payload: { symbol: [wsnameSymbol], interval: krakenInterval },
        },
      ],
      spotWsKey,
    )
  }

  /**
   * Pick (or open) the spot candle socket that owns `interval`. Never returns a
   * client already carrying a different interval — that is the whole point.
   */
  private getSpotCandleClient(interval: number): KrakenCandleClient {
    const existing = this.krakenSpotCandleClients.find(
      (c) => c.interval === interval && c.subs < maxSubsPerClient,
    )
    if (existing) {
      return existing
    }

    const pending: KrakenCandleClient['pending'] = []

    const client = this.getKrakenClient(
      'candle',
      false,
      undefined,
      ` interval=${interval}`,
      () => {
        const failed = pending.shift()
        if (!failed) {
          return ''
        }
        // A rejected subscribe never delivers a single candle, so stop
        // remembering the room as subscribed: otherwise it stays "active"
        // forever while the timeframe is silently dead, and every candle-stall
        // restart replays it into the same rejection. Dropping it lets
        // main-app's next `candlesRequests` message re-subscribe it.
        this.dropCandleRoom(failed.room)
        return ` — rejected ohlc subscribe for ${failed.wsname} at interval ${interval}; dropped from the subscribed set so it is retried`
      },
    )

    client.on('message', this.krakenCandleCb(ExchangeEnum.kraken))

    client.on('response', (data) => {
      if (data?.method !== 'subscribe' || !data?.success || !pending.length) {
        return
      }
      const wsname = data?.result?.symbol
      const i = pending.findIndex((p) => p.wsname === wsname)
      pending.splice(i >= 0 ? i : 0, 1)
    })

    const entry: KrakenCandleClient = { client, subs: 0, interval, pending }
    this.krakenSpotCandleClients.push(entry)
    return entry
  }

  private async connectKrakenFuturesCandleStream(
    symbol: string,
    interval: string,
    exchange: ExchangeEnum.krakenUsdm,
  ) {
    // Convert normalized symbol to wsname format (e.g., BTC-USD -> PF_XBTUSD).
    // Resolved before opening the socket, and never falls back to the raw
    // symbol: Kraken answers an unmapped product with "Couldn't subscribe to
    // invalid product SOL-USD".
    await this.ensureSymbolMaps()
    const wsnameSymbol = this.usdmSymbolMaps.normalizedToWsname.get(symbol)
    if (!wsnameSymbol) {
      logger.warn(
        `Kraken futures candle: no product id for "${symbol}" at interval ${interval}, skipping candles_trade subscribe`,
      )
      return
    }

    const client = this.krakenUsdmCandleClient

    if (!client) {
      const newClient = this.getKrakenClient('candle', true)
      newClient.on('message', this.krakenCandleCb(exchange))

      this.krakenUsdmCandleClient = newClient
    }

    // Subscribe to candles_trade feed
    const feed = `candles_trade_${interval}`
    const targetClient = this.krakenUsdmCandleClient!

    targetClient.subscribe(
      [
        {
          // @ts-expect-error undocumented feed
          topic: feed,
          payload: {
            product_ids: [wsnameSymbol],
          },
        },
      ],
      'derivativesPublicV1',
    )
  }

  @IdMute(mutex, () => 'initKrakenWS')
  async init() {
    try {
      // Load symbol maps before initializing websocket connections. Shares the
      // in-flight load with any candle subscribe that raced ahead of init().
      await this.ensureSymbolMaps()

      if (!this.isCandle || this.isAll) {
        await this.initKrakenSpotWS()
        await this.initKrakenUsdmWS()
      }
      if (this.isCandle || this.isAll) {
        // Initialize candle streams for already subscribed symbols
        for (const [exchange, symbols] of this.subscribedCandlesMap) {
          if (
            [ExchangeEnum.kraken, ExchangeEnum.paperKraken].includes(exchange)
          ) {
            for (const data of symbols) {
              const [symbol, interval] = this.splitCandleRoomName(data)
              await this.connectKrakenCandleStream(symbol, interval)
            }
          } else if (
            [ExchangeEnum.krakenUsdm, ExchangeEnum.paperKrakenUsdm].includes(
              exchange,
            )
          ) {
            for (const data of symbols) {
              const [symbol, interval] = this.splitCandleRoomName(data)
              await this.connectKrakenFuturesCandleStream(
                symbol,
                interval,
                ExchangeEnum.krakenUsdm,
              )
            }
          }
        }
      }
    } catch (e) {
      logger.error(`Kraken init error: ${(e as Error)?.message ?? e}`)
      throw e
    }
  }

  private async initKrakenSpotWS() {
    const symbols = await getAllExchangeInfo(ExchangeEnum.kraken)

    if (!symbols.length) {
      logger.warn('No Kraken spot symbols found, skipping subscription')
      return
    }
    // Convert normalized symbols to wsname format for subscription
    const wsnameSymbols = symbols
      .map(
        (symbol) =>
          this.spotSymbolMaps.normalizedToWsname.get(symbol) || symbol,
      )
      .filter(Boolean)

    // Split symbols into chunks
    const chunks = wsnameSymbols.reduce((acc, symbol, index) => {
      const chunkIndex = Math.floor(index / chunkSize)
      if (!acc[chunkIndex]) {
        acc[chunkIndex] = []
      }
      acc[chunkIndex].push(symbol)
      return acc
    }, [] as string[][])

    let i = 0
    for (const chunk of chunks) {
      // Find existing client with available capacity
      const existingClient = this.krakenSpotClients
        .filter((c) => c.subs < maxSubsPerClient)
        .sort((a, b) => b.subs - a.subs)[0]

      if (existingClient) {
        existingClient.client.subscribe(
          [{ topic: 'ticker', payload: { symbol: chunk } }],
          'spotPublicV2',
        )
        existingClient.subs += chunk.length
        this.krakenSpotClients = this.krakenSpotClients.map((c) =>
          c.id === existingClient.id ? { ...existingClient } : c,
        )
      } else {
        // Create new client
        const newClient = this.getKrakenClient('ticker', false)
        newClient.on('message', this.krakenTickerCb(ExchangeEnum.kraken))

        newClient.subscribe(
          [{ topic: 'ticker', payload: { symbol: chunk } }],
          'spotPublicV2',
        )

        const lastId =
          this.krakenSpotClients.sort((a, b) => b.id - a.id)[0]?.id ?? 0
        this.krakenSpotClients.push({
          client: newClient,
          subs: chunk.length,
          id: lastId + 1,
        })
      }

      i++
      logger.info(
        `Subscribed to chunk ${i} of ${chunks.length} Kraken spot markets`,
      )
      await sleep(500)
    }

    logger.info(
      `Subscribed to ${symbols.length} Kraken spot markets across ${this.krakenSpotClients.length} connections`,
    )
  }

  private async initKrakenUsdmWS() {
    const symbols = await getAllExchangeInfo(ExchangeEnum.krakenUsdm)

    if (!symbols.length) {
      logger.warn('No Kraken USDM symbols found, skipping subscription')
      return
    }

    // Convert normalized symbols to wsname format for subscription
    const wsnameSymbols = symbols
      .map(
        (symbol) =>
          this.usdmSymbolMaps.normalizedToWsname.get(symbol) || symbol,
      )
      .filter(Boolean)

    // Split symbols into chunks
    const chunks = wsnameSymbols.reduce((acc, symbol, index) => {
      const chunkIndex = Math.floor(index / chunkSize)
      if (!acc[chunkIndex]) {
        acc[chunkIndex] = []
      }
      acc[chunkIndex].push(symbol)
      return acc
    }, [] as string[][])

    let i = 0
    for (const chunk of chunks) {
      // Find existing client with available capacity
      const existingClient = this.krakenUsdmClients
        .filter((c) => c.subs < maxSubsPerClient)
        .sort((a, b) => b.subs - a.subs)[0]

      if (existingClient) {
        existingClient.client.subscribe(
          [{ topic: 'ticker', payload: { product_ids: chunk } }],
          'derivativesPublicV1',
        )
        existingClient.subs += chunk.length
        this.krakenUsdmClients = this.krakenUsdmClients.map((c) =>
          c.id === existingClient.id ? { ...existingClient } : c,
        )
      } else {
        // Create new client
        const newClient = this.getKrakenClient('ticker', true)
        newClient.on('message', this.krakenTickerCb(ExchangeEnum.krakenUsdm))

        newClient.subscribe(
          [{ topic: 'ticker', payload: { product_ids: chunk } }],
          'derivativesPublicV1',
        )

        const lastId =
          this.krakenUsdmClients.sort((a, b) => b.id - a.id)[0]?.id ?? 0
        this.krakenUsdmClients.push({
          client: newClient,
          subs: chunk.length,
          id: lastId + 1,
        })
      }

      i++
      logger.info(
        `Subscribed to chunk ${i} of ${chunks.length} Kraken USDM markets`,
      )
      await sleep(500)
    }

    logger.info(
      `Subscribed to ${symbols.length} Kraken USDM markets across ${this.krakenUsdmClients.length} connections`,
    )
  }

  /**
   * Recreate just the candle WS client for the stalled product family and
   * re-subscribe every tracked candle topic, without touching ticker sockets or
   * crashing the whole worker. Used for targeted stall recovery.
   */
  private restartKrakenCandleStreams(exchange: ExchangeEnum) {
    const isUsdm = [
      ExchangeEnum.krakenUsdm,
      ExchangeEnum.paperKrakenUsdm,
    ].includes(exchange)

    if (isUsdm) {
      if (this.krakenUsdmCandleClient) {
        this.krakenUsdmCandleClient.closeAll(true)
        this.krakenUsdmCandleClient.removeAllListeners()
        this.krakenUsdmCandleClient = null
      }
    } else {
      for (const c of this.krakenSpotCandleClients) {
        c.client.closeAll(true)
        c.client.removeAllListeners()
      }
      this.krakenSpotCandleClients = []
    }

    for (const [ex, symbols] of this.subscribedCandlesMap) {
      if (
        !isUsdm &&
        [ExchangeEnum.kraken, ExchangeEnum.paperKraken].includes(ex)
      ) {
        for (const data of symbols) {
          const [symbol, interval] = this.splitCandleRoomName(data)
          this.connectKrakenCandleStream(symbol, interval)
        }
      } else if (
        isUsdm &&
        [ExchangeEnum.krakenUsdm, ExchangeEnum.paperKrakenUsdm].includes(ex)
      ) {
        for (const data of symbols) {
          const [symbol, interval] = this.splitCandleRoomName(data)
          this.connectKrakenFuturesCandleStream(
            symbol,
            interval,
            ExchangeEnum.krakenUsdm,
          )
        }
      }
    }
  }

  /**
   * Connection-liveness signal used to suppress false-positive stalls. Kraken's
   * candle/ticker feeds only push on trades, so a quiet thin market looks
   * stalled while the socket is alive. `isConnected(wsKey)` reflects the real
   * socket state (kept alive by the client's heartbeat/pong, reconnected when
   * dead), so a CONNECTED socket means "alive, just quiet", not a stall.
   */
  protected override isFeedAlive(
    exchange: ExchangeEnum,
    kind: 'price' | 'candle',
  ): boolean {
    const isUsdm = exchange === ExchangeEnum.krakenUsdm
    if (kind === 'candle') {
      if (isUsdm) {
        return !!this.krakenUsdmCandleClient?.isConnected(derivativesWsKey)
      }
      // Spot candles are spread over one socket per interval; any live socket
      // means the feed is alive (just quiet on the others).
      return this.krakenSpotCandleClients.some((c) =>
        c.client.isConnected(spotWsKey),
      )
    }
    const clients = isUsdm ? this.krakenUsdmClients : this.krakenSpotClients
    const wsKey = isUsdm ? derivativesWsKey : spotWsKey
    return clients.some((c) => c.client.isConnected(wsKey))
  }

  /**
   * Recover a candle stall by restarting only the affected Kraken candle stream
   * instead of crashing the whole worker (which drops every other exchange's
   * candle streams too). Ticker/connect stalls fall through to the full-worker
   * restart. `CommonConnector` bounds how many times this runs before escalating
   * to the old throw-based restart.
   */
  protected override handleStall(
    exchange: ExchangeEnum,
    kind: 'price' | 'candle' | 'connect',
  ): boolean {
    if (kind !== 'candle') {
      return false
    }
    logger.info(
      `Kraken ${exchange} candle stall — targeted candle-stream restart (no full-worker crash)`,
    )
    this.restartKrakenCandleStreams(exchange)
    return true
  }

  protected override getTradeTimeout(_exchange: ExchangeEnum): number {
    return Math.max(this.tradeTimeout, krakenCandleTradeTimeout)
  }

  override stop() {
    super.stop()
    this.krakenSpotClients.forEach((k) => {
      k.client.closeAll(true)
      k.client.removeAllListeners()
    })
    this.krakenUsdmClients.forEach((k) => {
      k.client.closeAll(true)
      k.client.removeAllListeners()
    })
    this.krakenSpotCandleClients.forEach((k) => {
      k.client.closeAll(true)
      k.client.removeAllListeners()
    })
    if (this.krakenUsdmCandleClient) {
      this.krakenUsdmCandleClient.closeAll(true)
      this.krakenUsdmCandleClient.removeAllListeners()
    }
  }
}

export default KrakenConnector
