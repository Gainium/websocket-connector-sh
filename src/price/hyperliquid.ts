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
        : ExchangeEnum.hyperliquidLinear,
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
        }, 200)
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
    const subBatchSize = 5
    const subBatchDelayMs = 2000
    const failedItems: typeof items = []
    for (let bi = 0; bi < items.length; bi += subBatchSize) {
      const batch = items.slice(bi, bi + subBatchSize)
      await Promise.all(
        batch.map(async (c) => {
          entry.items.set(`${c.coin}-${c.interval}`, c)
          await new Promise<void>(async (res, rej) => {
            const t = setTimeout(() => rej(new Error('Timeout')), 10_000)
            try {
              const unsubscribe = await entry.client.candle(
                { coin: c.coin, interval: c.interval },
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
              // Item stays in entry.items; onopen will retry on next reconnect
            } else {
              entry.items.delete(`${c.coin}-${c.interval}`)
              failedItems.push(c)
            }
          })
        }),
      )
      if (bi + subBatchSize < items.length) {
        await new Promise((r) => setTimeout(r, subBatchDelayMs))
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
    const transport = new hl.WebSocketTransport({
      url:
        process.env.HYPERLIQUIDENV === 'demo'
          ? 'wss://api.hyperliquid-testnet.xyz/ws'
          : 'wss://api.hyperliquid.xyz/ws',
      reconnect: {
        maxRetries: 100,
        connectionDelay: (attempt) => Math.min((1 << attempt) * 150, 10000),
      },
    })
    transport.socket.onclose = (event) => {
      logger.info(`Hyperliquid closed: ${event.reason}`)
    }
    transport.socket.onerror = (event) => {
      logger.error(`Hyperliquid error: ${JSON.stringify(event)}`)
    }
    transport.socket.onopen = () => {
      logger.info(`Hyperliquid connected`)
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
        // Send subscribe messages in small concurrent bursts with a pause
        // between bursts. Larger bursts (20+) cause Hyperliquid to stop
        // sending ACKs after a few minutes (rate-limiting).
        const subBatchSize = 5
        const subBatchDelayMs = 2000
        for (let bi = 0; bi < chunk.length; bi += subBatchSize) {
          const subBatch = chunk.slice(bi, bi + subBatchSize)
          await Promise.all(
            subBatch.map(async (c) => {
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
              await new Promise<void>(async (res, rej) => {
                const t = setTimeout(() => rej(new Error('Timeout')), 10 * 1000)
                try {
                  const unsubscribe = await client.candle(
                    { coin: c.coin, interval: c.interval },
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
                } else {
                  // Non-connection error (e.g. ACK timeout): remove optimistic
                  // entry and fall back to the 60 s timed retry.
                  ownerEntry?.items.delete(`${c.coin}-${c.interval}`)
                  failedItems.push(c)
                }
              })
            }),
          )
          if (bi + subBatchSize < chunk.length) {
            await new Promise((r) => setTimeout(r, subBatchDelayMs))
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
    this.stopHyperliquid()
  }

  private async convertHyperliquidTicker(
    data: hl.WsAllMids['mids'],
  ): Promise<{ spot: Ticker[]; linear: Ticker[] }> {
    const spot: Ticker[] = []
    const linear: Ticker[] = []
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
        if (coin.startsWith('@') || coin.includes('/')) {
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
