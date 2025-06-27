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
    const client = new BybitWSClient(settings, {
      info: wsLoggerOptions.info,
      error: wsLoggerOptions.error,
      trace: wsLoggerOptions.silly,
    })
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

  private bybitRestartCb(e?: ExchangeEnum) {
    return (data?: any) => {
      let skip = false
      if (e && data) {
        const msg = data.error ?? data.ret_msg
        skip =
          `${msg}`.indexOf('handler not found') !== -1 ||
          `${msg}`.indexOf('format error') !== -1
        logger.error(
          `${e.toUpperCase()} error: ${`${data.wsKey}`.slice(0, 100)} ${
            msg ?? JSON.stringify(data ?? {})
          }`,
        )
      }
      if (!skip) {
        this.stopBybit()
        this.initBybitWS()
        this.reconnectBybitCandleStream()
      }
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
    } catch {
      this.bybitRestartCb()()
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
      bestAskQnt: msg.ask1Price,
      bestBidQnt: msg.bid1Size,
    }
  }
}

export default BybitConnector
