import { parentPort } from 'worker_threads'
import { ExchangeEnum } from '../utils/common'
import RedisClient, { RedisWrapper } from '../utils/redis'
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
const tradeTimeout = +(process.env.TRADESTIMEOUT || '0') || 0

class CommonConnector {
  mainData: {
    [x: string]: {
      lastData: number
      lastDataTrade?: number
      connectTime: number
    }
  } = {}
  watchdog: NodeJS.Timeout | null = null
  timeout = 50000
  tradeTimeout = tradeTimeout || (priceRole === 'candle' ? 75000 : 50000)
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
  private redis: RedisWrapper | null = null

  /**
   * Fix #1 (stall isolation): before crashing the whole worker on a stall, a
   * connector may attempt a targeted restart of just the affected exchange's
   * streams via `handleStall`. We only allow a bounded number of targeted
   * recoveries between real data events; after that we escalate to the old
   * full-worker restart (throw) so a genuinely dead worker still gets nuked.
   */
  private targetedRestartCount = 0
  private maxTargetedRestarts = 2

  constructor() {
    this.cbWs = this.cbWs.bind(this)
    this.cbWsTrade = this.cbWsTrade.bind(this)
    this.watchdogFn = this.watchdogFn.bind(this)
    this.watchdog = setInterval(this.watchdogFn, this.timeout)
    this.subscribeCandleCb = this.subscribeCandleCb.bind(this)
    this.commonWsOpenCb = this.commonWsOpenCb.bind(this)
    this.commonWsReconnectCb = this.commonWsReconnectCb.bind(this)
    this.intiRedis()
    parentPort?.on('message', (msg: { do: string; data: any }) => {
      if (msg?.do === 'subscribeCandle') {
        const d = msg.data as SubscribeCandlePayload
        this.subscribeCandleCb(d)
      }
    })
  }

  private async intiRedis() {
    this.redis = await RedisClient.getInstance()
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
    this.targetedRestartCount = 0
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

      this.redis?.publish(
        `trade@${symbol}@${exchange}`,
        JSON.stringify({ ...data, exchange }),
      )

      await sleep(0)
    }
  }

  cbWsTrade(trade: WSTrade, exchange: ExchangeEnum) {
    this.noteCandleActivity(exchange)
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
    this.redis?.publish(
      `${this.getCandleRoomName(symbol, exchange, interval)}`,
      JSON.stringify(data),
    )
  }

  /**
   * Make a watchdog-triggered self-restart visible to ops. The price/candle
   * stall recovery is otherwise silent (worker throws -> exits -> parent
   * respawns). We publish a structured event to the existing `serviceLog`
   * Redis channel; main-app's serviceLog consumer forwards it to the watchdog
   * alerting path. Fire-and-forget — must never block or replace the throw.
   */
  private reportStall(
    exchange: ExchangeEnum,
    kind: 'price' | 'candle' | 'connect',
    staleSeconds: number,
  ) {
    try {
      this.redis?.publish(
        'serviceLog',
        JSON.stringify({
          watchdogStall: { exchange, kind, staleSeconds, role: priceRole },
        }),
      )
    } catch (e) {
      logger.error(`Failed to publish watchdog stall for ${exchange}: ${e}`)
    }
  }

  /**
   * Record that a candle feed is alive for `exchange`. Called on *every* kline
   * frame (confirmed or not), which is what the watchdog uses for liveness —
   * so a healthy feed sitting between candle closes isn't misread as dead.
   * Also clears the targeted-restart budget: real data means recovery worked.
   */
  protected noteCandleActivity(exchange: ExchangeEnum) {
    this.mainData[exchange].lastDataTrade = +new Date()
    this.targetedRestartCount = 0
  }

  /**
   * Overridable per-exchange stall recovery. Return true if the connector
   * performed a targeted restart of just this exchange's streams (so the
   * watchdog should NOT crash the whole worker); return false to fall back to
   * the full-worker restart. Base connectors don't isolate → always throw.
   */
  protected handleStall(
    _exchange: ExchangeEnum,
    _kind: 'price' | 'candle' | 'connect',
  ): boolean {
    return false
  }

  /**
   * Try a bounded targeted restart before escalating to a full-worker crash.
   * Returns true when the stall was handled in-place (skip the throw).
   */
  private escalateOrHandle(
    exchange: ExchangeEnum,
    kind: 'price' | 'candle' | 'connect',
  ): boolean {
    if (this.targetedRestartCount >= this.maxTargetedRestarts) {
      return false
    }
    const handled = this.handleStall(exchange, kind)
    if (handled) {
      this.targetedRestartCount++
      logger.info(
        `Targeted restart ${this.targetedRestartCount}/${this.maxTargetedRestarts} for ${kind} stall | ${exchange}`,
      )
    }
    return handled
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
          const stale = Math.floor(
            (now - this.mainData[exchange].connectTime) / 1000,
          )
          this.reportStall(exchange, 'connect', stale)
          if (this.escalateOrHandle(exchange, 'connect')) {
            this.mainData[exchange].connectTime = now
            continue
          }
          throw new Error(
            `Exchange exceed connect time ${stale}s | ${exchange}`,
          )
        }
        if (
          this.mainData[exchange].lastData > 0 &&
          now - this.mainData[exchange].lastData > this.timeout
        ) {
          const stale = Math.floor(
            (now - this.mainData[exchange].lastData) / 1000,
          )
          this.reportStall(exchange, 'price', stale)
          if (this.escalateOrHandle(exchange, 'price')) {
            this.mainData[exchange].lastData = now
            continue
          }
          throw new Error(
            `Exchange not received new data for ${stale}s | ${exchange}`,
          )
        }
      }
      if (this.isCandle || this.isAll) {
        if (
          (this.mainData[exchange].lastDataTrade ?? 0) > 0 &&
          now - (this.mainData[exchange].lastDataTrade ?? now) >
            this.tradeTimeout
        ) {
          const stale = Math.floor(
            (now - (this.mainData[exchange].lastDataTrade ?? 0)) / 1000,
          )
          this.reportStall(exchange, 'candle', stale)
          if (this.escalateOrHandle(exchange, 'candle')) {
            this.mainData[exchange].lastDataTrade = now
            continue
          }
          throw new Error(
            `Trades on exchange not received new data for ${stale}s | ${exchange}`,
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
