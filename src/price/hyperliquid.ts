import * as hl from '@nktkas/hyperliquid'

import { ExchangeEnum, mapPaperToReal } from '../utils/common'
import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'
import CommonConnector from './common'

import type { Ticker, StreamType, SubscribeCandlePayload } from './types'

const mutex = new IdMutex()

const maxCandlesPerConnection = 1000

class HyperliquidConnector extends CommonConnector {
  private unsubscribeMap: Map<StreamType, hl.Subscription[]> = new Map()
  private timer: NodeJS.Timeout | null = null
  private inQueueCandles: Map<
    string,
    {
      coin: string
      inteval: hl.WsCandleParameters['interval']
    }
  > = new Map()
  private hyperliquidClient: hl.SubscriptionClient =
    this.getHyperliquidClient('ticker')
  private hyperliquidClientCandle: {
    client: hl.SubscriptionClient
    id: number
    count: number
  }[] = [
    {
      id: 0,
      count: 0,
      client: this.getHyperliquidClient('candle'),
    },
  ]
  constructor(
    private subscribedCandlesMap: Map<ExchangeEnum, Set<string>> = new Map(),
  ) {
    super()
    this.hyperliquidTickerCb = this.hyperliquidTickerCb.bind(this)
    this.hyperliquidCandleCb = this.hyperliquidCandleCb.bind(this)
    this.mainData = {
      [ExchangeEnum.hyperliquid]: this.base,
      [ExchangeEnum.hyperliquidInverse]: this.base,
    }
    logger.info(`Hyperliquid Worker | >🚀 Price <-> Backend stream`)
  }

  private async hyperliquidTickerCb(msg: hl.WsAllMids) {
    const convert = await this.convertHyperliquidTicker(msg.mids)
    this.cbWs(convert.spot, ExchangeEnum.hyperliquid)
    this.cbWs(convert.inverse, ExchangeEnum.hyperliquidInverse)
  }

  private async hyperliquidCandleCb(msg: hl.Candle) {
    this.cbWsTrade(
      {
        e: 'kline',
        E: +new Date(),
        s: msg.s,
        k: {
          o: msg.o,
          h: msg.h,
          l: msg.l,
          c: msg.c,
          v: msg.v,
          i: msg.i,
          t: msg.t,
        },
      },
      msg.s.startsWith('@')
        ? ExchangeEnum.hyperliquid
        : ExchangeEnum.hyperliquidInverse,
    )
  }

  private getHyperliquidClient(
    type: StreamType,
    current?: hl.SubscriptionClient,
  ) {
    if (current) {
      const get = this.unsubscribeMap.get(type)
      if (get) {
        get.forEach((g) => g.unsubscribe())
      }
    }
    const client = new hl.SubscriptionClient({
      transport: new hl.WebSocketTransport({
        url:
          process.env.HYPERLIQUIDENV === 'demo'
            ? 'wss://api.hyperliquid-testnet.xyz/ws'
            : 'wss://api.hyperliquid.xyz/ws',
      }),
    })
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
        [
          ExchangeEnum.hyperliquidInverse,
          ExchangeEnum.paperHyperliquidInverse,
          ExchangeEnum.hyperliquid,
          ExchangeEnum.paperHyperliquid,
        ].includes(exchange)
      ) {
        this.connectHyperliquidCandleStreams([
          { symbol, interval: interval as hl.WsCandleParameters['interval'] },
        ])
      }
    }
  }

  async init() {
    if (!this.isCandle || this.isAll) {
      this.initHyperliquidWS()
    }
    if (this.isCandle || this.isAll) {
      this.reconnectHyperliquidCandleStream()
    }
  }

  private stopHyperliquid() {
    this.hyperliquidClient = this.getHyperliquidClient(
      'ticker',
      this.hyperliquidClient,
    )
    this.hyperliquidClientCandle = this.hyperliquidClientCandle.map((c) => ({
      id: c.id,
      count: 0,
      client: this.getHyperliquidClient('candle', c.client),
    }))
  }

  private hyperliquidRestartCb() {
    this.stopHyperliquid()
    this.initHyperliquidWS()
    this.reconnectHyperliquidCandleStream()
  }

  private async initHyperliquidWS() {
    try {
      const client = this.hyperliquidClient
      const unsubscribe = await client.allMids(this.hyperliquidTickerCb)
      this.unsubscribeMap.set(`ticker`, [unsubscribe])
    } catch {
      this.hyperliquidRestartCb()
    }
  }

  private async reconnectHyperliquidCandleStream() {
    const all =
      this.subscribedCandlesMap.get(ExchangeEnum.hyperliquid) ?? new Set()
    const store: string[][] = []
    all.forEach((s) => {
      store.push(this.splitCandleRoomName(s))
    })
    this.connectHyperliquidCandleStreams(
      store.map(([symbol, interval]) => ({
        symbol,
        interval: interval as hl.WsCandleParameters['interval'],
      })),
    )
  }

  @IdMute(mutex, () => `getCandleClient`)
  private async getCandleClient(count: number) {
    const find = [
      ...this.hyperliquidClientCandle.filter(
        (c) => c.count < maxCandlesPerConnection,
      ),
    ].sort((a, b) => a.count - b.count)[0]
    if (find) {
      find.count += count
      this.hyperliquidClientCandle = this.hyperliquidClientCandle.map((c) =>
        c.id === find.id ? { ...c, count: find.count } : c,
      )
      return find.client
    }
    logger.info('Creating new Hyperliquid candle client')
    const client = this.getHyperliquidClient('candle')
    this.hyperliquidClientCandle.push({
      count,
      client,
      id: this.hyperliquidClientCandle.length,
    })
    return client
  }

  @IdMute(mutex, () => 'connectHyperliquid')
  private async connectHyperliquidCandleStreams(
    _data: { symbol: string; interval: hl.WsCandleParameters['interval'] }[],
    timer = false,
  ) {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const data = _data.map(({ symbol, interval }) => {
      const topic = `${interval}@${symbol}`
      const e = ExchangeEnum.hyperliquid
      const set = this.subscribedCandlesMap.get(e) ?? new Set()
      set.add(topic)
      this.subscribedCandlesMap.set(e, set)
      return { coin: symbol, interval }
    })
    if (!timer) {
      data.forEach((d) => {
        this.inQueueCandles.set(`${d.coin}-${d.interval}`, {
          coin: d.coin,
          inteval: d.interval,
        })
      })
      const t = setTimeout(() => {
        this.connectHyperliquidCandleStreams([], true)
      }, 5000)
      this.timer = t
      return
    }
    const subscribeChannels = [...(this.inQueueCandles?.values() ?? [])].map(
      (d) => ({
        coin: d.coin,
        interval: d.inteval,
      }),
    )
    const keys = [...(this.inQueueCandles?.keys() ?? [])]
    for (const k of keys) {
      this.inQueueCandles?.delete(k)
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
        coin: string
        interval: hl.WsCandleParameters['interval']
      }[][],
    )
    for (const chunk of chunks) {
      const client = await this.getCandleClient(chunk.length)
      if (client) {
        for (const c of chunk) {
          const unsubscribe = await client.candle(
            { coin: c.coin, interval: c.interval },
            this.hyperliquidCandleCb,
          )
          const get = this.unsubscribeMap.get('candle') ?? []
          get.push(unsubscribe)
          this.unsubscribeMap.set('candle', get)
        }
      }
    }
  }

  stop() {
    super.stop()
    this.stopHyperliquid()
  }

  private async convertHyperliquidTicker(
    data: hl.WsAllMids['mids'],
  ): Promise<{ spot: Ticker[]; inverse: Ticker[] }> {
    const spot: Ticker[] = []
    const inverse: Ticker[] = []
    await Promise.all(
      Object.entries(data).map(async ([coin, price]) => {
        const v = {
          eventType: '24hrMiniTicker',
          eventTime: +new Date(),
          curDayClose: price,
          open: price,
          high: price,
          low: price,
          volume: '10000000',
          volumeQuote: '10000000',
          symbol: coin,
          bestBid: price,
          bestAsk: price,
          bestAskQnt: price,
          bestBidQnt: price,
        }
        if (coin.startsWith('@')) {
          spot.push(v)
        } else {
          inverse.push(v)
        }
      }),
    )
    return { spot, inverse }
  }
}

export default HyperliquidConnector
