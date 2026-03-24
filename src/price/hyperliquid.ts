import * as hl from '@nktkas/hyperliquid'
import { setMaxListeners } from 'events'

import { ExchangeEnum, mapPaperToReal } from '../utils/common'
import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'
import CommonConnector from './common'

import type { Ticker, StreamType, SubscribeCandlePayload } from './types'

const mutex = new IdMutex()

const maxCandlesPerConnection = 1000
// Hyperliquid enforces a per-IP limit of 10 simultaneous WS connections.
// Reserve 1 for the ticker client and 1 as a safety buffer.
const maxCandleClients = 8

class HyperliquidConnector extends CommonConnector {
  private unsubscribeMap: Map<StreamType, hl.Subscription[]> = new Map()
  private timer: NodeJS.Timeout | null = null
  private inQueueCandles: Map<
    string,
    {
      coin: string
      interval: hl.WsCandleParameters['interval']
    }
  > = new Map()
  /** Display name → API code, e.g. "PUMP-USDC" → "@20" */
  private nameToCode: Map<string, string> = new Map()
  /** API code → display name, e.g. "@20" → "PUMP-USDC" */
  private codeToName: Map<string, string> = new Map()
  private hyperliquidClient: hl.SubscriptionClient =
    this.getHyperliquidClient('ticker')
  private hyperliquidClientCandle: {
    client: hl.SubscriptionClient<hl.WebSocketTransport>
    id: number
    count: number
    /** Candle subscriptions currently active on this connection. Used to re-queue on reconnect. */
    items: Map<
      string,
      { coin: string; interval: hl.WsCandleParameters['interval'] }
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
    const symbol = this.codeToName.get(msg.s) ?? msg.s
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
    items: { coin: string; interval: hl.WsCandleParameters['interval'] }[],
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
      const wsCoin = this.toWsCoin(c.coin)
      if (!wsCoin) {
        logger.error(
          `Failed to translate symbol ${c.coin} for Hyperliquid candle resubscription — skipping`,
        )
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
      logger.error(`Hyperliquid error: ${JSON.stringify(event)}`)
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
        this.connectHyperliquidCandleStreams([
          { symbol, interval: interval as hl.WsCandleParameters['interval'] },
        ])
      }
    }
  }

  private metaRefreshTimer: NodeJS.Timeout | null = null

  async init() {
    await this.fetchMeta()
    this.metaRefreshTimer = setInterval(
      () => {
        this.fetchMeta()
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
   * Fetches spotMeta from the Hyperliquid REST API and builds the
   * display-name ↔ @N mapping needed for candle subscriptions.
   * Spot coins are referenced as @0, @1, … in the WS API but callers
   * send display names like "PUMP-USDC".
   */
  private async fetchMeta() {
    try {
      const infoClient = new hl.InfoClient({
        transport: new hl.HttpTransport({
          isTestnet: process.env.HYPERLIQUID === 'demo',
        }),
      })
      const newNameToCode = new Map<string, string>()
      const newCodeToName = new Map<string, string>()
      await infoClient
        .spotMeta()
        .then((result) => {
          const pairs = result.universe
          const tokens = result.tokens
          pairs.map((d) => {
            const base = tokens.find((t) => t.index === d.tokens[0])
            const baseName = base?.name === 'UBTC' ? 'BTC' : base?.name
            const quote = tokens.find((t) => t.index === d.tokens[1])
            const displayName = `${baseName}-${quote?.name}`
            newNameToCode.set(displayName, d.name)
            newCodeToName.set(d.name, displayName)
          })
        })
        .catch((e) => {
          logger.error(`Failed to fetch Hyperliquid spotMeta: ${e}`)
        })
      await infoClient.meta().then((result) => {
        const tokens = result.universe
        tokens.map((t) => {
          const displayName = `${t.name}-USDC`
          newNameToCode.set(displayName, t.name)
          newCodeToName.set(t.name, displayName)
        })
      })
      // Only replace maps if we got data — on failure keep previous values.
      if (newNameToCode.size > 0) {
        this.nameToCode = newNameToCode
        this.codeToName = newCodeToName
        logger.info(
          `Loaded ${this.nameToCode.size} symbol mappings from Hyperliquid`,
        )
      }
    } catch (e) {
      logger.error(
        `Failed to fetch Hyperliquid meta (keeping ${this.nameToCode.size} existing mappings): ${e}`,
      )
    }
  }

  /**
   * Translates a coin name to the format Hyperliquid's WS API expects.
   * Spot display names (e.g. "PUMP-USDC") → "@20"; perps pass through.
   */
  private toWsCoin(coin: string): string | undefined {
    return this.nameToCode.get(coin)
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
    const store: string[][] = []
    for (const ex of [
      ExchangeEnum.hyperliquid,
      ExchangeEnum.hyperliquidLinear,
    ] as const) {
      const set = this.subscribedCandlesMap.get(ex) ?? new Set()
      set.forEach((s) => {
        store.push(this.splitCandleRoomName(s))
      })
    }
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
    // Hard cap: do not open more than maxCandleClients connections.
    // Hyperliquid allows ≤10 simultaneous WS connections per IP; we reserve
    // capacity for the ticker and a safety margin.
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
    _data: { symbol: string; interval: hl.WsCandleParameters['interval'] }[],
    timer = false,
  ) {
    const data = _data.map(({ symbol, interval }) => {
      return { coin: symbol, interval }
    })
    if (!timer) {
      data.forEach((d) => {
        this.inQueueCandles.set(`${d.coin}-${d.interval}`, {
          coin: d.coin,
          interval: d.interval,
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
    const failedItems: {
      coin: string
      interval: hl.WsCandleParameters['interval']
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
          })
          const wsCoin = this.toWsCoin(c.coin)
          if (!wsCoin) {
            logger.error(
              `Failed to translate symbol ${c.coin} for Hyperliquid candle subscription — skipping`,
            )
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
        const symbol = this.codeToName.get(coin) ?? coin
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
