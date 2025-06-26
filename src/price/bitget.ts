import { ExchangeEnum, mapPaperToReal, wsLoggerOptions } from '../utils/common'
import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'
import {
  BitgetInstTypeV2,
  WsInstIdChannelsV2,
  WsTopicSubscribeEventArgsV2,
} from 'bitget-api'
import { WebsocketClientV2 as WSClient } from '../../bitget-custom/websocket-client-v2'
import getAllExchangeInfo from '../utils/exchange'
import CommonConnector from './common'

import type {
  Ticker,
  StreamType,
  SubscribeCandlePayload,
  Market,
} from './types'

const mutex = new IdMutex()

type BitgetTicker = {
  instId: string
  lastPr: string
  open24h: string
  high24h: string
  low24h: string
  change24h: string
  bidPr: string
  askPr: string
  bidSz: string
  askSz: string
  baseVolume: string
  quoteVolume: string
  openUtc: string
  changeUtc24h: string
  ts: string
}

const demo = process.env.BITGETENV === 'demo'

type MapValue = {
  instType: BitgetInstTypeV2
  channel: WsInstIdChannelsV2
  instId: string
}

type BitgetClient = {
  client: WSClient
  subs: number
  id: number
}[]

const maxSubs = 900

const chunkSize = 200

class BitgetConnector extends CommonConnector {
  private bitgetClient: BitgetClient = [
    {
      client: this.getBitgetClient(ExchangeEnum.bitget, 'ticker'),
      subs: 0,
      id: 0,
    },
  ]
  private bitgetClientUsdm: BitgetClient = [
    {
      client: this.getBitgetClient(ExchangeEnum.bitgetUsdm, 'ticker'),
      subs: 0,
      id: 0,
    },
  ]
  private bitgetClientCoinm: BitgetClient = [
    {
      client: this.getBitgetClient(ExchangeEnum.bitgetCoinm, 'ticker'),
      subs: 0,
      id: 0,
    },
  ]
  private bitgetClientCandle: BitgetClient = [
    {
      client: this.getBitgetClient(ExchangeEnum.bitget, 'candle'),
      subs: 0,
      id: 0,
    },
  ]
  private bitgetClientCandleUsdm: BitgetClient = [
    {
      client: this.getBitgetClient(ExchangeEnum.bitgetUsdm, 'candle'),
      subs: 0,
      id: 0,
    },
  ]
  private bitgetClientCandleCoinm: BitgetClient = [
    {
      client: this.getBitgetClient(ExchangeEnum.bitgetCoinm, 'candle'),
      subs: 0,
      id: 0,
    },
  ]
  private timer: Map<Market, NodeJS.Timer | null> = new Map()
  private inQueueCandles: Map<Market, Map<string, MapValue>> = new Map()

  constructor(
    private subscribedCandlesMap: Map<ExchangeEnum, Set<string>> = new Map(),
  ) {
    super()
    this.bitgetRestartCb = this.bitgetRestartCb.bind(this)
    this.bitgetTickerCb = this.bitgetTickerCb.bind(this)
    this.bitgetCandleCb = this.bitgetCandleCb.bind(this)
    logger.info(`Bitget Worker | >🚀 Price <-> Backend stream`)
  }

  private bitgetTickerCb(e: ExchangeEnum) {
    return (msg: any) => {
      if (msg.arg?.channel === 'ticker' && msg.action === 'snapshot') {
        this.cbWs([this.convertBitgetTicker(msg.ts, msg.data[0])], e)
      }
    }
  }

  private bitgetCandleCb(e: ExchangeEnum) {
    return (msg: any) => {
      if (msg.arg?.channel.startsWith('candle') && msg.action === 'update') {
        this.cbWsTrade(
          {
            e: 'kline',
            E: msg.ts,
            s: msg.arg.instId,
            k: {
              o: msg.data[0][1],
              h: msg.data[0][2],
              l: msg.data[0][3],
              c: msg.data[0][4],
              v: msg.data[0][6],
              i: msg.arg.channel,
              t: msg.data[0][0],
            },
          },
          e,
        )
      }
    }
  }

  private bitgetGetCallback(e: ExchangeEnum, type: StreamType) {
    if (type === 'candle') {
      return this.bitgetCandleCb(e)
    }
    return this.bitgetTickerCb(e)
  }

  private getBitgetClient(
    exchange: ExchangeEnum,
    type: StreamType,
    current?: WSClient,
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
    const client = new WSClient(settings, wsLoggerOptions)
    client.on('update', this.bitgetGetCallback(exchange, type))
    client.on('open', this.commonWsOpenCb(exchange, type))
    client.on('exception', this.bitgetRestartCb(exchange))
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
      if ([ExchangeEnum.bitget, ExchangeEnum.paperBitget].includes(exchange)) {
        this.connectBitgetCandleStreams(symbol, interval, 'spot')
      }
      if (
        [ExchangeEnum.bitgetUsdm, ExchangeEnum.paperBitgetUsdm].includes(
          exchange,
        )
      ) {
        this.connectBitgetCandleStreams(symbol, interval, 'linear')
      }
      if (
        [ExchangeEnum.bitgetCoinm, ExchangeEnum.paperBitgetCoinm].includes(
          exchange,
        )
      ) {
        this.connectBitgetCandleStreams(symbol, interval, 'inverse')
      }
    }
  }

  async init() {
    if (!this.isCandle || this.isAll) {
      this.initBitgetWS()
    }
    if (this.isCandle || this.isAll) {
      this.reconnectBitgetCandleStream()
    }
  }

  private stopBitget() {
    this.bitgetClient = this.bitgetClient.map((bg) => ({
      client: this.getBitgetClient(ExchangeEnum.bitget, 'ticker', bg.client),
      subs: 0,
      id: bg.id,
    }))
    this.bitgetClientUsdm = this.bitgetClientUsdm.map((bg) => ({
      client: this.getBitgetClient(
        ExchangeEnum.bitgetUsdm,
        'ticker',
        bg.client,
      ),
      subs: 0,
      id: bg.id,
    }))
    this.bitgetClientCoinm = this.bitgetClientCoinm.map((bg) => ({
      client: this.getBitgetClient(
        ExchangeEnum.bitgetCoinm,
        'ticker',
        bg.client,
      ),
      subs: 0,
      id: bg.id,
    }))
    this.bitgetClientCandle = this.bitgetClientCandle.map((bg) => ({
      client: this.getBitgetClient(ExchangeEnum.bitget, 'candle', bg.client),
      subs: 0,
      id: bg.id,
    }))
    this.bitgetClientCandleUsdm = this.bitgetClientCandleUsdm.map((bg) => ({
      client: this.getBitgetClient(
        ExchangeEnum.bitgetUsdm,
        'candle',
        bg.client,
      ),
      subs: 0,
      id: bg.id,
    }))
    this.bitgetClientCandleCoinm = this.bitgetClientCandleCoinm.map((bg) => ({
      client: this.getBitgetClient(
        ExchangeEnum.bitgetCoinm,
        'candle',
        bg.client,
      ),
      subs: 0,
      id: bg.id,
    }))
  }

  private bitgetRestartCb(e?: ExchangeEnum) {
    return (data?: any) => {
      let skip = false

      if (e && data) {
        const msg = data.error ?? data.msg
        skip =
          `${msg}`.indexOf('request too many') !== -1 ||
          `${msg}`.indexOf(`doesn't exist`) !== -1
        logger.error(
          `${e.toUpperCase()} error: ${`${data.wsKey}`.slice(0, 100)} ${
            msg ?? JSON.stringify(data ?? {})
          }`,
        )
      }
      if (!skip) {
        this.stopBitget()
        this.init()
      }
    }
  }

  @IdMute(mutex, () => 'initBitgetWS')
  private async initBitgetWS() {
    try {
      let i = 0
      /** usdm */
      const marketsUsdm = await getAllExchangeInfo(ExchangeEnum.bitgetUsdm)
      if (!this.mainData[ExchangeEnum.bitgetUsdm]) {
        this.mainData[ExchangeEnum.bitgetUsdm] = this.base
      }
      i = 0
      let chunks = marketsUsdm.reduce((acc, curr, i) => {
        const index = Math.floor(i / chunkSize)
        if (!acc[index]) {
          acc[index] = []
        }
        acc[index].push({
          instType: curr.endsWith('USDC')
            ? demo
              ? 'SUSDC-FUTURES'
              : 'USDC-FUTURES'
            : demo
              ? 'SUSDT-FUTURES'
              : 'USDT-FUTURES',
          instId: curr,
          channel: 'ticker',
        })
        return acc
      }, [] as WsTopicSubscribeEventArgsV2[][])
      for (const chunk of chunks) {
        const cl = this.bitgetClientUsdm
          .filter((c) => c.subs < maxSubs)
          .sort((a, b) => b.subs - a.subs)[0]
        if (cl) {
          cl.client.subscribe(chunk)
          cl.subs += chunk.length
          this.bitgetClientUsdm = this.bitgetClientUsdm.map((c) =>
            c.id === cl.id ? { ...cl } : c,
          )
        } else {
          const cl = this.getBitgetClient(ExchangeEnum.bitgetUsdm, 'ticker')
          cl.subscribe(chunk)
          const last =
            this.bitgetClientUsdm.sort((a, b) => b.id - a.id)[0]?.id ?? 0
          this.bitgetClientUsdm.push({
            client: cl,
            subs: chunk.length,
            id: last + 1,
          })
        }
        i++
        logger.info(
          `Subscribed to chunk ${i} of ${chunks.length} bitget USDM markets`,
        )
      }
      /** coinm */
      const marketsCoinm = await getAllExchangeInfo(ExchangeEnum.bitgetCoinm)
      if (!this.mainData[ExchangeEnum.bitgetCoinm]) {
        this.mainData[ExchangeEnum.bitgetCoinm] = this.base
      }
      i = 0
      chunks = marketsCoinm.reduce((acc, curr, i) => {
        const index = Math.floor(i / chunkSize)
        if (!acc[index]) {
          acc[index] = []
        }
        acc[index].push({
          instType: demo ? 'SCOIN-FUTURES' : 'COIN-FUTURES',
          instId: curr,
          channel: 'ticker',
        })
        return acc
      }, [] as WsTopicSubscribeEventArgsV2[][])
      for (const chunk of chunks) {
        const cl = this.bitgetClientCoinm
          .filter((c) => c.subs < maxSubs)
          .sort((a, b) => b.subs - a.subs)[0]
        if (cl) {
          cl.client.subscribe(chunk)
          cl.subs += chunk.length
          this.bitgetClientCoinm = this.bitgetClientCoinm.map((c) =>
            c.id === cl.id ? { ...cl } : c,
          )
        } else {
          const cl = this.getBitgetClient(ExchangeEnum.bitgetCoinm, 'ticker')
          cl.subscribe(chunk)
          const last =
            this.bitgetClientCoinm.sort((a, b) => b.id - a.id)[0]?.id ?? 0
          this.bitgetClientCoinm.push({
            client: cl,
            subs: chunk.length,
            id: last + 1,
          })
        }
        i++
        logger.info(
          `Subscribed to chunk ${i} of ${chunks.length} bitget COINM markets`,
        )
      }
      /** spot */
      const markets = await getAllExchangeInfo(ExchangeEnum.bitget)
      if (!this.mainData[ExchangeEnum.bitget]) {
        this.mainData[ExchangeEnum.bitget] = this.base
      }

      i = 0
      chunks = markets.reduce((acc, curr, i) => {
        const index = Math.floor(i / chunkSize)
        if (!acc[index]) {
          acc[index] = []
        }
        acc[index].push({
          instType: 'SPOT',
          instId: curr,
          channel: 'ticker',
        })
        return acc
      }, [] as WsTopicSubscribeEventArgsV2[][])
      for (const chunk of chunks) {
        const cl = this.bitgetClient
          .filter((c) => c.subs < maxSubs)
          .sort((a, b) => b.subs - a.subs)[0]
        if (cl) {
          cl.client.subscribe(chunk)
          cl.subs += chunk.length
          this.bitgetClient = this.bitgetClient.map((c) =>
            c.id === cl.id ? { ...cl } : c,
          )
        } else {
          const cl = this.getBitgetClient(ExchangeEnum.bitget, 'ticker')
          cl.subscribe(chunk)
          const last = this.bitgetClient.sort((a, b) => b.id - a.id)[0]?.id ?? 0
          this.bitgetClient.push({
            client: cl,
            subs: chunk.length,
            id: last + 1,
          })
        }
        i++
        logger.info(
          `Subscribed to chunk ${i} of ${chunks.length} bitget markets`,
        )
      }
    } catch {
      this.bitgetRestartCb()()
    }
  }

  private async reconnectBitgetCandleStream() {
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
      this.connectBitgetCandleStreams(symbol, interval, 'spot'),
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
      this.connectBitgetCandleStreams(symbol, interval, 'linear'),
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
      this.connectBitgetCandleStreams(symbol, interval, 'inverse'),
    )
  }

  @IdMute(mutex, () => 'connectBitget')
  private async connectBitgetCandleStreams(
    symbol: string,
    interval: string,
    market: 'spot' | 'linear' | 'inverse',
    timer = false,
  ) {
    const instType =
      market === 'spot'
        ? 'SPOT'
        : market === 'linear'
          ? symbol.endsWith('USDC') || symbol.endsWith('PERP')
            ? demo
              ? 'SUSDC-FUTURES'
              : 'USDC-FUTURES'
            : demo
              ? 'SUSDT-FUTURES'
              : 'USDT-FUTURES'
          : demo
            ? 'SCOIN-FUTURES'
            : 'COIN-FUTURES'
    const t = this.timer.get(market)
    if (t) {
      clearTimeout(t)
      this.timer.set(market, null)
    }
    if (!timer) {
      const get = this.inQueueCandles.get(market) ?? new Map()
      get.set(`${symbol}-${interval}-${market}`, {
        instType,
        channel: interval,
        instId: symbol,
      })
      this.inQueueCandles.set(market, get)
      const t = setTimeout(() => {
        this.connectBitgetCandleStreams('', '', market, true)
      }, 5000)
      this.timer.set(market, t)
      return
    }
    const get = this.inQueueCandles.get(market) ?? new Map()
    const subscribeChannels = ([...(get?.values() ?? [])] as MapValue[]).map(
      (d) => ({
        instType: d.instType,
        channel: d.channel,
        instId: d.instId,
      }),
    )
    for (const k of get?.keys() ?? []) {
      const get2 = this.inQueueCandles.get(market)
      get2?.delete(k)
    }
    const chunks = subscribeChannels.reduce((acc, curr, i) => {
      const index = Math.floor(i / chunkSize)
      if (!acc[index]) {
        acc[index] = []
      }
      acc[index].push(curr)
      return acc
    }, [] as MapValue[][])
    if (market === 'spot') {
      if (!this.mainData[ExchangeEnum.bitget]) {
        this.mainData[ExchangeEnum.bitget] = this.base
      }
      for (const chunk of chunks) {
        const cl = this.bitgetClientCandle
          .filter((c) => c.subs < maxSubs)
          .sort((a, b) => b.subs - a.subs)[0]
        if (cl) {
          cl.client.subscribe(chunk)
          cl.subs += chunk.length
          this.bitgetClientCandle = this.bitgetClientCandle.map((c) =>
            c.id === cl.id ? { ...cl } : c,
          )
        } else {
          const cl = this.getBitgetClient(ExchangeEnum.bitget, 'candle')
          cl.subscribe(chunk)
          const last =
            this.bitgetClientCandle.sort((a, b) => b.id - a.id)[0]?.id ?? 0
          this.bitgetClientCandle.push({
            client: cl,
            subs: chunk.length,
            id: last + 1,
          })
        }
      }
    }
    if (market === 'linear') {
      if (!this.mainData[ExchangeEnum.bitgetUsdm]) {
        this.mainData[ExchangeEnum.bitgetUsdm] = this.base
      }
      for (const chunk of chunks) {
        const cl = this.bitgetClientCandleUsdm
          .filter((c) => c.subs < maxSubs)
          .sort((a, b) => b.subs - a.subs)[0]
        if (cl) {
          cl.client.subscribe(chunk)
          cl.subs += chunk.length
          this.bitgetClientCandleUsdm = this.bitgetClientCandleUsdm.map((c) =>
            c.id === cl.id ? { ...cl } : c,
          )
        } else {
          const cl = this.getBitgetClient(ExchangeEnum.bitgetUsdm, 'candle')
          cl.subscribe(chunk)
          const last =
            this.bitgetClientCandleUsdm.sort((a, b) => b.id - a.id)[0]?.id ?? 0
          this.bitgetClientCandleUsdm.push({
            client: cl,
            subs: chunk.length,
            id: last + 1,
          })
        }
      }
    }
    if (market === 'inverse') {
      if (!this.mainData[ExchangeEnum.bitgetCoinm]) {
        this.mainData[ExchangeEnum.bitgetCoinm] = this.base
      }
      for (const chunk of chunks) {
        const cl = this.bitgetClientCandleCoinm
          .filter((c) => c.subs < maxSubs)
          .sort((a, b) => b.subs - a.subs)[0]
        if (cl) {
          cl.client.subscribe(chunk)
          cl.subs += chunk.length
          this.bitgetClientCandleCoinm = this.bitgetClientCandleCoinm.map(
            (c) => (c.id === cl.id ? { ...cl } : c),
          )
        } else {
          const cl = this.getBitgetClient(ExchangeEnum.bitgetCoinm, 'candle')
          cl.subscribe(chunk)
          const last =
            this.bitgetClientCandleCoinm.sort((a, b) => b.id - a.id)[0]?.id ?? 0
          this.bitgetClientCandleCoinm.push({
            client: cl,
            subs: chunk.length,
            id: last + 1,
          })
        }
      }
    }
  }

  override stop() {
    super.stop()
    this.stopBitget()
  }

  private convertBitgetTicker(ts: number, msg: BitgetTicker): Ticker {
    return {
      eventType: '24hrMiniTicker',
      eventTime: ts,
      curDayClose: msg.lastPr,
      open: msg.open24h,
      high: msg.high24h,
      low: msg.low24h,
      volume: msg.baseVolume,
      volumeQuote: msg.quoteVolume,
      symbol: msg.instId,
      bestBid: msg.bidPr,
      bestAsk: msg.askPr,
      bestAskQnt: msg.askSz,
      bestBidQnt: msg.bidPr,
    }
  }
}

export default BitgetConnector
