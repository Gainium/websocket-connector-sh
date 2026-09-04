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

/**
 * How often we re-announce this connector's boot generation on `serviceLog`.
 * Bounds how long a consumer can stay candle-blind after a connector restart
 * whose one-shot broadcast it missed.
 */
const BEACON_INTERVAL_MS = 60 * 1000

/**
 * Incremented per Connector instance so an in-process rebuild (the
 * unhandledRejection/uncaughtException handlers in index.price call
 * `stop()` then construct a fresh Connector) gets its own boot id — it
 * terminates every worker, so its candle subscriptions are gone too.
 */
let connectorGeneration = 0

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
  whitebit: [ExchangeEnum.whitebit, ExchangeEnum.whitebitUsdm],
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
   * Identifies this connector instance. Candle subscriptions live ONLY in
   * this process's memory (`subscribedCandlesMap` + the per-exchange worker
   * clients), so a new boot id means "every subscription I used to hold is
   * gone — re-request yours".
   */
  private readonly bootId = `${priceRole ?? 'ticker'}-${
    process.pid
  }-${+new Date()}-${++connectorGeneration}`
  private beaconTimer: NodeJS.Timeout | null = null
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
  get isWhitebit() {
    return this.isFamilyNeeded('whitebit')
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

  /**
   * Tell consumers this connector is new so they re-request their candle
   * subscriptions.
   *
   * Two messages, on purpose:
   * - the legacy one-shot `{restart:'priceConnector'}`, which every consumer
   *   (including older self-hosted builds) already understands;
   * - a repeating `{priceConnectorAlive:{bootId}}` beacon, which consumers on
   *   current code compare against the last id they acted on. The beacon is
   *   what makes recovery self-healing: pub/sub has no delivery guarantee, so
   *   a consumer that was mid-reconnect during the one-shot — or that never
   *   received it at all — still re-arms within one beacon interval instead of
   *   staying candle-blind until its own next restart.
   *
   * Deliberately does NOT put `restart` on the beacon: pre-beacon consumers
   * key off `.restart` alone and would re-request every 60s.
   */
  private async announceBoot() {
    // Historically this was a bare `this.redis?.publish(...)` here in init().
    // `initRedis()` is fire-and-forget from the constructor and index.price
    // calls `init()` synchronously after `new Connector()`, so `this.redis`
    // was ALWAYS still null and `RedisWrapper.publish` returned early without
    // sending anything — silently, since it swallows the not-ready case. The
    // restart announcement therefore never left the process, and because
    // subscriptions are in-memory only, every restart (nightly 02:00 exit
    // included) left this connector publishing nothing on candle channels that
    // still had subscribers. Await the client before announcing.
    this.redis = await RedisClient.getInstance()
    const redis = this.redis
    // `bootId` rides along so a consumer that acts on this message can skip the
    // beacon that follows it instead of re-requesting twice.
    await redis.publish(
      'serviceLog',
      JSON.stringify({ restart: 'priceConnector', bootId: this.bootId }),
    )
    const beacon = () =>
      void redis.publish(
        'serviceLog',
        JSON.stringify({
          priceConnectorAlive: {
            bootId: this.bootId,
            role: priceRole ?? 'ticker',
          },
        }),
      )
    beacon()
    if (this.beaconTimer) {
      clearInterval(this.beaconTimer)
    }
    this.beaconTimer = setInterval(beacon, BEACON_INTERVAL_MS)
    logger.info(
      `Announced price connector boot ${this.bootId}; re-announcing every ${
        BEACON_INTERVAL_MS / 1000
      }s`,
    )
  }

  async init() {
    if (isCandle || isAll) {
      // Fire-and-forget: `announceBoot` awaits a Redis client, and
      // `RedisClient.getInstance()` retries indefinitely, so awaiting it here
      // would let a Redis outage block every exchange worker from spawning.
      void this.announceBoot()
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
    if (this.isWhitebit) {
      this.initWorker(ExchangeEnum.whitebit)
    }
  }

  stop() {
    logger.info('Closing connector')

    // index.price rebuilds the Connector after a fatal rejection; without this
    // the dead instance's beacon keeps firing alongside the new one's.
    if (this.beaconTimer) {
      clearInterval(this.beaconTimer)
      this.beaconTimer = null
    }

    const bybitWorker = this.workers.get(ExchangeEnum.bybit)
    const binanceWorker = this.workers.get(ExchangeEnum.binance)
    const kucoinWorker = this.workers.get(ExchangeEnum.kucoin)
    const okxWorker = this.workers.get(ExchangeEnum.okx)
    const coinbaseWorker = this.workers.get(ExchangeEnum.coinbase)
    const bitgetWorker = this.workers.get(ExchangeEnum.bitget)
    const hyperliquidWorker = this.workers.get(ExchangeEnum.hyperliquid)
    const krakenWorker = this.workers.get(ExchangeEnum.kraken)
    const whitebitWorker = this.workers.get(ExchangeEnum.whitebit)
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
    whitebitWorker?.on('exit', () => null)
    whitebitWorker?.terminate()
  }
}

export default Connector
