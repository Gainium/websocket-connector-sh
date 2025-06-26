import { ExchangeEnum, mapPaperToReal, wsLoggerOptions } from '../utils/common'
import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'
import sleep from '../utils/sleep'
import {
  WebsocketClient as BinanceWSClient,
  WsMessage24hrTickerRaw,
  WsRawMessage,
} from 'binance'
import CommonConnector from './common'

import type { StreamType, SubscribeCandlePayload } from './types'

const mutex = new IdMutex()

class BinanceConnector extends CommonConnector {
  private binanceClient: BinanceWSClient = this.getBinanceClient(
    ExchangeEnum.binance,
    'ticker',
  )
  private binanceClientUsdm: BinanceWSClient = this.getBinanceClient(
    ExchangeEnum.binanceUsdm,
    'ticker',
  )
  private binanceClientCoinm: BinanceWSClient = this.getBinanceClient(
    ExchangeEnum.binanceCoinm,
    'ticker',
  )
  private binanceClientUs: BinanceWSClient = this.getBinanceClient(
    ExchangeEnum.binanceUS,
    'ticker',
  )
  private binanceClientCandle: BinanceWSClient = this.getBinanceClient(
    ExchangeEnum.binance,
    'candle',
  )
  private binanceClientCandleUs: BinanceWSClient = this.getBinanceClient(
    ExchangeEnum.binanceUS,
    'candle',
  )
  private binanceClientCandleUsdm: BinanceWSClient = this.getBinanceClient(
    ExchangeEnum.binanceUsdm,
    'candle',
  )
  private binanceClientCandleCoinm: BinanceWSClient = this.getBinanceClient(
    ExchangeEnum.binanceCoinm,
    'candle',
  )
  private binanceTimers: Map<
    ExchangeEnum,
    { timer: NodeJS.Timer | null; execute: boolean }
  > = new Map()
  constructor(
    private subscribedCandlesMap: Map<ExchangeEnum, Set<string>> = new Map(),
  ) {
    super()
    this.binanceCandleCb = this.binanceCandleCb.bind(this)
    this.binanceOpenCb = this.binanceOpenCb.bind(this)
    this.binanceErrorCb = this.binanceErrorCb.bind(this)
    this.binanceTickerCb = this.binanceTickerCb.bind(this)
    this.mainData = {
      [ExchangeEnum.binance]: this.base,
      [ExchangeEnum.binanceUS]: this.base,
      [ExchangeEnum.binanceCoinm]: this.base,
      [ExchangeEnum.binanceUsdm]: this.base,
    }
    logger.info(`Binance Worker | >🚀 Price <-> Backend stream`)
  }

  private binanceCandleCb(e: ExchangeEnum) {
    return (d: WsRawMessage) => {
      if (!Array.isArray(d) && d.e === 'kline') {
        //@ts-ignore
        delete d.wsKey
        this.cbWsTrade(
          {
            ...d,
            k: {
              ...d.k,
              c: `${d.k.c}`,
              v: `${d.k.v}`,
              o: `${d.k.o}`,
              h: `${d.k.h}`,
              l: `${d.k.l}`,
            },
          },
          e,
        )
      }
    }
  }

  private binanceTickerCb(e: ExchangeEnum) {
    return (d: WsRawMessage) => {
      if (Array.isArray(d) && d[0]?.e === '24hrTicker') {
        //@ts-ignore
        delete d.wsKey
        this.cbWs(
          (d as WsMessage24hrTickerRaw[]).map((d) => ({
            eventType: d.e,
            eventTime: d.E,
            symbol: d.s,
            curDayClose: `${d.c}`,
            bestBid: `${d.b}`,
            bestBidQnt: `${d.B}`,
            bestAsk: `${d.a}`,
            bestAskQnt: `${d.A}`,
            open: `${d.o}`,
            high: `${d.h}`,
            low: `${d.l}`,
            volume: `${d.v}`,
            volumeQuote: `${d.q}`,
          })),
          e,
        )
      }
    }
  }

  private binanceGetCallback(e: ExchangeEnum, type: StreamType) {
    if (type === 'candle') {
      return this.binanceCandleCb(e)
    }
    return this.binanceTickerCb(e)
  }

  private binanceOpenCb(e: ExchangeEnum, type: StreamType) {
    return (data: any) => {
      logger.info(
        `${e.toUpperCase()} ${type} opened ${`${data.wsKey}`.slice(
          0,
          100,
        )} ${`${data.ws.target.url}`.slice(0, 100)}`,
      )
    }
  }

  private binanceErrorCb(e: ExchangeEnum) {
    return (data: any) => {
      logger.error(
        `${e.toUpperCase()} error: ${`${data.wsKey}`.slice(
          0,
          100,
        )} ${JSON.stringify(data.error ?? data ?? '')}`,
      )
      this.stopBinance()
      this.initBinanceWS()
      this.reconnectBinanceCandleStream()
    }
  }

  private getBinanceClient(
    exchange: ExchangeEnum,
    type: StreamType,
    current?: BinanceWSClient,
  ) {
    if (current) {
      current.removeAllListeners()
      current.closeAll(false)
      current.on('error', () => null)
    }
    const settings: { [x: string]: unknown } = {
      reconnectTimeout: this.wsReconnect,
    }
    if (exchange === ExchangeEnum.binanceUS) {
      settings.wsUrl = 'wss://stream.binance.us:9443/ws'
      settings.restOptions = {
        baseUrl: 'https://api.binance.us',
      }
    }
    const client = new BinanceWSClient(settings, wsLoggerOptions)
    client.on('message', this.binanceGetCallback(exchange, type))
    client.on('open', this.binanceOpenCb(exchange, type))
    client.on('error', this.binanceErrorCb(exchange))
    return client
  }

  private stopBinance() {
    this.binanceClient = this.getBinanceClient(
      ExchangeEnum.binance,
      'ticker',
      this.binanceClient,
    )
    this.binanceClientUsdm = this.getBinanceClient(
      ExchangeEnum.binanceUsdm,
      'ticker',
      this.binanceClientUsdm,
    )
    this.binanceClientCoinm = this.getBinanceClient(
      ExchangeEnum.binanceCoinm,
      'ticker',
      this.binanceClientCoinm,
    )
    this.binanceClientUs = this.getBinanceClient(
      ExchangeEnum.binanceUS,
      'ticker',
      this.binanceClientUs,
    )
    this.binanceClientCandle = this.getBinanceClient(
      ExchangeEnum.binance,
      'candle',
      this.binanceClientCandle,
    )
    this.binanceClientCandleUs = this.getBinanceClient(
      ExchangeEnum.binanceUS,
      'candle',
      this.binanceClientCandleUs,
    )
    this.binanceClientCandleUsdm = this.getBinanceClient(
      ExchangeEnum.binanceUsdm,
      'candle',
      this.binanceClientCandleUsdm,
    )
    this.binanceClientCandleCoinm = this.getBinanceClient(
      ExchangeEnum.binanceCoinm,
      'candle',
      this.binanceClientCandleCoinm,
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
        [ExchangeEnum.binance, ExchangeEnum.paperBinance].includes(exchange)
      ) {
        this.connectBinanceCandleStreams()
      }
      if (exchange === ExchangeEnum.binanceUS) {
        this.connectBinanceCandleStreams(true)
      }
      if (
        [ExchangeEnum.binanceUsdm, ExchangeEnum.paperBinanceUsdm].includes(
          exchange,
        )
      ) {
        this.connectBinanceCandleStreams(false, 'usdm')
      }
      if (
        [ExchangeEnum.binanceCoinm, ExchangeEnum.paperBinanceCoinm].includes(
          exchange,
        )
      ) {
        this.connectBinanceCandleStreams(false, 'coinm')
      }
    }
  }

  async init() {
    if (!this.isCandle || this.isAll) {
      this.initBinanceWS()
    }
    if (this.isCandle || this.isAll) {
      this.reconnectBinanceCandleStream()
    }
  }

  private async initBinanceWS() {
    this.binanceClient.subscribeAll24hrTickers('spot')
    this.binanceClientCoinm.subscribeAll24hrTickers('coinm')
    this.binanceClientUsdm.subscribeAll24hrTickers('usdm')
    this.binanceClientUs.subscribeAll24hrTickers('spot')
  }

  private async closeBinanceCandleStream(
    us = false,
    futures?: 'coinm' | 'usdm',
  ) {
    if (us) {
      this.binanceClientCandleUs.closeAll(false)
    } else if (futures === 'coinm') {
      this.binanceClientCandleCoinm.closeAll(false)
    } else if (futures === 'usdm') {
      this.binanceClientCandleUsdm.closeAll(false)
    } else {
      this.binanceClientCandle.closeAll(false)
    }
  }

  private async reconnectBinanceCandleStream() {
    this.connectBinanceCandleStreams(true)
    this.connectBinanceCandleStreams(false)
    this.connectBinanceCandleStreams(false, 'coinm')
    this.connectBinanceCandleStreams(false, 'usdm')
  }

  private helperGetExchangeEnum(us = false, futures?: 'coinm' | 'usdm') {
    return us
      ? ExchangeEnum.binanceUS
      : !futures
        ? ExchangeEnum.binance
        : futures === 'coinm'
          ? ExchangeEnum.binanceCoinm
          : ExchangeEnum.binanceUsdm
  }
  @IdMute(mutex, () => 'connectBinance')
  private async connectBinanceCandleStreams(
    us = false,
    futures?: 'coinm' | 'usdm',
  ) {
    const e = this.helperGetExchangeEnum(us, futures)
    const timer = this.binanceTimers.get(e) ?? { timer: null, execute: false }
    const setTimer = () =>
      setTimeout(() => {
        const e = this.helperGetExchangeEnum(us, futures)
        const timer = this.binanceTimers.get(e) ?? {
          timer: null,
          execute: false,
        }
        timer.timer = null
        timer.execute = true
        this.binanceTimers.set(e, timer)
        this.connectBinanceCandleStreams.bind(this)(us, futures)
      }, 5000)
    if (!timer.execute) {
      if (timer.timer) {
        clearTimeout(timer.timer)
      }
      timer.timer = setTimer()
      this.binanceTimers.set(e, timer)
      return
    }
    timer.execute = false
    this.binanceTimers.set(e, timer)
    await this.closeBinanceCandleStream(us, futures)
    const all = this.subscribedCandlesMap.get(e) ?? new Set()
    const filtered: string[] = []
    all.forEach((s) => {
      const [symbol, interval] = this.splitCandleRoomName(s)
      filtered.push(`${symbol}@kline_${interval}`.toLowerCase())
    })
    const chunks = []
    const chunkSize = 200
    for (let i = 0; i < filtered.length + chunkSize; i += chunkSize) {
      chunks.push(filtered.slice(i, i + chunkSize))
    }
    let i = 0
    let forceNew = false
    for (const c of chunks) {
      if (!c.length) {
        continue
      }
      if (forceNew) {
        forceNew = false
      }
      if (i >= chunkSize) {
        forceNew = true
      }
      const wsKey = c.join('/')
      i++
      await sleep(1000)
      if (us) {
        this.binanceClientCandleUs.connectToWsUrl(
          //@ts-ignore
          `${this.binanceClientCandleUs.getWsBaseUrl(
            'spot',
            wsKey,
          )}/ws/${wsKey}`,
          wsKey,
          forceNew,
        )
      } else {
        if (futures) {
          if (futures === 'coinm') {
            this.binanceClientCandleCoinm.connectToWsUrl(
              //@ts-ignore
              `${this.binanceClientCandleCoinm.getWsBaseUrl(
                'coinm',
                wsKey,
              )}/ws/${wsKey}`,
              wsKey,
              forceNew,
            )
          } else if (futures === 'usdm') {
            this.binanceClientCandleUsdm.connectToWsUrl(
              //@ts-ignore
              `${this.binanceClientCandleUsdm.getWsBaseUrl(
                'usdm',
                wsKey,
              )}/ws/${wsKey}`,
              wsKey,
              forceNew,
            )
          }
        } else {
          this.binanceClientCandle.connectToWsUrl(
            //@ts-ignore
            `${this.binanceClientCandle.getWsBaseUrl(
              'spot',
              wsKey,
            )}/ws/${wsKey}`,
            wsKey,
            forceNew,
          )
        }
      }
    }
  }

  stop() {
    super.stop()
    this.stopBinance()
  }
}

export default BinanceConnector
