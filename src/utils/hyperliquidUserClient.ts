/**
 * Minimal Hyperliquid user-stream client. Replaces @nktkas's
 * SubscriptionClient + WebSocketTransport for the user-stream path.
 *
 * Why a custom client when the library exists:
 *   The library wraps the raw WebSocket in `ReconnectingWebSocket`,
 *   `HyperliquidEventTarget`, and `WebSocketAsyncRequest` with a
 *   `_subscriptions` cache and an autoResubscribe coordinator. In
 *   production we observed the WS connecting fine and HL accepting
 *   the subscribe (verified by a standalone probe — same IP, same
 *   subscribe message, same network: ack arrives in ~500ms), but
 *   the library's `await client.orderUpdates(...)` would never resolve
 *   and the wrapper would close the socket after exactly its 10s
 *   connectionTimeout — leaving us no way to make forward progress.
 *
 * The user-stream protocol is small enough to handle directly:
 *   1. Open a WS to wss://api.hyperliquid.xyz/ws.
 *   2. On open, send the subscribe message for each channel.
 *   3. On message, parse JSON and dispatch by `msg.channel`.
 *   4. On close, exponential backoff and reconnect.
 *
 * No auth, no signing, no message ID matching — HL echoes a
 * `subscriptionResponse` on success but it's optional: subsequent
 * `orderUpdates` / `userFills` messages will start flowing whether
 * we wait for the ack or not, and we don't actually use the ack for
 * anything beyond a log line.
 */

import WebSocket from 'ws'
import logger from './logger'

const DEFAULT_URL = 'wss://api.hyperliquid.xyz/ws'

export type HyperliquidUserClientOptions = {
  url?: string
  /** Called at the top of every connect attempt (initial + each
   *  reconnect) to pick the local IPv4 to bind the outgoing TCP
   *  socket to. On single-IP hosts this can be omitted; on multi-IP
   *  workers it should call `reserveHyperliquidIp` so the picker
   *  tracks load + picks a fresh IP for each retry. */
  pickLocalAddress?: () => string | undefined
  /** Called when a socket bound to `ip` is closed — release the slot
   *  so the picker can hand it out again. Required if `pickLocalAddress`
   *  is provided. */
  releaseLocalAddress?: (ip: string) => void
  /** EVM address whose updates we're subscribing to. */
  user: `0x${string}`
  /** Caller logger tag for correlating messages with the right user. */
  tag?: string
  /** Called with each `orderUpdates` message's `data` array. */
  onOrderUpdates: (data: unknown[]) => void
  /** Called with each `userFills` message's `data` object. */
  onUserFills: (data: { isSnapshot?: boolean; fills: unknown[] }) => void
  /** Optional: notify caller of lifecycle events for logs. */
  onOpen?: (info: { boundLocalAddress?: string }) => void
  onClose?: (info: {
    code: number
    reason: string
    boundLocalAddress?: string
  }) => void
  onError?: (err: unknown) => void
  /** Reconnect backoff bounds. */
  initialReconnectDelayMs?: number
  maxReconnectDelayMs?: number
  /** Application-level ping interval. HL expects a `{"method":"ping"}`
   *  every ~minute or it closes the socket as idle (~60s after the
   *  last message). Default 30_000 keeps us comfortably under that.
   *  Set to 0 to disable (don't — left configurable for tests only). */
  pingIntervalMs?: number
  /** Optional override: caller computes the next reconnect delay
   *  from `attempt` (0-based, incremented after this call) and the
   *  last `close` info. Lets callers boost the delay when HL just
   *  rejected for cap (need to wait out the per-IP rate limit). The
   *  default is `min(initialDelay * 2 ** attempt, maxDelay)`. */
  getReconnectDelay?: (
    attempt: number,
    lastClose: { code: number; reason: string } | null,
  ) => number
}

export class HyperliquidUserClient {
  private url: string
  private user: `0x${string}`
  private tag: string
  private socket: WebSocket | null = null
  private currentBoundIp?: string
  private closed = false
  private reconnectAttempt = 0
  private initialDelay: number
  private maxDelay: number
  private pingIntervalMs: number
  private pingTimer: NodeJS.Timeout | null = null
  private opts: HyperliquidUserClientOptions

  constructor(opts: HyperliquidUserClientOptions) {
    this.opts = opts
    this.url = opts.url ?? DEFAULT_URL
    this.user = opts.user
    this.tag = opts.tag ?? opts.user.slice(0, 10)
    this.initialDelay = opts.initialReconnectDelayMs ?? 1_000
    this.maxDelay = opts.maxReconnectDelayMs ?? 60_000
    this.pingIntervalMs = opts.pingIntervalMs ?? 30_000
  }

  /** The IP the current (or most-recent) socket is bound to. Reflects
   *  the freshly-picked IP after a reconnect — caller can log it. */
  getBoundLocalAddress(): string | undefined {
    return this.currentBoundIp
  }

  /** Open the socket and subscribe. Resolves after the underlying
   *  TCP/WS handshake completes (event 'open'). The subscribe message
   *  is sent immediately after — if the ack never comes back we still
   *  resolve, because in practice the data stream starts flowing
   *  regardless and we don't want to block the caller behind an ack
   *  that's purely informational. Reject only on hard connection
   *  failure (error / close before open). */
  start(timeoutMs = 15_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          this.socket?.close()
        } catch {
          // best-effort cleanup
        }
        reject(
          new Error(
            `HyperliquidUserClient(${this.tag}) open timed out after ${timeoutMs}ms`,
          ),
        )
      }, timeoutMs)
      this.connect({
        onOpen: () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        },
        onEarlyFailure: (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(err)
        },
      })
    })
  }

  /** Permanently close. No further reconnects. */
  close(): void {
    this.closed = true
    this.stopPingTimer()
    try {
      this.socket?.close()
    } catch {
      // best-effort
    }
  }

  private startPingTimer(ws: WebSocket) {
    this.stopPingTimer()
    if (this.pingIntervalMs <= 0) return
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(JSON.stringify({ method: 'ping' }))
      } catch (err) {
        this.opts.onError?.(err)
      }
    }, this.pingIntervalMs)
  }

  private stopPingTimer() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private connect(handshake?: {
    onOpen: () => void
    onEarlyFailure: (err: Error) => void
  }) {
    if (this.closed) return
    const localAddress = this.opts.pickLocalAddress?.()
    this.currentBoundIp = localAddress
    const ws = new WebSocket(
      this.url,
      undefined,
      localAddress ? { localAddress } : undefined,
    )
    this.socket = ws
    let opened = false
    let ipReleased = false
    const releaseIpOnce = () => {
      if (ipReleased) return
      ipReleased = true
      if (localAddress) this.opts.releaseLocalAddress?.(localAddress)
    }

    ws.on('open', () => {
      opened = true
      this.reconnectAttempt = 0
      try {
        ws.send(
          JSON.stringify({
            method: 'subscribe',
            subscription: { type: 'orderUpdates', user: this.user },
          }),
        )
        ws.send(
          JSON.stringify({
            method: 'subscribe',
            subscription: { type: 'userFills', user: this.user },
          }),
        )
      } catch (err) {
        this.opts.onError?.(err)
      }
      this.startPingTimer(ws)
      this.opts.onOpen?.({ boundLocalAddress: localAddress })
      handshake?.onOpen()
    })

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          channel?: string
          data?: unknown
        }
        if (!msg?.channel) return
        if (msg.channel === 'orderUpdates') {
          this.opts.onOrderUpdates(
            Array.isArray(msg.data) ? (msg.data as unknown[]) : [],
          )
        } else if (msg.channel === 'userFills') {
          const data = msg.data as
            | { isSnapshot?: boolean; fills?: unknown[] }
            | undefined
          this.opts.onUserFills({
            isSnapshot: data?.isSnapshot,
            fills: Array.isArray(data?.fills) ? data.fills : [],
          })
        }
        // subscriptionResponse and other channels: ignored.
      } catch {
        // Ignore JSON parse errors — HL only sends JSON, anything else
        // is either keepalive or a protocol oddity.
      }
    })

    ws.on('error', (err) => {
      this.opts.onError?.(err)
      if (!opened) {
        // 'close' will fire right after on most errors, but for socket
        // construction failures (e.g. localAddress not bindable) the
        // close event may never come. Release the IP slot here so we
        // don't leak it, then let the early-failure path reject the
        // start() promise. The matching 'close' will release-again
        // safely via the `ipReleased` flag.
        releaseIpOnce()
        handshake?.onEarlyFailure(err as Error)
      }
    })

    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf.toString()
      releaseIpOnce()
      this.stopPingTimer()
      this.opts.onClose?.({ code, reason, boundLocalAddress: localAddress })
      if (!opened) {
        handshake?.onEarlyFailure(
          new Error(`closed before open: code=${code} reason="${reason}"`),
        )
      }
      if (this.closed) return
      const lastClose = { code, reason }
      const defaultDelay = Math.min(
        this.initialDelay * 2 ** this.reconnectAttempt,
        this.maxDelay,
      )
      const delay =
        this.opts.getReconnectDelay?.(this.reconnectAttempt, lastClose) ??
        defaultDelay
      this.reconnectAttempt++
      logger.info(
        `HyperliquidUserClient(${this.tag}) reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`,
      )
      setTimeout(() => this.connect(), delay)
    })
  }
}
