import { ExchangeEnum, mapPaperToReal, wsLoggerOptions } from '../utils/common'
import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'
import sleep from '../utils/sleep'
import {
  WebsocketClient as BinanceWSClient,
  WS_KEY_MAP,
  WsMessage24hrTickerRaw,
  WsRawMessage,
  WsMessage24hrMiniTickerRaw,
} from 'binance'
import CommonConnector from './common'
import { safeStringify } from '../utils/redact'

import type {
  StreamType,
  SubscribeCandlePayload,
  BinancePayload,
} from './types'

const mutex = new IdMutex()

/** The raw `ws` socket `connectToWsUrl` returns, by the members we touch. */
type DialledSocket = {
  readyState?: number
  close: () => void
  on?: (event: string, cb: () => void) => void
  onopen: unknown
  onmessage: unknown
  onerror: unknown
  onclose: unknown
}

/**
 * Spec 014 §3.3a. The candle sockets this connector dialled itself, per client.
 *
 * The candle branches dial through the SDK's private `connectToWsUrl()`, which
 * — unlike `connect()` — never calls `wsStore.setWs()`. `closeAll()` iterates
 * that store, so it had nothing to close and every re-dial *added* a live,
 * still-publishing socket instead of replacing one. Under spec 013's restart
 * storm that was one leaked candle socket per branch per cycle, each emitting
 * duplicate closed candles into the shared market-data channels.
 *
 * These entries are the only handles on those sockets that exist. Module-level
 * so the connector can still be built off its prototype in tests, and weakly
 * keyed by client so a client replaced by `getBinanceClient()` takes its list
 * with it.
 */
const dialledCandleSockets = new WeakMap<object, DialledSocket[]>()

/**
 * Spec 012. The `ws` event slots the SDK's object spread orphans, by the only
 * handle available on them: the symbol's description. `binance` emits
 * `{ ...error, wsKey }` (`binance/lib/util/BaseWSClient.js` `parseWsError`) and
 * `error` is a `ws` `ErrorEvent`/`CloseEvent`, whose `message`/`error`/`type`/
 * `target` (and `code`/`reason` on a close) are *prototype getters* over
 * symbol-keyed own slots. The spread copies the slots and drops the getters, so
 * the payload has no reachable property and `JSON.stringify` — which ignores
 * symbol keys — printed `{"wsKey":"main"}` for essentially every real fault.
 *
 * An unknown description is ignored, so a rename in `ws` degrades this to the
 * previous output rather than breaking the line.
 */
const WS_EVENT_SLOTS: Record<string, string> = {
  kMessage: 'message',
  kError: 'error',
  kType: 'type',
  kCode: 'code',
  kReason: 'reason',
  kTarget: 'url',
}

/** One line of log stays one readable line, whatever the SDK stapled on. */
const MAX_EXCEPTION_PAYLOAD_CHARS = 1000

/**
 * Spec 013 §1.1c. Replies the sibling connectors already classify as
 * informational rather than as a connection failure — `bybit.ts` learned this
 * the hard way in bug #121, where restarting on `already subscribed` was what
 * closed the feedback loop. Matched against `describeWsException`'s output so
 * there is one serializer for the payload, not two.
 */
const BENIGN_EXCEPTION_MARKERS = [
  'handler not found',
  'format error',
  // Informational reply to re-subscribing a still-active topic.
  'already subscribed',
]

const isBenignWsException = (description: string) =>
  BENIGN_EXCEPTION_MARKERS.some((marker) => description.indexOf(marker) !== -1)

/**
 * Serialize an `exception` payload so it says why the socket faulted.
 *
 * Reads both shapes the SDK produces: the ordinary own properties its
 * non-transport sites carry (`message`, `error`, `functionRef`, …) and the
 * orphaned `ws` slots above. Own properties win a name collision — the SDK set
 * those deliberately. Serialization goes through `safeStringify` rather than
 * `JSON.stringify` so credentials stapled onto an SDK error never reach the pm2
 * logs (see `utils/redact.ts`) and so a bare `Error`, whose `name`/`message`
 * are non-enumerable, reports as more than `{}`.
 */
const describeWsException = (data: unknown): string => {
  if (data === null || typeof data !== 'object') {
    return data === undefined ? '' : String(data)
  }
  const source = data as Record<string | symbol, unknown>
  const out: Record<string, unknown> = {}

  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return
    if (out[key] !== undefined) return
    out[key] =
      value instanceof Error ? `${value.name}: ${value.message}` : value
  }

  for (const [key, value] of Object.entries(source)) {
    if (key === 'wsKey') continue
    put(key, value)
  }
  for (const slot of Object.getOwnPropertySymbols(source)) {
    const field = WS_EVENT_SLOTS[slot.description ?? '']
    if (!field) continue
    const value = source[slot]
    // `kTarget` is the live socket — take its URL, never the object.
    put(field, field === 'url' ? (value as { url?: string })?.url : value)
  }

  // Nothing readable: degrade to what this line has always printed.
  const payload = Object.keys(out).length
    ? safeStringify(out)
    : safeStringify(data)
  return payload.slice(0, MAX_EXCEPTION_PAYLOAD_CHARS)
}

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
    { timer: NodeJS.Timeout | null; execute: boolean }
  > = new Map()
  private isIntl: boolean
  private isUs: boolean
  constructor(
    private subscribedCandlesMap: Map<ExchangeEnum, Set<string>> = new Map(),
    config?: BinancePayload,
  ) {
    super()
    this.binanceCandleCb = this.binanceCandleCb.bind(this)
    this.binanceOpenCb = this.binanceOpenCb.bind(this)
    this.binanceErrorCb = this.binanceErrorCb.bind(this)
    this.binanceTickerCb = this.binanceTickerCb.bind(this)
    this.isIntl = config ? config.isIntl : true
    this.isUs = config ? config.isUs : false
    if (this.isIntl) {
      this.mainData = {
        [ExchangeEnum.binance]: this.base,
        [ExchangeEnum.binanceCoinm]: this.base,
        [ExchangeEnum.binanceUsdm]: this.base,
      }
    }
    if (this.isUs) {
      this.mainData = {
        ...this.mainData,
        [ExchangeEnum.binanceUS]: this.base,
      }
    }
    logger.info(`Binance Worker | >🚀 Price <-> Backend stream`)
  }

  private binanceCandleCb(e: ExchangeEnum) {
    return (d: WsRawMessage) => {
      if (!Array.isArray(d) && d.e === 'kline') {
        // Liveness on every kline frame (open or closed); publishing stays
        // closed-only below. Otherwise lastDataTrade only advances on candle
        // close and long-interval-only subs trip the watchdog. See bybit.ts.
        this.noteCandleActivity(e)
        if (!d.k.x) {
          return
        }
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
      if (
        Array.isArray(d) &&
        (d[0]?.e === '24hrTicker' || d[0]?.e === '24hrMiniTicker')
      ) {
        //@ts-ignore
        delete d.wsKey
        this.cbWs(
          (d as (WsMessage24hrTickerRaw | WsMessage24hrMiniTickerRaw)[]).map(
            (d) => ({
              eventType: d.e,
              eventTime: d.E,
              symbol: d.s,
              curDayClose: `${d.c}`,
              bestBid: `${d.c}`,
              bestBidQnt: `${d.q}`,
              bestAsk: `${d.c}`,
              bestAskQnt: `${d.q}`,
              open: `${d.o}`,
              high: `${d.h}`,
              low: `${d.l}`,
              volume: `${d.v}`,
              volumeQuote: `${d.q}`,
            }),
          ),
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
        )} ${`${data.wsUrl}`.slice(0, 100)}`,
      )
    }
  }

  /**
   * Spec 013: a restart cycle is in flight.
   *
   * `binanceErrorCb` is registered on ALL EIGHT clients (`getBinanceClient`)
   * and `stopBinance()` recreates all eight whichever one faulted, so without
   * this guard every exception starts its own full teardown + re-subscribe
   * cycle. In production one persistently failing international `main`
   * connection drove ~0.4-1.3 cycles per second, and because each cycle
   * reconstructs sockets that are still mid-handshake, no Binance client — not
   * even the separate-endpoint binanceUS/usdm/coinm ones, which were not
   * faulting — ever completed one, while BYBIT/BITGET/OKX opened normally in
   * the same process.
   *
   * Like bybit's (`bybitRestartCb`, bug #121) this must COALESCE (drop)
   * concurrent restarts, not queue them: the `IdMutex` used elsewhere in this
   * file serialises, which would still run N full restarts back-to-back.
   */
  private binanceRestarting = false

  /**
   * How long the guard is held *after* `init()` resolves.
   *
   * Unlike bybit's, this cycle's promise is not a usable window: `init()` only
   * ARMS the reconnect. `reconnectBinanceCandleStream()` delegates to
   * `connectBinanceCandleStreams`, whose first act is to set a 5s debounce
   * timer and return, and the dial it schedules then issues one 200-stream
   * chunk per second. So `init()` settles in the same tick, and releasing there
   * would let the exceptions raised by that very dial tear down the sockets it
   * just created — which is the 1.0s-spaced storm the production logs show.
   * 15s covers the debounce plus a typical multi-chunk dial, and matches the
   * window bybit gets for free from the sleeps inside `initBybitWS()`.
   */
  private binanceRestartSettle = 15000

  private binanceErrorCb(e: ExchangeEnum) {
    return (data: any) => {
      const description = describeWsException(data)
      const line = `${e.toUpperCase()} error: ${`${data.wsKey}`.slice(
        0,
        100,
      )} ${description}`
      // Benign, self-clearing replies are logged as info: emitting them at
      // error level made a healthy connector look broken.
      if (isBenignWsException(description)) {
        logger.info(line)
        return
      }
      logger.error(line)
      if (this.binanceRestarting) {
        logger.info(
          `Binance restart already in progress — coalescing ${e} exception`,
        )
        return
      }
      this.binanceRestarting = true
      void this.runBinanceRestart()
    }
  }

  /**
   * One full restart cycle, held under `binanceRestarting` until the re-dial it
   * scheduled has had time to settle, so concurrent exceptions are dropped
   * rather than interleaved. The recovery RADIUS is deliberately unchanged —
   * a fatal exception still recreates the whole family (spec 013 §3).
   */
  private async runBinanceRestart() {
    try {
      this.stopBinance()
      await this.init()
      await sleep(this.binanceRestartSettle)
    } catch (err) {
      logger.error(`Binance restart cycle failed: ${err}`)
    } finally {
      this.binanceRestarting = false
    }
  }

  /**
   * Dial one candle chunk and keep the handle (spec 014 §3.3a).
   *
   * `connectToWsUrl` is private because the SDK expects `connect()` to be used,
   * and `connect()` cannot serve here: it refuses a second call on a wsKey that
   * is already open, and every chunk of a branch shares one key, so all chunks
   * past the first would be silently dropped. A synthetic per-chunk key is
   * worse — the SDK's reconnect path calls `connect(wsKey)` with no custom URL,
   * and its URL builder throws `Unhandled WsKey` for anything outside
   * `WS_KEY_MAP`, which `connect()` re-emits as an `exception` straight back
   * into `binanceErrorCb` (spec 014 §3.2).
   */
  private dialCandleSocket(
    client: BinanceWSClient,
    exchange: ExchangeEnum,
    url: string,
    wsKey: string,
  ) {
    //@ts-expect-error connect to wsUrl is private
    const ws = client.connectToWsUrl(url, wsKey) as DialledSocket | undefined
    if (!ws) {
      return
    }
    dialledCandleSockets.set(client, [
      ...(dialledCandleSockets.get(client) ?? []),
      ws,
    ])
    // The SDK emits its client-level `open` only for a connection opened
    // through `connect()`, so `binanceOpenCb` never fired for a candle socket
    // and no log line has ever said a candle chunk reached the venue (spec 014
    // §1.3). Report it off the socket instead.
    const onOpen = this.binanceOpenCb(exchange, 'candle')
    ws.on?.('open', () => onOpen({ wsKey, wsUrl: url }))
  }

  /**
   * Close the candle sockets this connector dialled on `client`
   * (spec 014 §3.3b/§3.3c).
   *
   * The SDK's handlers come off first (§3.3d): a socket torn down with them
   * still attached publishes during the close handshake (`onmessage`), can
   * raise an `exception` into `binanceErrorCb` — which spec 013 answers with a
   * full family restart (`onerror`) — and trips the SDK's unintentional-close
   * recovery, re-dialling a stream-less socket on the shared wsKey (`onclose`).
   */
  private closeDialledCandleSockets(client?: BinanceWSClient) {
    if (!client) {
      return
    }
    const sockets = dialledCandleSockets.get(client)
    dialledCandleSockets.delete(client)
    for (const ws of sockets ?? []) {
      try {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
      } catch (err) {
        logger.error(`Failed to close a binance candle socket: ${err}`)
      }
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
      this.closeDialledCandleSockets(current)
      current.on('exception', () => null)
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
    client.on('exception', this.binanceErrorCb(exchange))
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
        [ExchangeEnum.binance, ExchangeEnum.paperBinance].includes(exchange) &&
        this.isIntl
      ) {
        this.connectBinanceCandleStreams()
      }
      if (exchange === ExchangeEnum.binanceUS && this.isUs) {
        this.connectBinanceCandleStreams(true)
      }
      if (
        [ExchangeEnum.binanceUsdm, ExchangeEnum.paperBinanceUsdm].includes(
          exchange,
        ) &&
        this.isIntl
      ) {
        this.connectBinanceCandleStreams(false, 'usdm')
      }
      if (
        [ExchangeEnum.binanceCoinm, ExchangeEnum.paperBinanceCoinm].includes(
          exchange,
        ) &&
        this.isIntl
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
    if (this.isIntl) {
      this.binanceClient.subscribeSpotAllMini24hrTickers()
      this.binanceClientCoinm.subscribeAll24hrTickers('coinm')
      this.binanceClientUsdm.subscribeAll24hrTickers('usdm')
    }
    if (this.isUs) {
      this.binanceClientUs.subscribeSpotAllMini24hrTickers()
    }
  }

  private async closeBinanceCandleStream(
    us = false,
    futures?: 'coinm' | 'usdm',
  ) {
    const client = us
      ? this.binanceClientCandleUs
      : futures === 'coinm'
        ? this.binanceClientCandleCoinm
        : futures === 'usdm'
          ? this.binanceClientCandleUsdm
          : this.binanceClientCandle
    // Anything the SDK opened on its own (its reconnect path does register a
    // socket) — kept exactly as before, spec 014 §3.3e...
    client.closeAll(false)
    // ...and the sockets we dialled ourselves, which it cannot reach.
    this.closeDialledCandleSockets(client)
  }

  private async reconnectBinanceCandleStream() {
    if (this.isUs) {
      this.connectBinanceCandleStreams(true)
    }
    if (this.isIntl) {
      this.connectBinanceCandleStreams(false)
      this.connectBinanceCandleStreams(false, 'coinm')
      this.connectBinanceCandleStreams(false, 'usdm')
    }
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
        // `?streams=` is only valid on the combined-stream path. `getWsUrl()`
        // is the SDK's client-wide builder: it returns the `settings.wsUrl`
        // override — the raw `/ws` path the *ticker* client needs (:195) — and
        // appends its own `/stream` suffix, so this read `/ws/stream?streams=`
        // and the venue answered 404. Hardcoded like the three branches below,
        // which were converted in "v1.5.3: Fixed Binance new urls" while this
        // one was missed.
        this.dialCandleSocket(
          this.binanceClientCandleUs,
          e,
          `wss://stream.binance.us:9443/stream?streams=${wsKey}`,
          WS_KEY_MAP.main,
        )
      } else {
        if (futures) {
          if (futures === 'coinm') {
            this.dialCandleSocket(
              this.binanceClientCandleCoinm,
              e,
              `wss://dstream.binance.com/stream?streams=${wsKey}`,
              WS_KEY_MAP.coinm,
            )
          } else if (futures === 'usdm') {
            this.dialCandleSocket(
              this.binanceClientCandleUsdm,
              e,
              `wss://fstream.binance.com/market/stream?streams=${wsKey}`,
              WS_KEY_MAP.usdm,
            )
          }
        } else {
          this.dialCandleSocket(
            this.binanceClientCandle,
            e,
            `wss://stream.binance.com:9443/stream?streams=${wsKey}`,
            WS_KEY_MAP.main,
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
