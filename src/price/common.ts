import { parentPort } from 'worker_threads'
import { ExchangeEnum } from '../utils/common'
import RedisClient, { RedisWrapper } from '../utils/redis'
import sleep from '../utils/sleep'
import logger from '../utils/logger'
import { stallCounter } from './stallEscalation'

import type {
  Ticker,
  Candle,
  WSTrade,
  StreamType,
  SubscribeCandlePayload,
} from './types'

const priceRole = process.env.PRICEROLE
const tradeTimeout = +(process.env.TRADESTIMEOUT || '0') || 0
const marketPriceTimeout = 3 * 60 * 1000

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
  /**
   * A fresh liveness record for one market. A getter, so every
   * `mainData[market] = this.base` gets its own: the connectors used to share
   * one object between all their markets, so data on any market refreshed
   * them all and a dead market was hidden by a live sibling.
   */
  get base() {
    return {
      lastData: 0,
      lastDataTrade: 0,
      connectTime: +new Date(),
      ticker: null,
      trade: null,
    }
  }
  private redis: RedisWrapper | null = null

  /**
   * Fix #1 (stall isolation): before crashing the whole worker on a stall, a
   * connector may attempt a targeted restart of just the affected exchange's
   * streams via `handleStall`. We only allow a bounded number of targeted
   * recoveries between real data events; after that we escalate to the old
   * full-worker restart (throw) so a genuinely dead worker still gets nuked.
   */
  private targetedRestarts: Map<ExchangeEnum, number> = new Map()
  private maxTargetedRestarts = 2

  /**
   * The same budget for a single silent socket among an exchange's several
   * (`checkClientStalls`): recreations of that socket with no data from it in
   * between. Kept per socket because its peers' data resets the exchange-wide
   * budget above on every tick.
   */
  private clientRestarts: Map<string, number> = new Map()
  /** Last `serviceLog` stall report per feed for single-socket stalls. */
  private clientStallReported: Map<string, number> = new Map()
  private clientStallReportInterval = 5 * 60 * 1000

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
    this.targetedRestarts.delete(exchange)
    stallCounter.noteData(exchange, 'price')
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
    this.targetedRestarts.delete(exchange)
    stallCounter.noteData(exchange, 'candle')
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
   * Side-channel liveness check: is the underlying WS connection for `exchange`
   * still healthy even though no market data arrived within the timeout? Used to
   * suppress false-positive stalls on trade-driven feeds. Kraken's candle OHLC
   * (and ticker) feed only pushes on trades, so a thin/near-dead market goes
   * quiet far past the timeout while the socket is perfectly alive — the
   * kraken-api client keeps it up via heartbeat/pong and reconnects a dead one.
   * A CONNECTED-but-quiet socket is therefore not a real stall: advance liveness
   * and skip the crash. Tradeoff: a socket that stays open while a single topic
   * subscription silently dies won't be caught here (very rare on Kraken v2,
   * which persists + auto-resubscribes topics per connection) — a real socket
   * drop still flips this to false and triggers the targeted restart. Base
   * connectors have no side channel → false (unchanged behaviour).
   */
  protected isFeedAlive(
    _exchange: ExchangeEnum,
    _kind: 'price' | 'candle',
  ): boolean {
    return false
  }

  /**
   * Per-exchange candle-stall timeout. Trade-driven candle feeds with no
   * periodic frames (Kraken) legitimately go quiet far longer than the default
   * before the feed is genuinely dead, so those exchanges widen the window.
   * Default: the shared `tradeTimeout`.
   */
  protected getTradeTimeout(_exchange: ExchangeEnum): number {
    return this.tradeTimeout
  }

  /**
   * Per-socket stall check, run at the start of every watchdog pass. Override
   * in connectors that spread an exchange over several sockets; the
   * exchange-wide check below cannot see one of them going silent.
   */
  protected checkClientStalls(_now: number) {
    return
  }

  /** A socket delivered data: its single-socket stall budget is restored. */
  protected noteClientData(client: string) {
    this.clientRestarts.delete(client)
  }

  /**
   * One socket of `exchange` is silent while its peers deliver. Returns when
   * the caller should recreate just that socket. Once that has been tried
   * `maxTargetedRestarts` times with no data from the socket in between, it
   * throws the regular watchdog stall error instead, so the connector is
   * rebuilt (and `stallEscalation` counts it) as for any other stall.
   */
  protected handleClientStall(
    exchange: ExchangeEnum,
    kind: 'price' | 'candle',
    client: string,
    staleSeconds: number,
    detail: string,
  ) {
    const now = Date.now()
    const feed = `${kind}|${exchange}`
    if (
      now - (this.clientStallReported.get(feed) ?? 0) >=
      this.clientStallReportInterval
    ) {
      this.clientStallReported.set(feed, now)
      this.reportStall(exchange, kind, staleSeconds)
    }
    const count = this.clientRestarts.get(client) ?? 0
    if (count >= this.maxTargetedRestarts) {
      this.clientRestarts.delete(client)
      throw new Error(
        `${kind === 'candle' ? 'Trades on exchange' : 'Exchange'} not received new data for ${staleSeconds}s | ${exchange} (${detail})`,
      )
    }
    this.clientRestarts.set(client, count + 1)
    logger.info(
      `Recreating silent ${kind} socket ${count + 1}/${this.maxTargetedRestarts} | ${exchange} (${detail})`,
    )
  }

  /**
   * Try a bounded targeted restart before escalating to a full-worker crash.
   * Returns true when the stall was handled in-place (skip the throw).
   */
  private escalateOrHandle(
    exchange: ExchangeEnum,
    kind: 'price' | 'candle' | 'connect',
  ): boolean {
    const count = this.targetedRestarts.get(exchange) ?? 0
    if (count >= this.maxTargetedRestarts) {
      return false
    }
    const handled = this.handleStall(exchange, kind)
    if (handled) {
      this.targetedRestarts.set(exchange, count + 1)
      logger.info(
        `Targeted restart ${count + 1}/${this.maxTargetedRestarts} for ${kind} stall | ${exchange}`,
      )
    }
    return handled
  }

  /**
   * How long ONE market may go without a ticker while a sibling market of the
   * same connector still delivers. Longer than `timeout`, which still applies
   * when every market is quiet: a market with a handful of symbols can be
   * quiet for a while on its own. Override for thinner markets.
   */
  protected getPriceTimeout(_exchange: ExchangeEnum): number {
    return marketPriceTimeout
  }

  /**
   * Connect and candle stalls are judged across all of the connector's
   * markets: a market that is disabled, or has no candle subscription, never
   * delivers and must not read as dead. Ticker stalls are judged per market,
   * from the moment that market first delivered: after `timeout` when every
   * market is quiet, after `getPriceTimeout` when only that one is.
   */
  private watchdogFn() {
    const now = new Date().getTime()
    this.checkClientStalls(now)
    const keys = (Object.keys(this.mainData) as ExchangeEnum[]).filter(
      (e) => e !== ExchangeEnum.binanceUS && e !== ExchangeEnum.mexc,
    )
    if (!keys.length) {
      return
    }
    const markets = keys.map((e) => this.mainData[e])
    if (!this.isCandle || this.isAll) {
      const connectSince = Math.min(...markets.map((m) => m.connectTime))
      if (
        markets.every((m) => m.lastData === 0) &&
        now - connectSince > this.connectTime
      ) {
        const exchange = keys[0]
        const stale = Math.floor((now - connectSince) / 1000)
        this.reportStall(exchange, 'connect', stale)
        if (!this.escalateOrHandle(exchange, 'connect')) {
          throw new Error(
            `Exchange exceed connect time ${stale}s | ${exchange}`,
          )
        }
        markets.forEach((m) => (m.connectTime = now))
      }
      const newest = Math.max(...markets.map((m) => m.lastData))
      const allQuiet = newest > 0 && now - newest > this.timeout
      for (const exchange of keys) {
        const market = this.mainData[exchange]
        const limit = allQuiet ? this.timeout : this.getPriceTimeout(exchange)
        if (market.lastData === 0 || now - market.lastData <= limit) {
          continue
        }
        const stale = Math.floor((now - market.lastData) / 1000)
        if (this.isFeedAlive(exchange, 'price')) {
          market.lastData = now
          continue
        }
        this.reportStall(exchange, 'price', stale)
        if (!this.escalateOrHandle(exchange, 'price')) {
          throw new Error(
            `Exchange not received new data for ${stale}s | ${exchange}`,
          )
        }
        market.lastData = now
      }
    }
    if (this.isCandle || this.isAll) {
      const lastTrade = Math.max(...markets.map((m) => m.lastDataTrade ?? 0))
      // Named after the first market that has candles, as when the record
      // was shared — the per-exchange hooks below restart that market's.
      const exchange = keys.find(
        (e) => (this.mainData[e].lastDataTrade ?? 0) > 0,
      )
      if (exchange && now - lastTrade > this.getTradeTimeout(exchange)) {
        const stale = Math.floor((now - lastTrade) / 1000)
        const revive = () =>
          markets.forEach((m) => {
            if ((m.lastDataTrade ?? 0) > 0) {
              m.lastDataTrade = now
            }
          })
        if (this.isFeedAlive(exchange, 'candle')) {
          revive()
          return
        }
        this.reportStall(exchange, 'candle', stale)
        if (!this.escalateOrHandle(exchange, 'candle')) {
          throw new Error(
            `Trades on exchange not received new data for ${stale}s | ${exchange}`,
          )
        }
        revive()
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
