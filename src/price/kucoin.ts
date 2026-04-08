import KucoinWSClient from '@gainium/kucoin-api'
import { ExchangeEnum, mapPaperToReal } from '../utils/common'
import logger from '../utils/logger'
import sleep from '../utils/sleep'
import {
  convertSymbolToKucoin,
  convertSymbol,
  convertIntervalToKucoin,
} from '../utils/kucoin'
import getAllExchangeInfo from '../utils/exchange'
import { IdMute, IdMutex } from '../utils/mutex'

import CommonConnector from './common'

import type { SubscribeCandlePayload } from './types'

type KucoinClient = {
  client: KucoinWSClient
  subs: number
  id: number
}[]

const maxSubs = 290
// Classic API: ≤ 400 topics for spot, no limit for futures.
// Stay well under spot limit; reuse same number for futures pooling sanity.
const maxCandlesPerConnection = 380

const mutex = new IdMutex()

class KucoinConnector extends CommonConnector {
  private kucoinClient: KucoinClient = [
    { client: this.getKucoinClient(), id: 0, subs: 0 },
  ]
  private kucoinUsdmClient: KucoinClient = [
    { client: this.getKucoinClient(), id: 0, subs: 0 },
  ]
  private kucoinCoinmClient: KucoinClient = [
    { client: this.getKucoinClient(), id: 0, subs: 0 },
  ]
  private kucoinCandleClient: KucoinClient = [
    { client: this.getKucoinClient(), id: 0, subs: 0 },
  ]
  private kucoinCandleUsdmClient: KucoinClient = [
    { client: this.getKucoinClient(), id: 0, subs: 0 },
  ]
  private kucoinCandleCoinmClient: KucoinClient = [
    { client: this.getKucoinClient(), id: 0, subs: 0 },
  ]
  private kucoinErrors = 0

  constructor(
    private subscribedCandlesMap: Map<ExchangeEnum, Set<string>> = new Map(),
  ) {
    super()
    this.mainData = {
      [ExchangeEnum.kucoin]: this.base,
      [ExchangeEnum.kucoinInverse]: this.base,
      [ExchangeEnum.kucoinLinear]: this.base,
    }
    logger.info(`Kucoin Worker | >🚀 Price <-> Backend stream`)
  }

  private getKucoinClient(current?: KucoinWSClient) {
    if (current) {
      const ws = current.ws().ws().public.ws
      if (ws) {
        ws.onclose = () => null
        try {
          ws.close()
        } catch (e) {
          logger.info(`Cannot close kucoin ws ${(e as Error)?.message ?? e}`)
        }
      }
    }
    return new KucoinWSClient()
  }

  async init() {
    if (!this.isCandle || this.isAll) {
      this.initKucoinWS()
    }
    if (this.isCandle || this.isAll) {
      this.reconnectKucoinCandleStream()
    }
  }

  private stopKucoin() {
    this.kucoinClient = this.kucoinClient.map((k) => ({
      client: this.getKucoinClient(k.client),
      subs: 0,
      id: k.id,
    }))
    this.kucoinUsdmClient = this.kucoinUsdmClient.map((k) => ({
      client: this.getKucoinClient(k.client),
      subs: 0,
      id: k.id,
    }))
    this.kucoinCoinmClient = this.kucoinUsdmClient.map((k) => ({
      client: this.getKucoinClient(k.client),
      subs: 0,
      id: k.id,
    }))
    this.kucoinCandleClient = this.kucoinCandleClient.map((k) => ({
      client: this.getKucoinClient(k.client),
      subs: 0,
      id: k.id,
    }))
    this.kucoinCandleUsdmClient = this.kucoinCandleUsdmClient.map((k) => ({
      client: this.getKucoinClient(k.client),
      subs: 0,
      id: k.id,
    }))
    this.kucoinCandleCoinmClient = this.kucoinCandleCoinmClient.map((k) => ({
      client: this.getKucoinClient(k.client),
      subs: 0,
      id: k.id,
    }))
  }

  private async kucoinError(msg: string) {
    logger.info(`Kucoin error: ${msg}`)
    if (
      msg.indexOf('Kucoin WS closed') !== -1 ||
      msg.indexOf('Ping error') !== -1
    ) {
      this.kucoinErrors += 1
      if (this.kucoinErrors >= 5) {
        process.exit(1)
      }
    }
  }

  private async initKucoinWS() {
    await this.kucoinClient[0]?.client
      .ws()
      .tickerAll(
        (ticker) => this.cbWs([ticker], ExchangeEnum.kucoin),
        this.kucoinError.bind(this),
      )
    await sleep(2000)
    const usdmData = await getAllExchangeInfo(ExchangeEnum.kucoinLinear)
    let chunks = usdmData.reduce((resultArray, item, index) => {
      const chunkIndex = Math.floor(index / maxSubs)
      if (!resultArray[chunkIndex]) {
        resultArray[chunkIndex] = []
      }
      resultArray[chunkIndex].push(item)
      return resultArray
    }, [] as string[][])
    let i = 0
    for (const chunk of chunks) {
      const cl = this.kucoinUsdmClient
        .filter((c) => c.subs < maxSubs)
        .sort((a, b) => b.subs - a.subs)[0]
      if (cl) {
        await cl.client.ws().futuresTicker(
          chunk.map((s) => convertSymbolToKucoin(s)),
          (ticker) =>
            this.cbWs(
              [{ ...ticker, symbol: convertSymbol(ticker.symbol) }],
              ExchangeEnum.kucoinLinear,
            ),
          this.kucoinError.bind(this),
        )
        cl.subs += chunk.length
        this.kucoinUsdmClient = this.kucoinUsdmClient.map((c) =>
          c.id === cl.id ? { ...cl } : c,
        )
      } else {
        const cl = this.getKucoinClient()
        await cl.ws().futuresTicker(
          chunk.map((s) => convertSymbolToKucoin(s)),
          (ticker) =>
            this.cbWs(
              [{ ...ticker, symbol: convertSymbol(ticker.symbol) }],
              ExchangeEnum.kucoinLinear,
            ),
          this.kucoinError.bind(this),
        )
        const last =
          this.kucoinUsdmClient.sort((a, b) => b.id - a.id)[0]?.id ?? 0
        this.kucoinUsdmClient.push({
          client: cl,
          subs: chunk.length,
          id: last + 1,
        })
      }
      i++
      logger.info(
        `Subscribed to chunk ${i} of ${chunks.length} kucoin USDM markets`,
      )
      await sleep(2000)
    }

    const coinmData = await getAllExchangeInfo(ExchangeEnum.kucoinInverse)
    chunks = usdmData.reduce((resultArray, item, index) => {
      const chunkIndex = Math.floor(index / maxSubs)
      if (!resultArray[chunkIndex]) {
        resultArray[chunkIndex] = []
      }
      resultArray[chunkIndex].push(item)
      return resultArray
    }, [] as string[][])
    i = 0
    for (const chunk of chunks) {
      const cl = this.kucoinCoinmClient
        .filter((c) => c.subs < maxSubs)
        .sort((a, b) => b.subs - a.subs)[0]
      if (cl) {
        await cl.client.ws().futuresTicker(
          coinmData.map((s) => convertSymbolToKucoin(s)),
          (ticker) =>
            this.cbWs(
              [{ ...ticker, symbol: convertSymbol(ticker.symbol) }],
              ExchangeEnum.kucoinInverse,
            ),
          this.kucoinError.bind(this),
        )
        cl.subs += chunk.length
        this.kucoinCoinmClient = this.kucoinCoinmClient.map((c) =>
          c.id === cl.id ? { ...cl } : c,
        )
      } else {
        const cl = this.getKucoinClient()
        await cl.ws().futuresTicker(
          coinmData.map((s) => convertSymbolToKucoin(s)),
          (ticker) =>
            this.cbWs(
              [{ ...ticker, symbol: convertSymbol(ticker.symbol) }],
              ExchangeEnum.kucoinInverse,
            ),
          this.kucoinError.bind(this),
        )
        const last =
          this.kucoinCoinmClient.sort((a, b) => b.id - a.id)[0]?.id ?? 0
        this.kucoinCoinmClient.push({
          client: cl,
          subs: chunk.length,
          id: last + 1,
        })
      }
      i++
      logger.info(
        `Subscribed to chunk ${i} of ${chunks.length} kucoin COINM markets`,
      )
      await sleep(2000)
    }
  }

  // Pending subscribes grouped by exchange -> set of `symbol|interval` items.
  // Kucoin's `topic` field accepts a comma-separated list of `SYMBOL_TYPE`
  // items within the same channel, so we collapse all queued items per
  // exchange into ONE topic / ONE subscribe message. The flush timer is
  // RESET on each new arrival so a burst of one-by-one rabbit messages
  // accumulates into a single subscribe once the stream goes quiet.
  private pendingCandles: Map<ExchangeEnum, Set<string>> = new Map()
  private pendingFlushTimer: NodeJS.Timeout | null = null
  private static BATCH_FLUSH_MS = 5000
  // Cap items per topic to stay under kucoin's classic 100 topics-per-request
  // limit (the API counts comma-joined items in one topic against this).
  private static BATCH_MAX_ITEMS = 100

  override subscribeCandleCb({
    symbol,
    exchange: _exchange,
    interval,
  }: SubscribeCandlePayload) {
    if (!this.isCandle && !this.isAll) {
      return
    }
    const exchange = mapPaperToReal(_exchange, false)
    if (
      ![
        ExchangeEnum.kucoin,
        ExchangeEnum.kucoinLinear,
        ExchangeEnum.kucoinInverse,
      ].includes(exchange)
    ) {
      return
    }
    const kucoinInterval = convertIntervalToKucoin(interval)
    const room = this.getCandleRoomName(symbol, exchange, kucoinInterval)
    const set = this.subscribedCandlesMap.get(exchange) ?? new Set()
    if (set.has(room)) {
      return
    }
    set.add(room)
    this.subscribedCandlesMap.set(exchange, set)
    this.queueCandleSubscribe(symbol, kucoinInterval, exchange)
  }

  private queueCandleSubscribe(
    symbol: string,
    interval: string,
    exchange: ExchangeEnum,
  ) {
    const group = this.pendingCandles.get(exchange) ?? new Set<string>()
    group.add(`${symbol}|${interval}`)
    this.pendingCandles.set(exchange, group)
    // Trailing debounce: each new arrival resets the timer; once the burst
    // goes quiet for BATCH_FLUSH_MS we flush everything in one batch.
    if (this.pendingFlushTimer) {
      clearTimeout(this.pendingFlushTimer)
    }
    this.pendingFlushTimer = setTimeout(() => {
      this.pendingFlushTimer = null
      this.flushPendingCandles().catch((e) =>
        logger.info(`Kucoin candle flush error: ${(e as Error)?.message ?? e}`),
      )
    }, KucoinConnector.BATCH_FLUSH_MS)
  }

  @IdMute(mutex, () => 'kucoinCandleFlush')
  private async flushPendingCandles() {
    // Snapshot + clear is wrapped by the mutex so a second flush that fires
    // while the first is still mid-await waits its turn instead of grabbing
    // an overlapping snapshot of the pending map.
    const entries = Array.from(this.pendingCandles.entries())
    this.pendingCandles.clear()

    for (const [exchange, items] of entries) {
      const pairs: { symbol: string; interval: string }[] = []
      items.forEach((it) => {
        const [symbol, interval] = it.split('|')
        if (symbol && interval) {
          pairs.push({ symbol, interval })
        }
      })
      for (let i = 0; i < pairs.length; i += KucoinConnector.BATCH_MAX_ITEMS) {
        const chunk = pairs.slice(i, i + KucoinConnector.BATCH_MAX_ITEMS)
        await this.connectKucoinCandleStream(chunk, exchange)
      }
    }
  }

  private getCandlePool(exchange: ExchangeEnum): KucoinClient {
    if (exchange === ExchangeEnum.kucoinLinear) {
      return this.kucoinCandleUsdmClient
    }
    if (exchange === ExchangeEnum.kucoinInverse) {
      return this.kucoinCandleCoinmClient
    }
    return this.kucoinCandleClient
  }

  private setCandlePool(exchange: ExchangeEnum, pool: KucoinClient) {
    if (exchange === ExchangeEnum.kucoinLinear) {
      this.kucoinCandleUsdmClient = pool
    } else if (exchange === ExchangeEnum.kucoinInverse) {
      this.kucoinCandleCoinmClient = pool
    } else {
      this.kucoinCandleClient = pool
    }
  }

  @IdMute(mutex, (exchange: ExchangeEnum) => `getKucoinCandleClient${exchange}`)
  private async getCandleClient(exchange: ExchangeEnum, count: number) {
    const pool = this.getCandlePool(exchange)
    const find = [
      ...pool.filter((c) => c.subs + count <= maxCandlesPerConnection),
    ].sort((a, b) => a.subs - b.subs)[0]
    if (find) {
      find.subs += count
      const next = pool.map((c) =>
        c.id === find.id ? { ...c, subs: find.subs } : c,
      )
      this.setCandlePool(exchange, next)
      return find.client
    }
    logger.info(`Creating new kucoin ${exchange} candle client`)
    const client = this.getKucoinClient()
    const last = pool.sort((a, b) => b.id - a.id)[0]?.id ?? -1
    pool.push({ client, subs: count, id: last + 1 })
    this.setCandlePool(exchange, pool)
    return client
  }

  private async connectKucoinCandleStream(
    pairs: { symbol: string; interval: string }[],
    exchange: ExchangeEnum,
  ) {
    if (!pairs.length) {
      return
    }
    // interval is expected to already be in kucoin format
    // (e.g. '1min', '5min', '1hour', '1day') — caller is responsible.
    const client = await this.getCandleClient(exchange, pairs.length)
    if (!client) {
      return
    }
    const isFutures =
      exchange === ExchangeEnum.kucoinLinear ||
      exchange === ExchangeEnum.kucoinInverse
    // Map of canonical symbol -> canonical interval, used by the inbound
    // callback to recover the interval (kucoin returns it in `topic`).
    const kucoinPairs = pairs.map((p) => ({
      symbol: isFutures ? convertSymbolToKucoin(p.symbol) : p.symbol,
      type: p.interval,
    }))
    const cb = (k: {
      symbol: string
      candles: string[]
      time: number
      interval: string
    }) => {
      // candles: [start, open, close, high, low, volume, ...]
      const canonicalSymbol = isFutures ? convertSymbol(k.symbol) : k.symbol
      this.cbWsTrade(
        {
          e: 'kline',
          E: k.time,
          s: canonicalSymbol,
          k: {
            t: +k.candles[0] * 1000,
            o: k.candles[1],
            c: k.candles[2],
            h: k.candles[3],
            l: k.candles[4],
            v: k.candles[5],
            i: k.interval,
          },
        },
        exchange,
      )
    }
    try {
      if (isFutures) {
        await client
          .ws()
          .futuresKlines(kucoinPairs, cb, this.kucoinError.bind(this))
      } else {
        await client.ws().klines(kucoinPairs, cb, this.kucoinError.bind(this))
      }
    } catch (e) {
      logger.info(
        `Kucoin candle subscribe failed for ${pairs.length} items on ${exchange}: ${
          (e as Error)?.message ?? e
        }`,
      )
    }
  }

  private async reconnectKucoinCandleStream() {
    for (const exchange of [
      ExchangeEnum.kucoin,
      ExchangeEnum.kucoinLinear,
      ExchangeEnum.kucoinInverse,
    ]) {
      const all = this.subscribedCandlesMap.get(exchange) ?? new Set()
      const pairs: { symbol: string; interval: string }[] = []
      all.forEach((room) => {
        const [symbol, interval] = this.splitCandleRoomName(room)
        if (symbol && interval) {
          pairs.push({ symbol, interval })
        }
      })
      for (let i = 0; i < pairs.length; i += KucoinConnector.BATCH_MAX_ITEMS) {
        const chunk = pairs.slice(i, i + KucoinConnector.BATCH_MAX_ITEMS)
        await this.connectKucoinCandleStream(chunk, exchange)
        await sleep(50)
      }
    }
  }

  stop() {
    super.stop()
    this.stopKucoin()
  }
}

export default KucoinConnector
