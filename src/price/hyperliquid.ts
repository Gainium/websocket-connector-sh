import * as hl from '@nktkas/hyperliquid'
import { subscribe } from 'diagnostics_channel'
import { setMaxListeners } from 'events'

import { ExchangeEnum, mapPaperToReal } from '../utils/common'
import HyperliquidSymbolMap from '../utils/hyperliquidSymbols'
import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'
import CommonConnector from './common'

import type { Ticker, StreamType, SubscribeCandlePayload } from './types'

const mutex = new IdMutex()

/**
 * Last rejected Hyperliquid WebSocket upgrade, used to explain socket errors.
 *
 * `@nktkas/hyperliquid` builds its sockets from `globalThis.WebSocket`. Only
 * the HL user-stream worker replaces that global (with a `ws` subclass, via
 * `installHyperliquidIpRotation`); the candle and price streams leave it as
 * Node 24's built-in undici implementation. undici's ErrorEvent is
 * deliberately detail-free — `message` is `''` and `error` is a bare
 * `TypeError` with no message and no `cause` — because WHATWG requires the
 * failure reason to stay hidden from the socket's error event. So `onerror`
 * has nothing to unwrap, and during the 2026-08-08 08:34Z Hyperliquid
 * blackout every candle/price line read "Hyperliquid error: error" while the
 * user-stream worker, on `ws`, logged "Unexpected server response: 502".
 *
 * undici does publish the upgrade response on a diagnostics channel, so
 * capture the HTTP status there. That is the one place the venue's actual
 * answer is still visible from this process.
 */
let lastHandshakeFailure: {
  status: number
  statusText: string
  at: number
} | null = null
let handshakeWatchInstalled = false

function watchHyperliquidHandshake(): void {
  if (handshakeWatchInstalled) return
  handshakeWatchInstalled = true
  try {
    subscribe('undici:request:headers', (message) => {
      const { request, response } = message as {
        request?: { origin?: unknown; headers?: unknown }
        response?: { statusCode?: number; statusText?: string }
      }
      const status = response?.statusCode
      // 101 means the upgrade was accepted — only a non-101 status is a
      // failure, and skipping 101 keeps a healthy connect from overwriting
      // the record that explains a later error.
      if (!status || status === 101) return
      if (!String(request?.origin ?? '').includes('hyperliquid')) return
      // Only the upgrade request carries `sec-websocket-key`. Without this
      // check an unrelated REST call to the same host (e.g. a 429 on the
      // info endpoint) would be reported as the socket's failure.
      const headers = request?.headers
      const isUpgrade = Array.isArray(headers)
        ? headers.some((h) => String(h).toLowerCase() === 'sec-websocket-key')
        : /sec-websocket-key/i.test(String(headers ?? ''))
      if (!isUpgrade) return
      lastHandshakeFailure = {
        status,
        statusText: response?.statusText ?? '',
        at: Date.now(),
      }
    })
  } catch {
    // Best-effort diagnostics: never let this break the stream.
  }
}

const maxCandlesPerConnection = 1000
/**
 * Hyperliquid's documented per-IP cap on simultaneous WS connections
 * ("Maximum of 10 websocket connections", HL API rate-limits doc). Exposed as
 * an env override because the venue has been observed rejecting with a higher
 * number ("Cannot open more than 15 connections.") on some egress IPs — an
 * operator who can demonstrate a higher allowance for their host can raise it
 * without a code change. The default stays at the documented value: exceeding
 * the real cap produces exactly the 1008 close storm that used to feed the
 * restart loop below.
 */
const maxHyperliquidConnections =
  +(process.env.HYPERLIQUID_MAX_WS_CONNECTIONS ?? '') || 10
/**
 * Connection slots kept outside the candle pool: one for the ticker client,
 * one as headroom for the replacement transport a restart briefly holds open
 * alongside the socket it is closing.
 */
const reservedHyperliquidConnections = 2
const maxCandleClients = Math.max(
  1,
  maxHyperliquidConnections - reservedHyperliquidConnections,
)

/**
 * Full-restart pacing (bug #218). A restart tears down and rebuilds *every*
 * transport, so it is itself a burst of new connections — restarting without a
 * delay on a persistently-failing subscribe re-trips the very per-IP limit that
 * caused the failure, and the two feed each other forever. The re-entry runs
 * entirely through already-settled promises, i.e. as microtasks, so the loop
 * also starves the macrotask queue and stops `CommonConnector.watchdogFn` and
 * every other exchange's timers in the same worker.
 */
const hyperliquidRestartBaseDelay = 30_000
const hyperliquidRestartMaxDelay = 300_000
/** Quiet period after which the backoff returns to the base delay. */
const hyperliquidRestartResetAfter = 600_000

class HyperliquidConnector extends CommonConnector {
  private unsubscribeMap: Map<StreamType, hl.Subscription[]> = new Map()
  private timer: NodeJS.Timeout | null = null
  private inQueueCandles: Map<
    string,
    {
      coin: string
      interval: hl.WsCandleParameters['interval']
      /** true = spot request (resolve the spot @N code, not the perp). */
      isSpot: boolean
    }
  > = new Map()
  private symbols = HyperliquidSymbolMap.getInstance()
  private hyperliquidClient: hl.SubscriptionClient =
    this.getHyperliquidClient('ticker')
  private hyperliquidClientCandle: {
    client: hl.SubscriptionClient<hl.WebSocketTransport>
    id: number
    count: number
    /** Candle subscriptions currently active on this connection. Used to re-queue on reconnect. */
    items: Map<
      string,
      {
        coin: string
        interval: hl.WsCandleParameters['interval']
        isSpot: boolean
      }
    >
  }[] = [
    {
      id: 0,
      count: 0,
      items: new Map(),
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
      [ExchangeEnum.hyperliquidLinear]: this.base,
    }
    logger.info(`Hyperliquid Worker | >🚀 Price <-> Backend stream`)
    // Set up rate-limited reconnect for the initial candle client
    this.setupCandleReconnectHooks(this.hyperliquidClientCandle[0])
  }

  private async hyperliquidTickerCb(msg: hl.WsAllMids) {
    const convert = await this.convertHyperliquidTicker(msg.mids)
    this.cbWs(convert.spot, ExchangeEnum.hyperliquid)
    this.cbWs(convert.linear, ExchangeEnum.hyperliquidLinear)
  }

  private async hyperliquidCandleCb(msg: hl.Candle) {
    // WS returns @N codes for spot — translate back to display name so the
    // Redis channel matches what consumers requested (e.g. "PUMP-USDC").
    const exchange =
      msg.s.startsWith('@') || msg.s.includes('/')
        ? ExchangeEnum.hyperliquid
        : ExchangeEnum.hyperliquidLinear
    const symbol = this.symbols.codeToPair(msg.s) ?? msg.s
    this.cbWsTrade(
      {
        e: 'kline',
        E: +new Date(),
        s: symbol,
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
      exchange,
    )
  }

  /**
   * Sets up rate-limited re-subscription for a candle client on reconnect.
   * The library's default autoResubscribe fires all subscriptions simultaneously
   * which immediately triggers an "Inactive" close → infinite reconnect loop.
   * Instead we disable it and replay items through our existing 5/2s batching.
   */
  private setupCandleReconnectHooks(
    entry: (typeof this.hyperliquidClientCandle)[number],
  ) {
    const transport = entry.client.transport as hl.WebSocketTransport
    transport.autoResubscribe = false
    // Raise the EventTarget listener limit for the internal HyperliquidEventTarget.
    // Every client.candle() call registers a listener on the same "candle" event;
    // without this Node warns at >10 listeners per EventTarget.
    const hlEvents = (transport as unknown as { _hlEvents: EventTarget })
      ._hlEvents
    if (hlEvents) setMaxListeners(maxCandlesPerConnection + 10, hlEvents)

    // On close: clean up the transport's internal subscription/listener state so
    // the next client.candle() call will actually send a new subscribe message.
    // (With autoResubscribe=false the library keeps stale _subscriptions entries
    // whose promises are already resolved — future candle() calls would no-op.)
    const origOnclose = transport.socket.onclose
    transport.socket.onclose = (event) => {
      origOnclose?.call(transport.socket, event)
      // Snapshot all unsubscribe callbacks then fire them synchronously.
      // Since the socket is now closed, each unsub() only removes the EventTarget
      // listener and deletes from _subscriptions — no network messages are sent.
      const subs = (
        transport as unknown as {
          _subscriptions: Map<
            string,
            { listeners: Map<unknown, () => Promise<void>> }
          >
        }
      )._subscriptions
      const allUnsubs: (() => Promise<void>)[] = []
      for (const sub of subs.values()) {
        for (const unsub of sub.listeners.values()) {
          allUnsubs.push(unsub)
        }
      }
      allUnsubs.forEach((f) => f().catch(() => {}))
      // _subscriptions is now empty — client.candle() will re-send on reconnect
    }

    // On open: if this is a reconnect (not initial connect) re-queue this
    // client's items through the rate-limited batching debounce.
    let connectedOnce = false
    const origOnopen = transport.socket.onopen
    transport.socket.onopen = (event) => {
      origOnopen?.call(transport.socket, event)
      if (connectedOnce) {
        const reconnectItems = [...entry.items.values()]
        entry.count = 0
        entry.items.clear()
        logger.info(
          `Hyperliquid candle client ${entry.id} reconnected — resubscribing ${reconnectItems.length} subscriptions directly`,
        )
        // Resubscribe directly on THIS entry's client without going through
        // the shared inQueueCandles/timer. When multiple clients reconnect
        // simultaneously the shared timer is cancelled and restarted by each
        // arriving onopen, meaning only the LAST reconnecting client's items
        // end up subscribed — every other client stays idle and Hyperliquid
        // closes the idle connection again in ~5 s.
        setTimeout(() => {
          this.resubscribeEntry(entry, reconnectItems)
        }, 1500)
      }
      connectedOnce = true
    }
  }

  /**
   * Resubscribes a specific candle client's items directly on its own connection.
   * Used after reconnect to avoid item-theft caused by the shared inQueueCandles
   * when multiple clients reconnect simultaneously.
   */
  private async resubscribeEntry(
    entry: (typeof this.hyperliquidClientCandle)[number],
    items: {
      coin: string
      interval: hl.WsCandleParameters['interval']
      isSpot: boolean
    }[],
  ) {
    if (items.length === 0) return
    // Serialize subscriptions: send one at a time with a pause between each.
    // Sending multiple simultaneously triggers an "Inactive" close from
    // Hyperliquid, causing the reconnect loop.
    const subDelayMs = 500
    const failedItems: typeof items = []
    let connectionClosed = false
    for (const c of items) {
      if (connectionClosed) {
        // Connection dropped mid-resubscription — remaining items will be
        // picked up by the next onopen handler automatically.
        entry.items.set(`${c.coin}-${c.interval}`, c)
        continue
      }
      entry.items.set(`${c.coin}-${c.interval}`, c)
      const wsCoin = this.toWsCoin(c.coin, c.isSpot)
      if (!wsCoin) {
        this.reportUntranslatableCoin(c.coin, 'resubscription')
        entry.items.delete(`${c.coin}-${c.interval}`)
        continue
      }
      await new Promise<void>(async (res, rej) => {
        const t = setTimeout(() => rej(new Error('Timeout')), 10_000)
        try {
          const unsubscribe = await entry.client.candle(
            { coin: wsCoin, interval: c.interval },
            this.hyperliquidCandleCb,
          )
          const get = this.unsubscribeMap.get('candle') ?? []
          get.push(unsubscribe)
          this.unsubscribeMap.set('candle', get)
          entry.count++
          res()
        } catch (e) {
          rej(e)
        } finally {
          clearTimeout(t)
        }
      }).catch((e) => {
        logger.error(
          `Error resubscribing Hyperliquid candle ${c.coin} ${c.interval}: ${e}`,
        )
        if (String(e).includes('connection closed')) {
          // Item stays in entry.items; onopen will retry on next reconnect.
          // Skip remaining items — they'll be retried too.
          connectionClosed = true
        } else {
          entry.items.delete(`${c.coin}-${c.interval}`)
          failedItems.push(c)
        }
      })
      if (!connectionClosed) {
        await new Promise((r) => setTimeout(r, subDelayMs))
      }
    }
    if (failedItems.length > 0) {
      logger.info(
        `Scheduling retry for ${failedItems.length} failed resubscriptions in 60s`,
      )
      setTimeout(() => {
        for (const item of failedItems) {
          this.inQueueCandles.set(`${item.coin}-${item.interval}`, item)
        }
        if (!this.timer) {
          const t = setTimeout(() => {
            this.timer = null
            this.connectHyperliquidCandleStreams([], true)
          }, 0)
          this.timer = t
        }
      }, 60_000)
    }
  }

  private getHyperliquidClient(
    type: StreamType,
    current?: hl.SubscriptionClient,
  ) {
    if (current) {
      // Permanently close the old transport so its ReconnectingWebSocket loop
      // stops immediately. Without this the loop keeps running forever,
      // accumulating open connections across every stopHyperliquid call.
      try {
        ;(
          current as hl.SubscriptionClient<hl.WebSocketTransport>
        ).transport.socket.close()
      } catch {}
      const get = this.unsubscribeMap.get(type)
      if (get) {
        get.forEach((g) => g.unsubscribe())
      }
    }

    watchHyperliquidHandshake()

    // Track rapid close/open cycles so the circuit breaker below can fire.
    // A "rapid close" is a connection that opened but was closed by the server
    // in under 10 s — a sign we are hitting Hyperliquid's 30 new connections/min
    // per-IP limit. Once the death spiral starts (attempt counter resets on
    // every brief open, so delay stays at ~300 ms → ~75 reconnects/min) we need
    // to impose a much longer backoff until the server stops rate-limiting us.
    let lastOpenMs = 0
    let rapidCloseCount = 0

    const transport = new hl.WebSocketTransport({
      url:
        process.env.HYPERLIQUIDENV === 'demo'
          ? 'wss://api.hyperliquid-testnet.xyz/ws'
          : 'wss://api.hyperliquid.xyz/ws',
      reconnect: {
        maxRetries: 100,
        // Base delay: 3 s minimum (attempt=1 after any brief open resets _attempt
        // to 0 and close increments to 1 → 3 s × 2 = 6 s minimum).
        // That keeps new connections well under 30/min under normal conditions.
        // Circuit breaker: if connections keep closing within 10 s of opening,
        // add 30 s per rapid-close count (capped at 2 min) to let the server
        // stop rate-limiting before we try again.
        connectionDelay: (attempt) => {
          const base = Math.min((1 << attempt) * 3_000, 120_000)
          if (rapidCloseCount >= 3) {
            const extra = Math.min(rapidCloseCount * 30_000, 120_000)
            logger.warn(
              `Hyperliquid rapid-close circuit breaker active (${rapidCloseCount}x), delaying ${(base + extra) / 1000}s`,
            )
            return base + extra
          }
          return base
        },
      },
    })
    transport.socket.onopen = () => {
      lastOpenMs = Date.now()
      logger.info(`Hyperliquid connected`)
    }
    transport.socket.onclose = (event) => {
      const openDuration = lastOpenMs > 0 ? Date.now() - lastOpenMs : Infinity
      if (openDuration < 10_000) {
        rapidCloseCount++
      } else {
        rapidCloseCount = 0
      }
      logger.info(
        `Hyperliquid closed: code=${(event as CloseEvent).code} reason=${event.reason} openFor=${openDuration === Infinity ? '?' : `${(openDuration / 1000).toFixed(1)}s`} rapidCloses=${rapidCloseCount}`,
      )
    }
    transport.socket.onerror = (event) => {
      // An ErrorEvent's fields are non-enumerable, so JSON.stringify() always
      // produced "{}" here and hid every socket failure. Read them explicitly.
      // Under undici these are empty too (see watchHyperliquidHandshake), so
      // fall back to the handshake status / connection state rather than to
      // `event.type`, which is the constant string "error" and reads like a
      // reason without being one.
      const err = event as ErrorEvent
      const detail = err.message || err.error?.message
      const failure = lastHandshakeFailure
      let reason: string
      if (detail) {
        reason = detail
      } else if (failure && Date.now() - failure.at < 10_000) {
        reason = `handshake rejected: HTTP ${failure.status}${
          failure.statusText ? ` ${failure.statusText}` : ''
        }`
      } else if (lastOpenMs > 0) {
        reason = `established connection dropped after ${(
          (Date.now() - lastOpenMs) /
          1000
        ).toFixed(1)}s (socket gave no detail)`
      } else {
        reason = 'connection failed before open (socket gave no detail)'
      }
      logger.error(`Hyperliquid error: ${reason}`)
    }
    const client = new hl.SubscriptionClient({
      transport,
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
          ExchangeEnum.hyperliquidLinear,
          ExchangeEnum.paperHyperliquidLinear,
          ExchangeEnum.hyperliquid,
          ExchangeEnum.paperHyperliquid,
        ].includes(exchange)
      ) {
        // `exchange` is already mapped to the real venue (paper stripped),
        // so spot = plain `hyperliquid` (perp = `hyperliquidLinear`).
        const isSpot = exchange === ExchangeEnum.hyperliquid
        this.connectHyperliquidCandleStreams([
          {
            symbol,
            interval: interval as hl.WsCandleParameters['interval'],
            isSpot,
          },
        ])
      }
    }
  }

  private metaRefreshTimer: NodeJS.Timeout | null = null

  async init() {
    await this.symbols.refresh()
    this.metaRefreshTimer = setInterval(
      () => {
        this.symbols.refresh(true)
      },
      30 * 60 * 1000,
    )
    if (!this.isCandle || this.isAll) {
      this.initHyperliquidWS()
    }
    if (this.isCandle || this.isAll) {
      this.reconnectHyperliquidCandleStream()
    }
  }

  /**
   * Reports a candle subscription we had to skip because `toWsCoin` could not
   * translate the symbol. Both branches are errors — the subscription is
   * dropped either way and that consumer receives no candles.
   *
   * The common case is main-app sending a symbol that is ALREADY a Hyperliquid
   * wire code ("BTC") instead of the display pair ("BTC-USDC"): its indicator
   * service uses `symbolCode || symbol` for both the `candlesRequests` payload
   * and the Redis channel it subscribes to, and for HL `symbolCode` is the
   * wire code. `nameToCode` is keyed by display pair, so the subscription is
   * skipped here — and even if it were not, we publish on the display-pair
   * channel (see `hyperliquidCandleCb`), which is not the channel that
   * consumer is listening on. Naming the resolved pair makes that mismatch
   * obvious in the log instead of requiring a cross-service trace.
   */
  private reportUntranslatableCoin(coin: string, context: string) {
    const asWireCode = this.symbols.codeToPair(coin)
    if (asWireCode) {
      logger.error(
        `Failed to translate symbol ${coin} for Hyperliquid candle ${context} — skipping. ` +
          `"${coin}" is already a wire code (display pair "${asWireCode}"); the caller sent a wire code ` +
          `where a display pair is expected, so this consumer will receive no candles.`,
      )
      return
    }
    logger.error(
      `Failed to translate symbol ${coin} for Hyperliquid candle ${context} — skipping. ` +
        `Unknown symbol: not a display pair and not a known wire code.`,
    )
  }

  /**
   * Translates a display pair to the wire coin format Hyperliquid's WS
   * expects. Spot display names (e.g. "PUMP-USDC") → "@20"; HL native perps
   * (e.g. "BTC-USDC") → "BTC"; builder-dex pairs are always prefixed
   * `provider:BASE-QUOTE` (e.g. "xyz:HYUNDAI-USDC") → "xyz:HYUNDAI".
   */
  private toWsCoin(coin: string, isSpot: boolean): string | undefined {
    // For a spot request, resolve the spot @N code even when a perp shares the
    // display name (dev-confirmed: perp candles must not be served to spot).
    return isSpot
      ? this.symbols.spotPairToCode(coin)
      : this.symbols.pairToCode(coin)
  }

  private stopHyperliquid() {
    this.hyperliquidClient = this.getHyperliquidClient(
      'ticker',
      this.hyperliquidClient,
    )
    // Close any excess clients beyond the cap before recreating — these are
    // leftovers from previous reconnect storms and waste connection slots.
    const excess = this.hyperliquidClientCandle.splice(maxCandleClients)
    for (const e of excess) {
      try {
        e.client.transport.socket.close()
      } catch {}
    }
    this.hyperliquidClientCandle = this.hyperliquidClientCandle.map((c) => ({
      id: c.id,
      count: 0,
      items:
        new Map() as (typeof this.hyperliquidClientCandle)[number]['items'],
      client: this.getHyperliquidClient(
        'candle',
        c.client,
      ) as hl.SubscriptionClient<hl.WebSocketTransport>,
    }))
    this.hyperliquidClientCandle.forEach((e) =>
      this.setupCandleReconnectHooks(e),
    )
  }

  private hyperliquidRestartCb() {
    this.stopHyperliquid()
    this.initHyperliquidWS()
    this.reconnectHyperliquidCandleStream()
  }

  private restartTimer: NodeJS.Timeout | null = null
  private restartBackoffMs = hyperliquidRestartBaseDelay
  private lastRestartAt = 0

  /**
   * Single-flight, paced entry point for a full Hyperliquid restart. Every
   * caller must go through here — calling `hyperliquidRestartCb` directly from
   * a failure path is what produced bug #218.
   *
   * - At most one restart is in flight; further requests coalesce into the
   *   pending one instead of stacking.
   * - The delay is `backoff − elapsed`, so a restart following a healthy period
   *   still fires immediately: a one-off drop recovers exactly as fast as
   *   before, and only *consecutive* failures get slowed down (30s, doubling to
   *   a 5 min cap).
   * - After {@link hyperliquidRestartResetAfter} without a restart the backoff
   *   returns to the base delay.
   */
  private scheduleHyperliquidRestart(reason: string) {
    if (this.restartTimer) {
      // Already pending — coalesce. Staying silent here is deliberate: the
      // failure path can fire thousands of times per second.
      return
    }
    const elapsed =
      this.lastRestartAt === 0 ? Infinity : Date.now() - this.lastRestartAt
    const consecutive = elapsed < hyperliquidRestartResetAfter
    if (!consecutive) {
      this.restartBackoffMs = hyperliquidRestartBaseDelay
    }
    const delay = Math.max(0, this.restartBackoffMs - elapsed)
    logger.warn(
      `Hyperliquid restart in ${Math.round(delay / 1000)}s (backoff ${this.restartBackoffMs / 1000}s): ${reason}`,
    )
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.lastRestartAt = Date.now()
      if (consecutive) {
        this.restartBackoffMs = Math.min(
          this.restartBackoffMs * 2,
          hyperliquidRestartMaxDelay,
        )
      }
      this.hyperliquidRestartCb()
    }, delay)
  }

  /**
   * Hyperliquid never adopted the `handleStall` isolation hook, so a stall
   * still reached the `throw` in `CommonConnector.watchdogFn` — and a throw
   * inside a `setInterval` callback is an uncaught exception that kills the
   * whole price worker, taking every other exchange's feeds with it. A full
   * Hyperliquid restart rebuilds the ticker *and* the candle clients, so it is
   * the right recovery for all three stall kinds. `CommonConnector` still
   * escalates to the full-worker restart after `maxTargetedRestarts`, so a
   * genuinely dead worker is still replaced.
   */
  protected override handleStall(
    exchange: ExchangeEnum,
    kind: 'price' | 'candle' | 'connect',
  ): boolean {
    this.scheduleHyperliquidRestart(`${kind} stall | ${exchange}`)
    return true
  }

  private async initHyperliquidWS() {
    try {
      const client = this.hyperliquidClient
      // Default allMids covers HL native (perp + spot). Builder-dex prices
      // require a per-dex subscription with { dex } — multiplexed on the
      // same socket. Each subscription gets a per-dex callback so events
      // are only emitted by the listener whose dex matches the coin name.
      const dexNames = this.symbols.getDexNames()
      // The @nktkas SubscriptionClient fans every allMids event out to every
      // registered listener (no filter on the `dex` payload). One real
      // callback handles all events; the per-dex subs only exist so the
      // server keeps emitting those dexes' mids over the same socket.
      const noop = () => {}
      const subs = await Promise.all([
        client.allMids(this.hyperliquidTickerCb),
        ...dexNames.map((dex) =>
          client.allMids({ dex }, noop).catch((e) => {
            logger.error(
              `Hyperliquid allMids subscription failed for dex ${dex}: ${e?.message ?? e}`,
            )
            return null
          }),
        ),
      ])
      this.unsubscribeMap.set(
        `ticker`,
        subs.filter((s): s is hl.Subscription => s !== null),
      )
    } catch (e) {
      // Paced + single-flight. Calling `hyperliquidRestartCb()` straight from
      // here re-entered this method with no delay and no in-flight guard, so a
      // persistently-failing `allMids` (i.e. while HL rate-limits our IP) spun
      // ~5.8k restarts/s (11.6k transports/s) until the process died — and,
      // being a pure microtask loop, starved every timer in the worker while
      // it did. See bug #218.
      this.scheduleHyperliquidRestart(
        `allMids ticker subscription failed: ${e instanceof Error ? e.message : e}`,
      )
    }
  }

  private async reconnectHyperliquidCandleStream() {
    const store: { symbol: string; interval: string; isSpot: boolean }[] = []
    for (const ex of [
      ExchangeEnum.hyperliquid,
      ExchangeEnum.hyperliquidLinear,
    ] as const) {
      const isSpot = ex === ExchangeEnum.hyperliquid
      const set = this.subscribedCandlesMap.get(ex) ?? new Set()
      set.forEach((s) => {
        const [symbol, interval] = this.splitCandleRoomName(s)
        store.push({ symbol, interval, isSpot })
      })
    }
    this.connectHyperliquidCandleStreams(
      store.map(({ symbol, interval, isSpot }) => ({
        symbol,
        interval: interval as hl.WsCandleParameters['interval'],
        isSpot,
      })),
    )
  }

  @IdMute(mutex, () => `getCandleClient`)
  private async getCandleClient(count: number) {
    const find = [
      ...this.hyperliquidClientCandle.filter(
        (c) =>
          c.count < maxCandlesPerConnection &&
          count + c.count <= maxCandlesPerConnection,
      ),
    ].sort((a, b) => a.count - b.count)[0]
    if (find) {
      find.count += count
      this.hyperliquidClientCandle = this.hyperliquidClientCandle.map((c) =>
        c.id === find.id ? { ...c, count: find.count } : c,
      )
      return find.client
    }
    // Hard cap: do not open more than maxCandleClients connections. Derived
    // from maxHyperliquidConnections (the per-IP simultaneous-connection cap)
    // minus the slots reserved for the ticker client and restart headroom.
    if (this.hyperliquidClientCandle.length >= maxCandleClients) {
      logger.warn(
        `Hyperliquid candle client cap (${maxCandleClients}) reached — reusing least-busy client`,
      )
      const leastBusy = [...this.hyperliquidClientCandle].sort(
        (a, b) => a.count - b.count,
      )[0]
      leastBusy.count += count
      this.hyperliquidClientCandle = this.hyperliquidClientCandle.map((c) =>
        c.id === leastBusy.id ? { ...c, count: leastBusy.count } : c,
      )
      return leastBusy.client
    }
    logger.info('Creating new Hyperliquid candle client')
    const client = this.getHyperliquidClient(
      'candle',
    ) as hl.SubscriptionClient<hl.WebSocketTransport>
    const newEntry = {
      count,
      client,
      id: this.hyperliquidClientCandle.length,
      items:
        new Map() as (typeof this.hyperliquidClientCandle)[number]['items'],
    }
    this.hyperliquidClientCandle.push(newEntry)
    this.setupCandleReconnectHooks(newEntry)
    return client
  }

  @IdMute(mutex, () => 'connectHyperliquid')
  private async connectHyperliquidCandleStreams(
    _data: {
      symbol: string
      interval: hl.WsCandleParameters['interval']
      isSpot: boolean
    }[],
    timer = false,
  ) {
    const data = _data.map(({ symbol, interval, isSpot }) => {
      return { coin: symbol, interval, isSpot }
    })
    if (!timer) {
      data.forEach((d) => {
        this.inQueueCandles.set(`${d.coin}-${d.interval}`, {
          coin: d.coin,
          interval: d.interval,
          isSpot: d.isSpot,
        })
      })
      // First-win debounce: set the timer once on the first queued item.
      // Do NOT reset the timer on each new arrival — that would delay subscription
      // indefinitely when indicators trickle in continuously.
      if (!this.timer) {
        const t = setTimeout(() => {
          this.timer = null
          this.connectHyperliquidCandleStreams([], true)
        }, 5000)
        this.timer = t
      }
      return
    }
    const subscribeChannels = [...(this.inQueueCandles?.values() ?? [])].map(
      (d) => ({
        coin: d.coin,
        interval: d.interval,
        isSpot: d.isSpot,
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
        isSpot: boolean
      }[][],
    )
    const failedItems: {
      coin: string
      interval: hl.WsCandleParameters['interval']
      isSpot: boolean
    }[] = []
    let i = 0
    for (const chunk of chunks) {
      i++
      const client = await this.getCandleClient(chunk.length)
      if (client) {
        // Serialize subscribe messages: send one at a time with a pause
        // between each. Sending multiple simultaneously triggers an
        // "Inactive" close from Hyperliquid → reconnect loop.
        const subDelayMs = 500
        let connectionClosed = false
        for (const c of chunk) {
          if (connectionClosed) break
          // Look up owning entry once — needed in both success and error paths.
          const ownerEntry = this.hyperliquidClientCandle.find(
            (e) => e.client === client,
          )
          // Optimistically track BEFORE the subscribe attempt.
          // If the connection closes mid-subscribe this item stays in
          // entry.items, so the onopen reconnect hook will re-queue it
          // immediately instead of leaving the client idle (and Hyperliquid
          // closing the idle connection every ~60 s).
          ownerEntry?.items.set(`${c.coin}-${c.interval}`, {
            coin: c.coin,
            interval: c.interval,
            isSpot: c.isSpot,
          })
          const wsCoin = this.toWsCoin(c.coin, c.isSpot)
          if (!wsCoin) {
            this.reportUntranslatableCoin(c.coin, 'subscription')
            ownerEntry?.items.delete(`${c.coin}-${c.interval}`)
            continue
          }
          if (wsCoin !== c.coin) {
            logger.info(`Translated symbol ${c.coin} → ${wsCoin}`)
          }
          await new Promise<void>(async (res, rej) => {
            const t = setTimeout(() => rej(new Error('Timeout')), 10 * 1000)
            try {
              const unsubscribe = await client.candle(
                { coin: wsCoin, interval: c.interval },
                this.hyperliquidCandleCb,
              )
              const get = this.unsubscribeMap.get('candle') ?? []
              get.push(unsubscribe)
              this.unsubscribeMap.set('candle', get)
              res()
            } catch (e) {
              rej(e)
            } finally {
              clearTimeout(t)
            }
          }).catch((e) => {
            logger.error(
              `Error subscribing Hyperliquid candle ${c.coin} ${c.interval}: ${e}`,
            )
            if (String(e).includes('connection closed')) {
              // Keep in ownerEntry.items — the socket is reconnecting and
              // onopen will re-queue this item through the rate-limited
              // batching.  No timed retry needed.
              logger.info(
                `Hyperliquid candle ${c.coin} ${c.interval} will retry on reconnect`,
              )
              connectionClosed = true
            } else {
              // Non-connection error (e.g. ACK timeout): remove optimistic
              // entry and fall back to the 60 s timed retry.
              ownerEntry?.items.delete(`${c.coin}-${c.interval}`)
              failedItems.push(c)
            }
          })
          if (!connectionClosed) {
            await new Promise((r) => setTimeout(r, subDelayMs))
          }
        }
        if (i < chunks.length) {
          const secondsToSleep = (chunk.length / 2000) * 60 * 1000
          logger.info(
            `Sleeping ${secondsToSleep / 1000} seconds before next Hyperliquid candle chunk`,
          )
          await new Promise((r) => setTimeout(r, secondsToSleep))
        }
      }
    }

    // Schedule a retry pass for any subscriptions that timed out or were
    // rejected. After a 60-second cooldown the items are added back to
    // inQueueCandles and the normal debounce cycle picks them up.
    if (failedItems.length > 0) {
      logger.info(
        `Scheduling retry for ${failedItems.length} failed Hyperliquid candle subscriptions in 60s`,
      )
      const retryDelayMs = 60_000
      setTimeout(() => {
        for (const item of failedItems) {
          this.inQueueCandles.set(`${item.coin}-${item.interval}`, item)
        }
        if (!this.timer) {
          const t = setTimeout(() => {
            this.timer = null
            this.connectHyperliquidCandleStreams([], true)
          }, 0)
          this.timer = t
        }
      }, retryDelayMs)
    }
  }

  stop() {
    super.stop()
    if (this.metaRefreshTimer) {
      clearInterval(this.metaRefreshTimer)
      this.metaRefreshTimer = null
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.stopHyperliquid()
  }

  private async convertHyperliquidTicker(
    data: hl.WsAllMids['mids'],
  ): Promise<{ spot: Ticker[]; linear: Ticker[] }> {
    const spot: Ticker[] = []
    const linear: Ticker[] = []
    await Promise.all(
      Object.entries(data).map(async ([coin, price]) => {
        const exchange =
          coin.startsWith('@') || coin.includes('/')
            ? ExchangeEnum.hyperliquid
            : ExchangeEnum.hyperliquidLinear
        const symbol = this.symbols.codeToPair(coin) ?? coin
        const v: Ticker = {
          eventType: '24hrMiniTicker',
          eventTime: +new Date(),
          curDayClose: price,
          open: price,
          high: price,
          low: price,
          volume: '10000000',
          volumeQuote: '10000000',
          symbol,
          bestBid: price,
          bestAsk: price,
          bestAskQnt: price,
          bestBidQnt: price,
        }
        if (exchange === ExchangeEnum.hyperliquid) {
          spot.push(v)
        } else {
          linear.push(v)
        }
      }),
    )
    return { spot, linear }
  }
}

export default HyperliquidConnector
