import { ExchangeEnum, mapPaperToReal } from '../utils/common'
import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'
import getAllExchangeInfo from '../utils/exchange'
import {
  parseWhitebitCandleUpdate,
  parseWhitebitTradesUpdate,
  toWhitebitIntervalSeconds,
  whitebitExchangeForMarket,
} from '../utils/whitebit'
import WhitebitWsClient from '../utils/whitebitWsClient'
import CommonConnector from './common'

import type { SubscribeCandlePayload } from './types'

const mutex = new IdMutex()

/**
 * WhiteBit price/candle connector — spot (`whitebit`) and USDⓈ-M perps
 * (`whitebitUsdm`) in ONE class, because both live on the same endpoint and the
 * product family is readable straight off the market name (`BTC_USDT` vs
 * `BTC_PERP`). Two classes would duplicate the whole connection/ping/reconnect
 * plumbing for nothing (plan, Contract decisions).
 *
 * Hand-rolled on the Hyperliquid pattern (`utils/hyperliquidUserClient.ts`),
 * not the Kraken pattern: WhiteBit ships no SDK to delegate the connection
 * lifecycle to. All the socket mechanics live in `utils/whitebitWsClient.ts`;
 * this file is only market data → the existing `cbWs` / `cbWsTrade`
 * republishers on `CommonConnector`, so the Redis channel names
 * (`trade@{symbol}@{exchange}`, `{symbol}@{exchange}@{interval}Candle`) come
 * from the shared base class and are never rebuilt here.
 */
class WhitebitConnector extends CommonConnector {
  /**
   * One socket carrying every market's `trades_subscribe`. WhiteBit replaces a
   * channel's subscription on each `_subscribe` call, so the full market array
   * is re-sent whenever it changes (and on every reconnect).
   */
  private tradesClient: WhitebitWsClient | null = null
  private tradeMarkets: string[] = []

  /**
   * Candle sockets, one per `(market, interval)` room.
   *
   * `candles_subscribe` takes a SINGLE `[market, intervalSeconds]` pair, and
   * this protocol's `_subscribe` calls replace the channel's previous
   * subscription on that connection rather than adding to it — so, unlike the
   * trades channel, candle rooms cannot share a socket.
   *
   * TODO (open question, beyond spec §3): whether a single connection can in
   * fact hold several candle subscriptions was never confirmed against the
   * live venue. One socket per room is the safe reading; if it turns out
   * several subscriptions coexist, pool them the way `price/kraken.ts` pools
   * per interval, because this is the expensive shape.
   */
  private candleClients: Map<string, WhitebitWsClient> = new Map()

  constructor(
    private subscribedCandlesMap: Map<ExchangeEnum, Set<string>> = new Map(),
  ) {
    super()
    // Spread rather than share `this.base`: the two families must age
    // independently in the watchdog.
    this.mainData = {
      [ExchangeEnum.whitebit]: { ...this.base },
      [ExchangeEnum.whitebitUsdm]: { ...this.base },
    }
    logger.info(`WhiteBit Worker | >🚀 Price <-> Backend stream`)
  }

  @IdMute(mutex, () => 'initWhitebitWS')
  async init() {
    try {
      if (!this.isCandle || this.isAll) {
        await this.initTradesWS()
      }
      if (this.isCandle || this.isAll) {
        for (const [exchange, rooms] of this.subscribedCandlesMap) {
          if (
            ![
              ExchangeEnum.whitebit,
              ExchangeEnum.whitebitUsdm,
              ExchangeEnum.paperWhitebit,
              ExchangeEnum.paperWhitebitUsdm,
            ].includes(exchange)
          ) {
            continue
          }
          for (const room of rooms) {
            const [symbol, interval] = this.splitCandleRoomName(room)
            await this.connectCandleStream(symbol, interval)
          }
        }
      }
    } catch (e) {
      logger.error(`WhiteBit init error: ${(e as Error)?.message ?? e}`)
      throw e
    }
  }

  /**
   * Subscribe every tradeable market's trades feed. Trades are what this
   * connector turns into ticker updates (`cbWs`) — WhiteBit's `trades_update`
   * carries the last price, which is the only field the price contract needs.
   */
  private async initTradesWS() {
    const [spot, usdm] = await Promise.all([
      getAllExchangeInfo(ExchangeEnum.whitebit),
      getAllExchangeInfo(ExchangeEnum.whitebitUsdm),
    ])
    this.tradeMarkets = [...spot, ...usdm]

    if (!this.tradeMarkets.length) {
      logger.warn('No WhiteBit markets found, skipping trades subscription')
      return
    }

    const client = new WhitebitWsClient({
      tag: 'whitebit trades',
      onOpen: () => {
        // Re-sent on every open: a reconnect starts from an empty
        // subscription set.
        client.notify('trades_subscribe', this.tradeMarkets)
        logger.info(
          `Subscribed to ${this.tradeMarkets.length} WhiteBit markets (${spot.length} spot, ${usdm.length} usdm)`,
        )
      },
      onPush: (method, params) => this.onTradesPush(method, params),
      onError: (err) =>
        logger.error(
          `WhiteBit trades stream error: ${(err as Error)?.message ?? err}`,
        ),
      onClose: ({ code, reason }) =>
        logger.info(
          `WhiteBit trades stream closed ${code ?? ''} ${reason ?? ''}`,
        ),
    })
    this.tradesClient = client
    await client.start()
  }

  private onTradesPush(method: string, params: unknown) {
    if (method !== 'trades_update') return
    const parsed = parseWhitebitTradesUpdate(params)
    if (!parsed || !parsed.trades.length) return
    const exchange = whitebitExchangeForMarket(parsed.market)
    // Only the newest trade matters for a ticker update; the older entries in
    // the same push would publish the same symbol at a stale price.
    const last = parsed.trades[parsed.trades.length - 1]
    this.cbWs(
      [
        {
          eventType: '24hrTicker',
          eventTime: last.time,
          symbol: parsed.market,
          curDayClose: last.price,
          // WhiteBit's trades channel carries no book: the price contract's
          // bid/ask fields fall back to the last trade, as they do for every
          // other trade-driven feed in this repo.
          bestBid: last.price,
          bestBidQnt: last.amount,
          bestAsk: last.price,
          bestAskQnt: last.amount,
          open: last.price,
          high: last.price,
          low: last.price,
          volume: last.amount,
          volumeQuote: `${+last.amount * +last.price || 0}`,
        },
      ],
      exchange,
    )
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
    const room = this.getCandleRoomName(symbol, exchange, interval)
    const set = this.subscribedCandlesMap.get(exchange) ?? new Set()
    if (set.has(room)) {
      return
    }
    set.add(room)
    this.subscribedCandlesMap.set(exchange, set)
    this.connectCandleStream(symbol, interval).catch((e) => {
      // Forget the room so main-app's next `candlesRequests` re-subscribes it
      // instead of it sitting silently dead (same reasoning as kraken.ts).
      this.dropCandleRoom(room)
      logger.error(
        `WhiteBit candle subscribe failed for ${symbol} at interval ${interval}: ${
          (e as Error)?.message ?? e
        }`,
      )
    })
  }

  private dropCandleRoom(room: string) {
    for (const ex of [
      ExchangeEnum.whitebit,
      ExchangeEnum.whitebitUsdm,
      ExchangeEnum.paperWhitebit,
      ExchangeEnum.paperWhitebitUsdm,
    ]) {
      this.subscribedCandlesMap.get(ex)?.delete(room)
    }
  }

  private async connectCandleStream(market: string, interval: string) {
    const seconds = toWhitebitIntervalSeconds(interval)
    if (seconds === null) {
      // An interval WhiteBit does not accept would be rejected on the initial
      // subscribe AND on every reconnect — skip rather than spam the venue.
      logger.warn(
        `WhiteBit candle: unsupported interval "${interval}" for ${market}, skipping candles_subscribe`,
      )
      return
    }
    const key = `${market}@${seconds}`
    if (this.candleClients.has(key)) {
      return
    }
    const client = new WhitebitWsClient({
      tag: `whitebit candle ${market} ${interval}`,
      onOpen: () => {
        client.notify('candles_subscribe', [market, seconds])
      },
      onPush: (method, params) => this.onCandlePush(method, params, interval),
      onError: (err) =>
        logger.error(
          `WhiteBit candle stream error ${market} ${interval}: ${
            (err as Error)?.message ?? err
          }`,
        ),
    })
    this.candleClients.set(key, client)
    try {
      await client.start()
    } catch (e) {
      this.candleClients.delete(key)
      client.close()
      throw e
    }
  }

  private onCandlePush(method: string, params: unknown, interval: string) {
    if (method !== 'candles_update') return
    for (const candle of parseWhitebitCandleUpdate(params)) {
      const exchange = whitebitExchangeForMarket(candle.market)
      this.cbWsTrade(
        {
          e: 'kline',
          E: Date.now(),
          s: candle.market,
          k: {
            o: candle.open,
            h: candle.high,
            l: candle.low,
            c: candle.close,
            v: candle.volume,
            i: interval,
            t: candle.start,
          },
        },
        exchange,
      )
    }
  }

  override stop() {
    super.stop()
    this.tradesClient?.close()
    this.tradesClient = null
    for (const client of this.candleClients.values()) {
      client.close()
    }
    this.candleClients.clear()
  }
}

export default WhitebitConnector
