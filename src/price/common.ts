import { parentPort } from 'worker_threads'
import { ExchangeEnum } from '../utils/common'
import RedisClient from '../utils/redis'
import sleep from '../utils/sleep'
import logger from '../utils/logger'

import type {
  Ticker,
  Candle,
  WSTrade,
  StreamType,
  SubscribeCandlePayload,
} from './types'

const priceRole = process.env.PRICEROLE

class CommonConnector {
  mainData: {
    [x: string]: {
      lastData: number
      lastDataTrade?: number
      connectTime: number
    }
  } = {}
  watchdog: NodeJS.Timer | null = null
  timeout = 50000
  tradeTimeout = 50000
  connectTime = 50000
  wsReconnect = 3500
  isCandle = priceRole === 'candle'
  isAll = priceRole === 'all'
  base = {
    lastData: 0,
    lastDataTrade: 0,
    connectTime: +new Date(),
    ticker: null,
    trade: null,
  }
  private redis = RedisClient.getInstance()

  constructor() {
    this.cbWs = this.cbWs.bind(this)
    this.cbWsTrade = this.cbWsTrade.bind(this)
    this.watchdogFn = this.watchdogFn.bind(this)
    this.watchdog = setInterval(this.watchdogFn, this.timeout)
    this.subscribeCandleCb = this.subscribeCandleCb.bind(this)
    this.commonWsOpenCb = this.commonWsOpenCb.bind(this)
    this.commonWsReconnectCb = this.commonWsReconnectCb.bind(this)
    parentPort?.on('message', (msg: { do: string; data: any }) => {
      if (msg?.do === 'subscribeCandle') {
        const d = msg.data as SubscribeCandlePayload
        this.subscribeCandleCb(d)
      }
    })
  }

  getCandleRoomName(symbol: string, exchange: string, interval: string) {
    return `${symbol}@${exchange}@${interval}Candle`
  }

  splitCandleRoomName(str: string) {
    const s = str.replace('Candle', '')
    const [symbol, _exchange, interval] = s.split('@')
    return [symbol, interval]
  }

  async cbWs(trades: Ticker[], exchange: ExchangeEnum) {
    this.mainData[exchange].lastData = +new Date()
    for (const trade of trades) {
      const symbol = trade.symbol as string
      const data = {
        symbol,
        time: +trade.eventTime,
        price: +trade.curDayClose,
        volume: +trade.volume,
        bestAsk: +trade.curDayClose,
        bestBid: +trade.curDayClose,
        bestAskQnt: +trade.bestAskQnt,
        bestBidQnt: +trade.bestBidQnt,
        uniqueMessageId: `${symbol}@${trade.eventTime}@${exchange}`,
        eventTime: +new Date(),
      }
      data.uniqueMessageId = `${data.uniqueMessageId}${data.price}${data.volume}${data.bestAsk}${data.bestBid}${data.bestAskQnt}${data.bestBidQnt}`

      this.redis.publish(
        `trade@${symbol}@${exchange}`,
        JSON.stringify({ ...data, exchange }),
      )

      await sleep(0)
    }
  }

  cbWsTrade(trade: WSTrade, exchange: ExchangeEnum) {
    this.mainData[exchange].lastDataTrade = +new Date()
    const symbol = trade.s
    const interval = trade.k.i
    const data: Candle & { uniqueMessageId: string } = {
      start: +trade.k.t,
      open: trade.k.o,
      high: trade.k.h,
      low: trade.k.l,
      close: trade.k.c,
      volume: trade.k.v,
      uniqueMessageId: `${symbol}${trade.k.t}${trade.k.o}${trade.k.h}${trade.k.l}${trade.k.c}${trade.k.v}${interval}@${exchange}`,
    }
    this.redis.publish(
      `${this.getCandleRoomName(symbol, exchange, interval)}`,
      JSON.stringify(data),
    )
  }

  private watchdogFn() {
    const now = new Date().getTime()
    const keys = Object.keys(this.mainData) as ExchangeEnum[]
    for (const exchange of keys) {
      if (
        exchange === ExchangeEnum.binanceUS ||
        exchange === ExchangeEnum.mexc
      ) {
        continue
      }
      if (!this.isCandle || this.isAll) {
        if (
          this.mainData[exchange].lastData === 0 &&
          now - this.mainData[exchange].connectTime > this.connectTime
        ) {
          throw new Error(
            `Exchange exceed connect time ${Math.floor(
              (now - this.mainData[exchange].connectTime) / 1000,
            )}s | ${exchange}`,
          )
        }
        if (
          this.mainData[exchange].lastData > 0 &&
          now - this.mainData[exchange].lastData > this.timeout
        ) {
          throw new Error(
            `Exchange not received new data for ${Math.floor(
              (now - this.mainData[exchange].lastData) / 1000,
            )}s | ${exchange}`,
          )
        }
      }
      if (this.isCandle || this.isAll) {
        if (
          (this.mainData[exchange].lastDataTrade ?? 0) > 0 &&
          now - (this.mainData[exchange].lastDataTrade ?? now) >
            this.tradeTimeout
        ) {
          throw new Error(
            `Trades on exchange not received new data for ${Math.floor(
              (now - (this.mainData[exchange].lastDataTrade ?? 0)) / 1000,
            )}s | ${exchange}`,
          )
        }
      }
    }
  }

  stop() {
    logger.info('Closing connector')
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
  }

  commonWsOpenCb(e: ExchangeEnum, type: StreamType) {
    return (data: any) => {
      logger.info(`${e.toUpperCase()} ${type} opened ${data.wsKey}`)
    }
  }

  commonWsReconnectCb(e: ExchangeEnum, type: StreamType) {
    return (data: any) => {
      logger.info(`${e.toUpperCase()} ${type} reconnected ${data?.wsKey}`)
    }
  }

  subscribeCandleCb(_data: SubscribeCandlePayload) {
    return
  }
}

export default CommonConnector
