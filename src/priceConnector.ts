import { Worker } from 'worker_threads'
import { ExchangeEnum, mapPaperToReal } from './utils/common'
import logger from './utils/logger'
import { IdMute, IdMutex } from './utils/mutex'
import RedisClient, { RedisWrapper } from './utils/redis'
import RabbitClient from './utils/rabbit'
import {
  getEnabledSnapshot,
  isAdminConfigEnabled,
  isExchangeEnabled,
  onAdminConfigChange,
} from './utils/adminConfig'

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

/**
 * Worker family → its constituent ExchangeEnum variants. One Worker per
 * family handles all variants (spot + futures within the same exchange).
 * Used by both the env-flag fallback (PRICE_CONNECTOR_EXCHANGES) and
 * the admin-config diff-and-react logic: a family worker is needed iff
 * ANY of its variants is enabled.
 */
const FAMILY_VARIANTS: Record<string, ExchangeEnum[]> = {
  bybit: [ExchangeEnum.bybit, ExchangeEnum.bybitCoinm, ExchangeEnum.bybitUsdm],
  binance: [
    ExchangeEnum.binance,
    ExchangeEnum.binanceCoinm,
    ExchangeEnum.binanceUsdm,
    ExchangeEnum.binanceUS,
  ],
  okx: [ExchangeEnum.okx, ExchangeEnum.okxInverse, ExchangeEnum.okxLinear],
  kucoin: [
    ExchangeEnum.kucoin,
    ExchangeEnum.kucoinInverse,
    ExchangeEnum.kucoinLinear,
  ],
  bitget: [
    ExchangeEnum.bitget,
    ExchangeEnum.bitgetCoinm,
    ExchangeEnum.bitgetUsdm,
  ],
  hyperliquid: [ExchangeEnum.hyperliquid, ExchangeEnum.hyperliquidLinear],
  kraken: [ExchangeEnum.kraken, ExchangeEnum.krakenUsdm],
  coinbase: [ExchangeEnum.coinbase],
}

/** ExchangeEnum → which Worker key in this.workers handles it. */
const VARIANT_TO_WORKER_KEY: Record<string, ExchangeEnum> = (() => {
  const out: Record<string, ExchangeEnum> = {}
  for (const [family, variants] of Object.entries(FAMILY_VARIANTS)) {
    const workerKey = variants[0] // e.g. ExchangeEnum.bybit
    void family
    for (const v of variants) out[v] = workerKey
  }
  return out
})()

/** Connector class connects to every pair websocket stream separataly. This is a option to controll every pair socket stream, and reload it if necessary */
class Connector {
  private redis: RedisWrapper | null = null
  private rabbit = new RabbitClient()
  private workers: Map<ExchangeEnum, Worker> = new Map()
  private subscribedCandlesMap: Map<ExchangeEnum, Set<string>> = new Map()
  /**
   * Is at least one variant in this family enabled?
   *
   * When admin-config has loaded a set (sh deployment with the Redis
   * key present) it is the SOLE source of truth — the legacy
   * `PRICE_CONNECTOR_EXCHANGES` env is ignored. This matches the
   * operator's expectation: once you toggle exchanges in the Admin →
   * Exchanges tab, the docker-sh `.env` line stops being consulted.
   *
   * When admin-config has no set (cloud builds, or sh before the
   * admin-sh first-boot seed runs), fall back to the env: if
   * `PRICE_CONNECTOR_EXCHANGES` is set we treat it as a family-level
   * allow-list; otherwise every family is needed.
   */
  private isFamilyNeeded(family: string): boolean {
    const variants = FAMILY_VARIANTS[family]
    if (!variants) return false

    const adminEnabled = getEnabledSnapshot()
    if (adminEnabled !== null) {
      // Admin-config is authoritative.
      return variants.some((v) => adminEnabled.has(v))
    }

    // No admin-config set — fall back to env. binanceUS shares the
    // family name 'binance' here, so we treat both env tokens as alias.
    if (exchanges.length) {
      return family === 'binance'
        ? exchanges.includes('binance') || exchanges.includes('binanceus')
        : exchanges.includes(family)
    }
    return true
  }

  get isBinance() {
    return this.isFamilyNeeded('binance')
  }
  get isBinanceUS() {
    return exchanges.length ? exchanges.includes('binanceus') : true
  }
  get isBybit() {
    return this.isFamilyNeeded('bybit')
  }
  get isKucoin() {
    return this.isFamilyNeeded('kucoin')
  }
  get isOkx() {
    return this.isFamilyNeeded('okx')
  }
  get isCoinbase() {
    return this.isFamilyNeeded('coinbase')
  }
  get isBitget() {
    return this.isFamilyNeeded('bitget')
  }
  get isHyperliquid() {
    return this.isFamilyNeeded('hyperliquid')
  }
  get isKraken() {
    return this.isFamilyNeeded('kraken')
  }

  constructor() {
    this.initWorker = this.initWorker.bind(this)
    this.initRedis()
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

    if (isAdminConfigEnabled()) {
      onAdminConfigChange(() => this.reconcileWorkers())
    }
  }

  private async initRedis() {
    this.redis = await RedisClient.getInstance()
  }

  /**
   * Reconcile this.workers against the current isFamilyNeeded() answers.
   * Called once on init() (after admin-config sync completes) and on
   * every admin-config change. Symbol re-subscription is the responsibility
   * of upstream rabbit consumers — backend re-emits candlesRequests
   * after restarts, so a freshly-spawned worker gets re-fed naturally.
   */
  private reconcileWorkers() {
    for (const family of Object.keys(FAMILY_VARIANTS)) {
      const variants = FAMILY_VARIANTS[family]
      const workerKey = variants[0]
      const needed = this.isFamilyNeeded(family)
      const have = this.workers.has(workerKey)
      if (needed && !have) {
        logger.info(`admin-config: spawning ${family} worker`)
        this.initWorker(workerKey)
      } else if (!needed && have) {
        logger.info(`admin-config: terminating ${family} worker`)
        this.terminateFamily(workerKey)
      }
    }
  }

  /**
   * Tear down a single family's worker. Suppresses the 'exit' handler's
   * auto-restart so a deliberate termination doesn't immediately respawn.
   */
  private terminateFamily(workerKey: ExchangeEnum) {
    const worker = this.workers.get(workerKey)
    if (!worker) return
    worker.removeAllListeners('exit')
    worker.removeAllListeners('error')
    void worker.terminate()
    this.workers.delete(workerKey)
    this.subscribedCandlesMap.delete(workerKey)
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
      // Variant-level admin-config gate: skip silently when the operator
      // disabled this specific exchange (e.g. binanceUsdm) even though
      // the family's worker may still be alive for sibling variants.
      // In cloud builds isExchangeEnabled always returns true.
      if (!isExchangeEnabled(exchange)) {
        logger.info(
          `Skip subscribe ${symbol} ${exchange} ${interval}: exchange disabled by host config`,
        )
        return
      }
      const workerKey = VARIANT_TO_WORKER_KEY[exchange]
      if (!workerKey) return
      const worker = this.workers.get(workerKey)
      if (!worker) return
      worker.postMessage({
        do: 'subscribeCandle',
        data: { symbol, interval, exchange },
      })
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
    if (this.isHyperliquid) {
      this.initWorker(ExchangeEnum.hyperliquid)
    }
    if (this.isKraken) {
      this.initWorker(ExchangeEnum.kraken)
    }
  }

  stop() {
    logger.info('Closing connector')

    const bybitWorker = this.workers.get(ExchangeEnum.bybit)
    const binanceWorker = this.workers.get(ExchangeEnum.binance)
    const kucoinWorker = this.workers.get(ExchangeEnum.kucoin)
    const okxWorker = this.workers.get(ExchangeEnum.okx)
    const coinbaseWorker = this.workers.get(ExchangeEnum.coinbase)
    const bitgetWorker = this.workers.get(ExchangeEnum.bitget)
    const hyperliquidWorker = this.workers.get(ExchangeEnum.hyperliquid)
    const krakenWorker = this.workers.get(ExchangeEnum.kraken)
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
    bitgetWorker?.on('exit', () => null)
    bitgetWorker?.terminate()
    hyperliquidWorker?.on('exit', () => null)
    hyperliquidWorker?.terminate()
    krakenWorker?.on('exit', () => null)
    krakenWorker?.terminate()
  }
}

export default Connector
