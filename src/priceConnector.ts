import { Worker } from 'worker_threads'
import { ExchangeEnum, mapPaperToReal } from './utils/common'
import logger from './utils/logger'
import { IdMute, IdMutex } from './utils/mutex'
import RedisClient from './utils/redis'
import RabbitClient from './utils/rabbit'

const priceRole = process.env.PRICEROLE

export interface WSTrade {
  e: string
  E: number
  s: string
  k: {
    c: string
    v: string
    o: string
    h: string
    l: string
    i: string
    t: number
  }
}

export interface Ticker {
  eventType: string
  eventTime: number
  symbol: string
  curDayClose: string
  bestBid: string
  bestBidQnt: string
  bestAsk: string
  bestAskQnt: string
  open: string
  high: string
  low: string
  volume: string
  volumeQuote: string
}

export interface Candle {
  start: number
  open: string
  high: string
  low: string
  close: string
  volume: string
}

const mutex = new IdMutex()

const isCandle = priceRole === 'candle'
const isAll = priceRole === 'all'

const exchanges = (process.env.PRICE_CONNECTOR_EXCHANGES || '')
  .trim()
  .split(',')
  .filter(Boolean)

/** Connector class connects to every pair websocket stream separataly. This is a option to controll every pair socket stream, and reload it if necessary */
class Connector {
  private redis = RedisClient.getInstance()
  private rabbit = new RabbitClient()
  private workers: Map<ExchangeEnum, Worker> = new Map()
  private subscribedCandlesMap: Map<ExchangeEnum, Set<string>> = new Map()
  private isBinance = exchanges.length ? exchanges.includes('binance') : true
  private isBinanceUS = exchanges.length
    ? exchanges.includes('binanceus')
    : true
  private isBybit = exchanges.length ? exchanges.includes('bybit') : true
  private isKucoin = exchanges.length ? exchanges.includes('kucoin') : true
  private isOkx = exchanges.length ? exchanges.includes('okx') : true
  private isCoinbase = exchanges.length ? exchanges.includes('coinbase') : true
  private isBitget = exchanges.length ? exchanges.includes('bitget') : true
  constructor() {
    this.initWorker = this.initWorker.bind(this)
    if (isCandle || isAll) {
      this.rabbit.listenWithCallback<{
        symbol: string
        exchange: ExchangeEnum
        interval: string
      }>('candlesRequests', (msg) => {
        logger.info(
          `Received candle request ${msg.symbol} ${msg.exchange} ${msg.interval}`,
        )
        this.subscribeCandleCb()(msg)
      })
      logger.info(
        `>🚀 Price <-> Backend stream | Listen to candlesRequests channel`,
      )
    }
  }

  private subscribeCandleCb() {
    return ({
      symbol,
      exchange: _exchange,
      interval,
    }: {
      symbol: string
      exchange: ExchangeEnum
      interval: string
    }) => {
      logger.info(`Subscribe candle ${symbol} ${_exchange} ${interval}`)
      if (!isCandle && !isAll) {
        return
      }
      const exchange = mapPaperToReal(_exchange, false)
      const bybitWorker = this.workers.get(ExchangeEnum.bybit)
      const binanceWorker = this.workers.get(ExchangeEnum.binance)
      const kucoinWorker = this.workers.get(ExchangeEnum.kucoin)
      const okxWorker = this.workers.get(ExchangeEnum.okx)
      const bitgetWorker = this.workers.get(ExchangeEnum.bitget)
      const coinbaseWorker = this.workers.get(ExchangeEnum.coinbase)

      if (
        [
          ExchangeEnum.bybit,
          ExchangeEnum.bybitCoinm,
          ExchangeEnum.bybitUsdm,
        ].includes(exchange) &&
        bybitWorker
      ) {
        bybitWorker.postMessage({
          do: 'subscribeCandle',
          data: { symbol, interval, exchange },
        })
      }
      if (
        [
          ExchangeEnum.bitget,
          ExchangeEnum.bitgetCoinm,
          ExchangeEnum.bitgetUsdm,
        ].includes(exchange) &&
        bitgetWorker
      ) {
        bitgetWorker.postMessage({
          do: 'subscribeCandle',
          data: { symbol, interval, exchange },
        })
      }
      if (
        [
          ExchangeEnum.binance,
          ExchangeEnum.binanceCoinm,
          ExchangeEnum.binanceUsdm,
          ExchangeEnum.binanceUS,
        ].includes(exchange) &&
        binanceWorker
      ) {
        binanceWorker.postMessage({
          do: 'subscribeCandle',
          data: { symbol, interval, exchange },
        })
      }
      if (
        [
          ExchangeEnum.okx,
          ExchangeEnum.okxInverse,
          ExchangeEnum.okxLinear,
        ].includes(exchange) &&
        okxWorker
      ) {
        okxWorker.postMessage({
          do: 'subscribeCandle',
          data: { symbol, interval, exchange },
        })
      }
      if (
        [
          ExchangeEnum.kucoin,
          ExchangeEnum.kucoinInverse,
          ExchangeEnum.kucoinLinear,
        ].includes(exchange) &&
        kucoinWorker
      ) {
        kucoinWorker.postMessage({
          do: 'subscribeCandle',
          data: { symbol, interval, exchange },
        })
      }
      if ([ExchangeEnum.coinbase].includes(exchange) && coinbaseWorker) {
        coinbaseWorker.postMessage({
          do: 'subscribeCandle',
          data: { symbol, interval, exchange },
        })
      }
    }
  }

  @IdMute(mutex, (exchange: ExchangeEnum) => `${exchange}initWorker`)
  initWorker(exchange: ExchangeEnum) {
    if (this.workers.has(exchange)) {
      return
    }
    const worker = new Worker(`${__dirname}/price/worker.js`, {
      //@ts-ignore
      workerData: {
        path: `${__dirname}/price/service.js`,
        data: {
          exchange,
          payload: {
            subscribedCandlesMap: this.subscribedCandlesMap,
          },
          binance: {
            isIntl: this.isBinance,
            isUs: this.isBinanceUS,
          },
        },
      },
    })
    worker.on('error', (err) => {
      logger.error(`${exchange} Worker error:`, err)
      if (`${(err as Error)?.message || err}`.includes('terminated')) {
        this.workers.delete(exchange)
        this.initWorker(exchange)
      }
    })
    worker.on('exit', (code) => {
      logger.error(`${exchange} Worker stopped with code ${code}`)
      this.workers.delete(exchange)
      this.initWorker(exchange)
    })
    this.workers.set(exchange, worker)
  }

  async init() {
    if (isCandle || isAll) {
      this.redis?.publish(
        'serviceLog',
        JSON.stringify({ restart: 'priceConnector' }),
      )
    }
    if (this.isBybit) {
      this.initWorker(ExchangeEnum.bybit)
    }
    if (this.isBinance || this.isBinanceUS) {
      this.initWorker(ExchangeEnum.binance)
    }
    if (this.isOkx) {
      this.initWorker(ExchangeEnum.okx)
    }
    if (this.isCoinbase) {
      this.initWorker(ExchangeEnum.coinbase)
    }
    if (this.isKucoin) {
      this.initWorker(ExchangeEnum.kucoin)
    }
    if (this.isBitget) {
      this.initWorker(ExchangeEnum.bitget)
    }
  }

  stop() {
    logger.info('Closing connector')

    const bybitWorker = this.workers.get(ExchangeEnum.bybit)
    const binanceWorker = this.workers.get(ExchangeEnum.binance)
    const kucoinWorker = this.workers.get(ExchangeEnum.kucoin)
    const okxWorker = this.workers.get(ExchangeEnum.okx)
    const coinbaseWorker = this.workers.get(ExchangeEnum.coinbase)
    bybitWorker?.on('exit', () => null)
    bybitWorker?.terminate()
    binanceWorker?.on('exit', () => null)
    binanceWorker?.terminate()
    okxWorker?.on('exit', () => null)
    okxWorker?.terminate()
    coinbaseWorker?.on('exit', () => null)
    coinbaseWorker?.terminate()
    kucoinWorker?.on('exit', () => null)
    kucoinWorker?.terminate()
  }
}

export default Connector
