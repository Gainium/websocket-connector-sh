import { ExchangeEnum, mapPaperToReal, wsLoggerOptions } from '../utils/common'
import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'
import sleep from '../utils/sleep'
import { WebsocketClient as BybitWSClient } from '../../bybit-custom/websocket-client'
import getAllExchangeInfo from '../utils/exchange'
import CommonConnector from './common'

import type { Ticker, StreamType, SubscribeCandlePayload } from './types'

const mutex = new IdMutex()

const maxCandlesPerConnection = 500

type Market = 'spot' | 'linear' | 'inverse'

class BybitConnector extends CommonConnector {
  private bybitClient: BybitWSClient = this.getBybitClient(
    ExchangeEnum.bybit,
    'ticker',
  )
  private bybitClientUsdm: BybitWSClient = this.getBybitClient(
    ExchangeEnum.bybitUsdm,
    'ticker',
  )
  private bybitClientCoinm: BybitWSClient = this.getBybitClient(
    ExchangeEnum.bybitCoinm,
    'ticker',
  )
  private bybitClientCandle: {
    count: number
    client: BybitWSClient
    id: number
  }[] = [
    {
      id: 0,
      count: 0,
      client: this.getBybitClient(ExchangeEnum.bybit, 'candle'),
    },
  ]
  private bybitClientCandleUsdm: {
    count: number
    client: BybitWSClient
    id: number
  }[] = [
    {
      id: 0,
      count: 0,
      client: this.getBybitClient(ExchangeEnum.bybitUsdm, 'candle'),
    },
  ]
  private bybitClientCandleCoinm: {
    count: number
    client: BybitWSClient
    id: number
  }[] = [
    {
      id: 0,
      count: 0,
      client: this.getBybitClient(ExchangeEnum.bybitCoinm, 'candle'),
    },
  ]

  constructor(
    private subscribedCandlesMap: Map<ExchangeEnum, Set<string>> = new Map(),
    private subscribedTopics: Map<ExchangeEnum, Set<string>> = new Map(),
  ) {
    super()
    this.bybitRestartCb = this.bybitRestartCb.bind(this)
    this.bybitTickerCb = this.bybitTickerCb.bind(this)
    this.bybitCandleCb = this.bybitCandleCb.bind(this)
    this.mainData = {
      [ExchangeEnum.bybit]: this.base,
      [ExchangeEnum.bybitUsdm]: this.base,
      [ExchangeEnum.bybitCoinm]: this.base,
    }
    logger.info(`Bybit Worker | >🚀 Price <-> Backend stream`)
  }

  private bybitTickerCb(e: ExchangeEnum) {
    return (msg: any) => {
      if (msg.topic.includes('tickers') && msg.type === 'snapshot') {
        this.cbWs([this.convertBybitTicker(msg.ts, msg.data)], e)
      }
      if (msg.topic.includes('tickers') && msg.type === 'delta') {
        const ticker = this.convertBybitDeltaTicker(msg.ts, msg.data)
        if (ticker) {
          this.cbWs([ticker], e)
        }
      }
    }
  }

  private bybitCandleCb(e: ExchangeEnum) {
    return (msg: any) => {
      if (msg.topic.includes('kline')) {
        // Liveness: every kline frame (confirmed or not) proves the feed is
        // alive. Without this, lastDataTrade only advances on candle *close*,
        // so any interval >~2min looks stalled between closes and the watchdog
        // crash-loops the worker. Publishing stays confirmed-only below.
        this.noteCandleActivity(e)
        if (!msg?.data[0]?.confirm) {
          return
        }
        const [_, int, symbol] = msg.topic.split('.')
        if (int && symbol) {
          this.cbWsTrade(
            {
              e: 'kline',
              E: msg.ts,
              s: symbol,
              k: {
                o: msg.data[0].open,
                h: msg.data[0].high,
                l: msg.data[0].low,
                c: msg.data[0].close,
                v: msg.data[0].volume,
                i: int,
                t: msg.data[0].start,
              },
            },
            e,
          )
        }
      }
    }
  }

  private bybitGetCallback(e: ExchangeEnum, type: StreamType) {
    if (type === 'candle') {
      return this.bybitCandleCb(e)
    }
    return this.bybitTickerCb(e)
  }

  private getBybitClient(
    exchange: ExchangeEnum,
    type: StreamType,
    current?: BybitWSClient,
  ) {
    if (current) {
      current.removeAllListeners()
      current.closeAll(false)
      current.on('exception', () => null)
    }
    const settings = {
      reconnectTimeout: this.wsReconnect,
      market: 'v5' as const,
    }
    const client = new BybitWSClient(settings, wsLoggerOptions)
    client.on('update', this.bybitGetCallback(exchange, type))
    client.on('open', this.commonWsOpenCb(exchange, type))
    client.on('exception', this.bybitRestartCb(exchange))
    client.on('reconnected', this.commonWsReconnectCb(exchange, type))
    return client
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
      if ([ExchangeEnum.bybit, ExchangeEnum.paperBybit].includes(exchange)) {
        this.connectBybitCandleStreams(symbol, interval, 'spot')
      }
      if (
        [ExchangeEnum.bybitUsdm, ExchangeEnum.paperBybitUsdm].includes(exchange)
      ) {
        this.connectBybitCandleStreams(symbol, interval, 'linear')
      }
      if (
        [ExchangeEnum.bybitCoinm, ExchangeEnum.paperBybitCoinm].includes(
          exchange,
        )
      ) {
        this.connectBybitCandleStreams(symbol, interval, 'inverse')
      }
    }
  }

  async init() {
    if (!this.isCandle || this.isAll) {
      this.initBybitWS()
    }
    if (this.isCandle || this.isAll) {
      this.reconnectBybitCandleStream()
    }
  }

  private stopBybit() {
    this.bybitClient = this.getBybitClient(
      ExchangeEnum.bybit,
      'ticker',
      this.bybitClient,
    )
    this.bybitClientUsdm = this.getBybitClient(
      ExchangeEnum.bybitUsdm,
      'ticker',
      this.bybitClientUsdm,
    )
    this.bybitClientCoinm = this.getBybitClient(
      ExchangeEnum.bybitCoinm,
      'ticker',
      this.bybitClientCoinm,
    )
    this.bybitClientCandle = this.bybitClientCandle.map((c) => ({
      id: c.id,
      count: 0,
      client: this.getBybitClient(ExchangeEnum.bybit, 'candle', c.client),
    }))
    this.bybitClientCandleUsdm = this.bybitClientCandleUsdm.map((c) => ({
      id: c.id,
      count: 0,
      client: this.getBybitClient(ExchangeEnum.bybitUsdm, 'candle', c.client),
    }))
    this.bybitClientCandleCoinm = this.bybitClientCandleCoinm.map((c) => ({
      id: c.id,
      count: 0,
      client: this.getBybitClient(ExchangeEnum.bybitCoinm, 'candle', c.client),
    }))
  }

  /**
   * Bug #121: a restart cycle is in flight. The bybit clients (spot/linear/
   * inverse, ticker + candle) each raise `exception` independently, so without
   * this guard a burst of exceptions starts overlapping `stopBybit()` +
   * `initBybitWS()` cycles. Because `initBybitWS` re-subscribes every ticker
   * topic with 5s sleeps between markets, overlapping cycles double-subscribe
   * the same topics — which makes bybit answer `already subscribed`, which
   * (before the skip below) raised another exception. That feedback loop
   * recreated WS clients faster than they were released: unbounded memory, a
   * pinned core, and eventually a ticker stall the watchdog turned into a
   * full-worker crash every 40-90s.
   *
   * Note this must COALESCE (drop) concurrent restarts, not queue them — the
   * `IdMutex` used elsewhere in this file serialises, which would still run N
   * full restarts back-to-back for a burst of N exceptions.
   */
  private bybitRestarting = false

  private bybitRestartCb(e?: ExchangeEnum) {
    return (data?: any) => {
      let skip = false
      if (e && data) {
        const msg = data.error ?? data.ret_msg
        skip =
          `${msg}`.indexOf('handler not found') !== -1 ||
          `${msg}`.indexOf('format error') !== -1 ||
          // Informational reply to re-subscribing a still-active topic. Not a
          // connection failure — restarting on it is what starts the storm.
          `${msg}`.indexOf('already subscribed') !== -1
        const line = `${e.toUpperCase()} error: ${`${data.wsKey}`.slice(
          0,
          100,
        )} ${msg ?? JSON.stringify(data ?? {})}`
        // Benign, self-clearing replies are logged as info: emitting them at
        // error level made a healthy connector look broken.
        if (skip) {
          logger.info(line)
        } else {
          logger.error(line)
        }
      }
      if (skip) {
        return
      }
      if (this.bybitRestarting) {
        logger.info(
          `Bybit restart already in progress — coalescing ${e ?? 'init'} exception`,
        )
        return
      }
      this.bybitRestarting = true
      void this.runBybitRestart()
    }
  }

  /**
   * One full restart cycle, held under `bybitRestarting` until every step has
   * settled so concurrent exceptions are dropped rather than interleaved.
   */
  private async runBybitRestart() {
    try {
      this.stopBybit()
      await this.initBybitWS()
      await this.reconnectBybitCandleStream()
    } catch (err) {
      logger.error(`Bybit restart cycle failed: ${err}`)
    } finally {
      this.bybitRestarting = false
    }
  }

  private async initBybitWS() {
    try {
      /** spot */
      const markets = await getAllExchangeInfo(ExchangeEnum.bybit)
      const channels = markets.map((m) => `tickers.${m}`)
      const bybitTopics: Set<string> = new Set()
      channels.forEach((c) => bybitTopics.add(c))
      this.subscribedTopics.set(ExchangeEnum.bybit, bybitTopics)
      const client = this.bybitClient
      client.subscribeV5(channels, 'spot', false)
      await sleep(5000)
      /** usdm */
      const marketsUsdm = await getAllExchangeInfo(ExchangeEnum.bybitUsdm)
      const channelsUsdm = marketsUsdm.map((m) => `tickers.${m}`)
      const bybitTopicsUsdm: Set<string> = new Set()
      channelsUsdm.forEach((c) => bybitTopicsUsdm.add(c))
      this.subscribedTopics.set(ExchangeEnum.bybitUsdm, bybitTopicsUsdm)
      const clientUsdm = this.bybitClientUsdm
      clientUsdm.subscribeV5(channelsUsdm, 'linear', false)
      await sleep(5000)
      /** coinm */
      const marketsCoinm = await getAllExchangeInfo(ExchangeEnum.bybitCoinm)
      const channelsCoinm = marketsCoinm.map((m) => `tickers.${m}`)
      const bybitTopicsCoinm: Set<string> = new Set()
      channelsCoinm.forEach((c) => bybitTopicsCoinm.add(c))
      this.subscribedTopics.set(ExchangeEnum.bybitCoinm, bybitTopicsCoinm)
      const clientCoinm = this.bybitClientCoinm
      clientCoinm.subscribeV5(channelsCoinm, 'inverse', false)
      await sleep(5000)
    } catch (err) {
      logger.error(`Bybit ticker init failed: ${err}`)
      // Retry on a later tick, not by immediate recursion: this runs inside the
      // restart cycle, which still holds `bybitRestarting`, so a synchronous
      // re-entry would be coalesced away and the retry lost. The delay also
      // stops a persistently failing exchange-info fetch from spinning.
      setTimeout(() => this.bybitRestartCb()(), this.wsReconnect)
    }
  }

  private async reconnectBybitCandleStream() {
    /** spot */
    const allSpot =
      this.subscribedCandlesMap.get(ExchangeEnum.bybit) ?? new Set()
    const storeSpot: string[][] = []
    allSpot.forEach((s) => {
      if (s.indexOf('tickers') === -1) {
        storeSpot.push(this.splitCandleRoomName(s))
      }
    })
    storeSpot.forEach(([symbol, interval]) =>
      this.connectBybitCandleStreams(symbol, interval, 'spot'),
    )
    /** usdm */
    const allUsdm =
      this.subscribedCandlesMap.get(ExchangeEnum.bybitUsdm) ?? new Set()
    const storeUsdm: string[][] = []
    allUsdm.forEach((s) => {
      if (s.indexOf('tickers') === -1) {
        storeUsdm.push(this.splitCandleRoomName(s))
      }
    })
    storeUsdm.forEach(([symbol, interval]) =>
      this.connectBybitCandleStreams(symbol, interval, 'linear'),
    )
    /** coinm */
    const allCoinm =
      this.subscribedCandlesMap.get(ExchangeEnum.bybitCoinm) ?? new Set()
    const storeCoinm: string[][] = []
    allCoinm.forEach((s) => {
      if (s.indexOf('tickers') === -1) {
        storeCoinm.push(this.splitCandleRoomName(s))
      }
    })
    storeCoinm.forEach(([symbol, interval]) =>
      this.connectBybitCandleStreams(symbol, interval, 'inverse'),
    )
  }

  @IdMute(mutex, (market: Market) => `getCandleClient${market}`)
  private async getCandleClient(market: Market) {
    if (market === 'spot') {
      const find = [
        ...this.bybitClientCandle.filter(
          (c) => c.count < maxCandlesPerConnection,
        ),
      ].sort((a, b) => a.count - b.count)[0]
      if (find) {
        find.count++
        this.bybitClientCandle = this.bybitClientCandle.map((c) =>
          c.id === find.id ? { ...c, count: find.count } : c,
        )
        return find.client
      }
      logger.info('Creating new bybit SPOT candle client')
      const client = this.getBybitClient(ExchangeEnum.bybit, 'candle')
      this.bybitClientCandle.push({
        count: 1,
        client,
        id: this.bybitClientCandle.length,
      })
      return client
    }
    if (market === 'linear') {
      const find = [
        ...this.bybitClientCandleUsdm.filter(
          (c) => c.count < maxCandlesPerConnection,
        ),
      ].sort((a, b) => a.count - b.count)[0]
      if (find) {
        find.count++
        this.bybitClientCandleUsdm = this.bybitClientCandleUsdm.map((c) =>
          c.id === find.id ? { ...c, count: find.count } : c,
        )
        return find.client
      }
      logger.info('Creating new bybit USDM candle client')
      const client = this.getBybitClient(ExchangeEnum.bybitUsdm, 'candle')
      this.bybitClientCandleUsdm.push({
        count: 1,
        client,
        id: this.bybitClientCandle.length,
      })
      return client
    }
    if (market === 'inverse') {
      const find = [
        ...this.bybitClientCandleCoinm.filter(
          (c) => c.count < maxCandlesPerConnection,
        ),
      ].sort((a, b) => a.count - b.count)[0]
      if (find) {
        find.count++
        this.bybitClientCandleCoinm = this.bybitClientCandleCoinm.map((c) =>
          c.id === find.id ? { ...c, count: find.count } : c,
        )
        return find.client
      }
      logger.info('Creating new bybit COINM candle client')
      const client = this.getBybitClient(ExchangeEnum.bybitCoinm, 'candle')
      this.bybitClientCandleCoinm.push({
        count: 1,
        client,
        id: this.bybitClientCandle.length,
      })
      return client
    }
  }

  @IdMute(mutex, () => 'connectBybit')
  private async connectBybitCandleStreams(
    symbol: string,
    interval: string,
    market: Market,
  ) {
    const topic = `kline.${interval}.${symbol}`
    ;(await this.getCandleClient(market))?.subscribeV5(topic, market, false)
  }

  override stop() {
    super.stop()
    this.stopBybit()
  }

  /**
   * Recreate the candle WS clients (spot/linear/inverse) and re-subscribe all
   * tracked candle topics, without tearing down ticker sockets or crashing the
   * worker. Used for targeted stall recovery.
   */
  private restartCandleStreams() {
    this.bybitClientCandle = this.bybitClientCandle.map((c) => ({
      id: c.id,
      count: 0,
      client: this.getBybitClient(ExchangeEnum.bybit, 'candle', c.client),
    }))
    this.bybitClientCandleUsdm = this.bybitClientCandleUsdm.map((c) => ({
      id: c.id,
      count: 0,
      client: this.getBybitClient(ExchangeEnum.bybitUsdm, 'candle', c.client),
    }))
    this.bybitClientCandleCoinm = this.bybitClientCandleCoinm.map((c) => ({
      id: c.id,
      count: 0,
      client: this.getBybitClient(ExchangeEnum.bybitCoinm, 'candle', c.client),
    }))
    this.reconnectBybitCandleStream()
  }

  /**
   * Fix #1: recover a candle stall by restarting only the bybit candle streams
   * instead of crashing the whole worker (which also drops the ticker feeds and
   * every other bybit market). Ticker/connect stalls still fall through to the
   * full-worker restart. `CommonConnector` bounds how many times this runs
   * before escalating to the old throw-based restart.
   */
  protected override handleStall(
    exchange: ExchangeEnum,
    kind: 'price' | 'candle' | 'connect',
  ): boolean {
    if (kind !== 'candle') {
      return false
    }
    logger.info(
      `Bybit ${exchange} candle stall — targeted candle-stream restart (no full-worker crash)`,
    )
    this.restartCandleStreams()
    return true
  }

  private convertBybitTicker(
    ts: number,
    msg: {
      symbol: string
      lastPrice: string
      highPrice24h: string
      lowPrice24h: string
      prevPrice24h: string
      volume24h: string
      turnover24h: string
      price24hPcnt: string
      usdIndexPrice: string
    },
  ): Ticker {
    return {
      eventType: '24hrMiniTicker',
      eventTime: ts,
      curDayClose: msg.lastPrice,
      open: msg.prevPrice24h,
      high: msg.highPrice24h,
      low: msg.lastPrice,
      volume: msg.volume24h,
      volumeQuote: msg.turnover24h,
      symbol: msg.symbol,
      bestBid: msg.lastPrice,
      bestAsk: msg.lastPrice,
      bestAskQnt: msg.volume24h,
      bestBidQnt: msg.volume24h,
    }
  }

  private convertBybitDeltaTicker(
    ts: number,
    msg: {
      symbol: string
      price24hPcnt: string
      lastPrice?: string
      fundingRate: string
      bid1Price: string
      bid1Size: string
      ask1Price: string
      ask1Size: string
    },
  ): Ticker | undefined {
    if (!msg.lastPrice) {
      return
    }
    return {
      eventType: '24hrMiniTicker',
      eventTime: ts,
      curDayClose: msg.lastPrice,
      open: msg.lastPrice,
      high: msg.lastPrice,
      low: msg.lastPrice,
      volume: '0',
      volumeQuote: '0',
      symbol: msg.symbol,
      bestBid: msg.bid1Price,
      bestAsk: msg.ask1Price,
      bestAskQnt: msg.ask1Size,
      bestBidQnt: msg.bid1Size,
    }
  }
}

export default BybitConnector
