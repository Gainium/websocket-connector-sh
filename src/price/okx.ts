import { ExchangeEnum, mapPaperToReal, wsLoggerOptions } from '../utils/common'
import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'
import { WsPublicKlineChannel } from 'okx-api'
import { WebsocketClient as OKXWSClient } from '../../okx-custom/websocket-client'
import getAllExchangeInfo from '../utils/exchange'
import { OKXEnv } from '../utils/env'
import CommonConnector from './common'

import type {
  Ticker,
  StreamType,
  SubscribeCandlePayload,
  Market,
} from './types'
import sleep from '../utils/sleep'

const mutex = new IdMutex()

const maxCandlesPerConnection = 1000

class OkxConnector extends CommonConnector {
  private timer: Map<Market, NodeJS.Timeout | null> = new Map()
  private inQueueCandles: Map<
    Market,
    Map<
      string,
      {
        instId: string
        channel: WsPublicKlineChannel
        market: Market
      }
    >
  > = new Map()
  private okxClient: OKXWSClient = this.getOKXClient(ExchangeEnum.okx, 'ticker')
  private okxClientUsdm: OKXWSClient = this.getOKXClient(
    ExchangeEnum.okxLinear,
    'ticker',
  )
  private okxClientCoinm: OKXWSClient = this.getOKXClient(
    ExchangeEnum.okxInverse,
    'ticker',
  )
  private okxClientCandle: {
    client: OKXWSClient
    id: number
    count: number
  }[] = [
    { id: 0, count: 0, client: this.getOKXClient(ExchangeEnum.okx, 'candle') },
  ]
  private okxClientCandleUsdm: {
    client: OKXWSClient
    id: number
    count: number
  }[] = [
    {
      id: 0,
      count: 0,
      client: this.getOKXClient(ExchangeEnum.okxLinear, 'candle'),
    },
  ]
  private okxClientCandleCoinm: {
    client: OKXWSClient
    id: number
    count: number
  }[] = [
    {
      count: 0,
      id: 0,
      client: this.getOKXClient(ExchangeEnum.okxInverse, 'candle'),
    },
  ]
  constructor(
    private subscribedCandlesMap: Map<ExchangeEnum, Set<string>> = new Map(),
  ) {
    super()
    this.okxRestartCb = this.okxRestartCb.bind(this)
    this.okxTickerCb = this.okxTickerCb.bind(this)
    this.okxCandleCb = this.okxCandleCb.bind(this)
    this.mainData = {
      [ExchangeEnum.okx]: this.base,
      [ExchangeEnum.okxInverse]: this.base,
      [ExchangeEnum.okxLinear]: this.base,
    }
    logger.info(`OKX Worker | >🚀 Price <-> Backend stream`)
  }

  private okxTickerCb(e: ExchangeEnum) {
    return (msg: any) => {
      if (msg.arg.channel === 'tickers') {
        this.cbWs([this.convertOkxTicker(msg.data[0])], e)
      }
    }
  }

  private okxCandleCb(e: ExchangeEnum) {
    return (msg: any) => {
      if (msg.arg.channel.includes('candle')) {
        this.cbWsTrade(
          {
            e: 'kline',
            E: +msg.data[0][0],
            //@ts-ignore
            s: this.clearSymbol(msg.arg.instId),
            k: {
              o: msg.data[0][1],
              h: msg.data[0][2],
              l: msg.data[0][3],
              c: msg.data[0][4],
              v: msg.data[0][5],
              i: msg.arg.channel,
              t: msg.data[0][0],
            },
          },
          e,
        )
      }
    }
  }

  private okxGetCallback(e: ExchangeEnum, type: StreamType) {
    if (type === 'candle') {
      return this.okxCandleCb(e)
    }
    return this.okxTickerCb(e)
  }

  private getOKXClient(
    exchange: ExchangeEnum,
    type: StreamType,
    current?: OKXWSClient,
  ) {
    if (current) {
      current.removeAllListeners()
      current.closeAll(false)
      current.on('error', () => null)
    }
    const settings = {
      reconnectTimeout: this.wsReconnect,
      market: OKXEnv(),
    }
    const client = new OKXWSClient(settings, wsLoggerOptions, type === 'candle')
    client.on('update', this.okxGetCallback(exchange, type))
    client.on('open', this.commonWsOpenCb(exchange, type))
    client.on('error', this.okxRestartCb(exchange))
    client.on('reconnected', this.commonWsReconnectCb(exchange, type))
    return client
  }

  @IdMute(mutex, () => 'subscribeCandleCb')
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
      if (
        [ExchangeEnum.okxInverse, ExchangeEnum.paperOkxInverse].includes(
          exchange,
        )
      ) {
        this.connectOkxCandleStreams(
          [{ symbol, interval: interval as WsPublicKlineChannel }],
          'inverse',
        )
      }
      if ([ExchangeEnum.okx, ExchangeEnum.paperOkx].includes(exchange)) {
        this.connectOkxCandleStreams(
          [{ symbol, interval: interval as WsPublicKlineChannel }],
          'spot',
        )
      }
      if (
        [ExchangeEnum.okxLinear, ExchangeEnum.paperOkxLinear].includes(exchange)
      ) {
        this.connectOkxCandleStreams(
          [{ symbol, interval: interval as WsPublicKlineChannel }],
          'linear',
        )
      }
    }
  }

  async init() {
    if (!this.isCandle || this.isAll) {
      this.initOkxWS()
    }
    if (this.isCandle || this.isAll) {
      this.reconnectOkxCandleStream()
    }
  }

  private stopOkx() {
    this.okxClient = this.getOKXClient(
      ExchangeEnum.okx,
      'ticker',
      this.okxClient,
    )
    this.okxClientUsdm = this.getOKXClient(
      ExchangeEnum.okxLinear,
      'ticker',
      this.okxClientUsdm,
    )
    this.okxClientCoinm = this.getOKXClient(
      ExchangeEnum.okxInverse,
      'ticker',
      this.okxClientCoinm,
    )
    this.okxClientCandle = this.okxClientCandle.map((c) => ({
      id: c.id,
      count: 0,
      client: this.getOKXClient(ExchangeEnum.okx, 'candle', c.client),
    }))
    this.okxClientCandleUsdm = this.okxClientCandleUsdm.map((c) => ({
      id: c.id,
      count: 0,
      client: this.getOKXClient(ExchangeEnum.okxLinear, 'candle', c.client),
    }))
    this.okxClientCandleCoinm = this.okxClientCandleCoinm.map((c) => ({
      id: c.id,
      count: 0,
      client: this.getOKXClient(ExchangeEnum.okxInverse, 'candle', c.client),
    }))
  }

  private async initOkxWS() {
    try {
      /** spot */
      const markets = await getAllExchangeInfo(ExchangeEnum.okx)
      const subscribeChannels = markets.map((c) => ({
        channel: 'tickers' as const,
        instId: c,
      }))
      const client = this.okxClient
      client.subscribe(subscribeChannels)
      /** usdm */
      const marketsSwap = await getAllExchangeInfo(ExchangeEnum.okxLinear)
      const clientUsdm = this.okxClientUsdm
      const subscribeChannelsUsdm = marketsSwap.map((c) => ({
        channel: 'tickers' as const,
        instId: this.updateSymbol(this.clearSymbol(c), true),
      }))
      clientUsdm.subscribe(subscribeChannelsUsdm)
      /** coinm */
      const channelsCoinm = await getAllExchangeInfo(ExchangeEnum.okxInverse)
      const clientCoinm = this.okxClientCoinm
      const subscribeChannelsCoinm = channelsCoinm.map((c) => ({
        channel: 'tickers' as const,
        instId: this.updateSymbol(this.clearSymbol(c), true),
      }))
      clientCoinm.subscribe(subscribeChannelsCoinm)
    } catch {
      this.okxRestartCb()()
    }
  }

  private async reconnectOkxCandleStream() {
    const all = this.subscribedCandlesMap.get(ExchangeEnum.okx) ?? new Set()
    const storeSpot: string[][] = []
    all.forEach((s) => {
      storeSpot.push(this.splitCandleRoomName(s))
    })
    this.connectOkxCandleStreams(
      storeSpot.map(([symbol, interval]) => ({
        symbol,
        interval: interval as WsPublicKlineChannel,
      })),
      'spot',
    )
    const allUsdm =
      this.subscribedCandlesMap.get(ExchangeEnum.okxLinear) ?? new Set()
    const storeUsdm: string[][] = []
    allUsdm.forEach((s) => {
      storeUsdm.push(this.splitCandleRoomName(s))
    })
    this.connectOkxCandleStreams(
      storeUsdm.map(([symbol, interval]) => ({
        symbol,
        interval: interval as WsPublicKlineChannel,
      })),
      'linear',
    )
    /** coinm */
    const allCoinm =
      this.subscribedCandlesMap.get(ExchangeEnum.okxInverse) ?? new Set()
    const storeCoinm: string[][] = []
    allCoinm.forEach((s) => {
      storeCoinm.push(this.splitCandleRoomName(s))
    })
    this.connectOkxCandleStreams(
      storeCoinm.map(([symbol, interval]) => ({
        symbol,
        interval: interval as WsPublicKlineChannel,
      })),
      'inverse',
    )
  }

  private okxRestartCb(e?: ExchangeEnum) {
    return (data?: any) => {
      if (e && data) {
        logger.error(
          `${e.toUpperCase()} error: ${`${data.wsKey}`.slice(0, 100)} ${
            data.error ?? JSON.stringify(data)
          }`,
        )
        if (`${data.error ?? ''}`.indexOf('503') === -1) {
          return
        }
      }
      this.stopOkx()
      this.initOkxWS()
      this.reconnectOkxCandleStream()
    }
  }

  private updateSymbol(s: string, futures: boolean) {
    return `${s}${futures ? '-SWAP' : ''}`
  }

  private clearSymbol(s: string) {
    return s.replace(/-SWAP$/, '')
  }

  @IdMute(mutex, (market: Market) => `getCandleClient${market}`)
  private async getCandleClient(market: Market, count: number) {
    if (market === 'spot') {
      const find = [
        ...this.okxClientCandle.filter(
          (c) => c.count < maxCandlesPerConnection,
        ),
      ].sort((a, b) => a.count - b.count)[0]
      if (find) {
        find.count += count
        this.okxClientCandle = this.okxClientCandle.map((c) =>
          c.id === find.id ? { ...c, count: find.count } : c,
        )
        return find.client
      }
      logger.info('Creating new OKX SPOT candle client')
      const client = this.getOKXClient(ExchangeEnum.okx, 'candle')
      this.okxClientCandle.push({
        count,
        client,
        id: this.okxClientCandle.length,
      })
      return client
    }
    if (market === 'linear') {
      const find = [
        ...this.okxClientCandleUsdm.filter(
          (c) => c.count < maxCandlesPerConnection,
        ),
      ].sort((a, b) => a.count - b.count)[0]
      if (find) {
        find.count += count
        this.okxClientCandleUsdm = this.okxClientCandleUsdm.map((c) =>
          c.id === find.id ? { ...c, count: find.count } : c,
        )
        return find.client
      }
      logger.info('Creating new OKX USDM candle client')
      const client = this.getOKXClient(ExchangeEnum.okxLinear, 'candle')
      this.okxClientCandleUsdm.push({
        count,
        client,
        id: this.okxClientCandleUsdm.length,
      })
      return client
    }
    if (market === 'inverse') {
      const find = [
        ...this.okxClientCandleCoinm.filter(
          (c) => c.count < maxCandlesPerConnection,
        ),
      ].sort((a, b) => a.count - b.count)[0]
      if (find) {
        find.count += count
        this.okxClientCandleCoinm = this.okxClientCandleCoinm.map((c) =>
          c.id === find.id ? { ...c, count: find.count } : c,
        )
        return find.client
      }
      logger.info('Creating new OKX COINM candle client')
      const client = this.getOKXClient(ExchangeEnum.okxInverse, 'candle')
      this.okxClientCandleCoinm.push({
        count,
        client,
        id: this.okxClientCandleCoinm.length,
      })
      return client
    }
  }

  @IdMute(mutex, () => 'connectOkx')
  private async connectOkxCandleStreams(
    _data: { symbol: string; interval: WsPublicKlineChannel }[],
    market: Market,
    timer = false,
  ) {
    const t = this.timer.get(market)
    if (t) {
      clearTimeout(t)
      this.timer.set(market, null)
    }
    const data = _data.map(({ symbol: _symbol, interval }) => {
      const symbol = this.updateSymbol(_symbol, market !== 'spot')
      const topic = `${interval}@${symbol}`
      const e =
        market === 'spot'
          ? ExchangeEnum.okx
          : market === 'inverse'
            ? ExchangeEnum.okxInverse
            : ExchangeEnum.okxLinear
      const set = this.subscribedCandlesMap.get(e) ?? new Set()
      if (market === 'spot') {
        set.add(topic)
      }
      if (market === 'linear') {
        set.add(topic)
      }
      if (market === 'inverse') {
        set.add(topic)
      }
      this.subscribedCandlesMap.set(e, set)
      return { instId: symbol, channel: interval }
    })
    if (!timer) {
      data.forEach((d) => {
        const get = this.inQueueCandles.get(market) ?? new Map()
        get.set(`${d.instId}-${d.channel}`, {
          instId: d.instId,
          channel: d.channel,
          market,
        })
        this.inQueueCandles.set(market, get)
      })
      const t = setTimeout(() => {
        this.connectOkxCandleStreams([], market, true)
      }, 5000)
      this.timer.set(market, t)
      return
    }
    const get = this.inQueueCandles.get(market)
    const subscribeChannels = [...(get?.values() ?? [])].map((d) => ({
      instId: d.instId,
      channel: d.channel,
    }))

    for (const k of get?.keys() ?? []) {
      const get2 = this.inQueueCandles.get(market)
      get2?.delete(k)
    }
    const chunks = subscribeChannels.reduce(
      (acc, curr, i) => {
        const index = Math.floor(i / maxCandlesPerConnection)
        if (!acc[index]) {
          acc[index] = []
        }
        acc[index].push(curr)
        return acc
      },
      [] as {
        instId: string
        channel: WsPublicKlineChannel
      }[][],
    )
    for (const chunk of chunks) {
      const client = await this.getCandleClient(market, chunk.length)
      if (client) {
        client.subscribeBatch(chunk)
        await sleep(3600 / 480)
      }
    }
  }

  stop() {
    super.stop()
    this.stopOkx()
  }

  private convertOkxTicker(data: {
    instType: string
    instId: string
    last: string
    lastSz: string
    askPx: string
    askSz: string
    bidPx: string
    bidSz: string
    open24h: string
    high24h: string
    low24h: string
    volCcy24h: string
    vol24h: string
    sodUtc0: string
    sodUtc8: string
    ts: string
  }): Ticker {
    return {
      eventType: '24hrMiniTicker',
      eventTime: +data.ts,
      curDayClose: data.last,
      open: data.open24h,
      high: data.high24h,
      low: data.low24h,
      volume: data.vol24h,
      volumeQuote: data.volCcy24h,
      symbol: this.clearSymbol(data.instId),
      bestBid: data.bidPx,
      bestAsk: data.askPx,
      bestAskQnt: data.askSz,
      bestBidQnt: data.bidSz,
    }
  }
}

export default OkxConnector
