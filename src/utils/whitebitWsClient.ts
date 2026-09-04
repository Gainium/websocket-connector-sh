/**
 * Minimal WhiteBit JSON-RPC WebSocket client.
 *
 * WhiteBit publishes no npm SDK, so — exactly like `hyperliquidUserClient.ts`
 * — the protocol is handled directly here and shared by both consumers in this
 * repo (`price/whitebit.ts` and the private branch of `userStream.ts`), which
 * speak the same envelope over the same endpoint and need the same keepalive:
 *
 *   1. Open a WS to wss://wss.whitebit.com/ws.
 *   2. On open, run the caller's `onOpen` (authorize / re-subscribe).
 *   3. Send `{"id":n,"method":"ping","params":[]}` every 50s — WhiteBit drops
 *      connections idle for 60s and gives us no keepalive for free.
 *   4. On message, dispatch: `{id, result|error}` resolves a pending request,
 *      `{id: null, method, params}` is an unsolicited push.
 *   5. On close, exponential backoff and reconnect (unless closed on purpose).
 *
 * Request/response correlation exists because `authorize` is the one call that
 * must be awaited (spec §2.4). `ping` and the `*_subscribe` calls are
 * fire-and-forget from this client's perspective, so they go through `notify`
 * and never occupy a pending slot.
 */

import WebSocket from 'ws'
import logger from './logger'
import { WHITEBIT_PING_INTERVAL_MS, WHITEBIT_WS_URL } from './whitebit'

/** The slice of the `ws` surface this client uses — lets tests inject a double. */
export interface WhitebitSocket {
  on(event: 'open', cb: () => void): unknown
  on(event: 'message', cb: (raw: unknown) => void): unknown
  on(event: 'error', cb: (err: unknown) => void): unknown
  on(event: 'close', cb: (code?: number, reason?: unknown) => void): unknown
  send(data: string): void
  close(): void
  removeAllListeners?: () => void
}

export type WhitebitRpcResponse = {
  id?: number | null
  result?: unknown
  error?: { code?: number; message?: string } | null
  method?: string
  params?: unknown
}

export type WhitebitWsClientOptions = {
  url?: string
  /** Log tag so a line says which socket (room id, market, interval) it is. */
  tag: string
  /** Ran on every open — authorize and (re-)subscribe here. Rejections are
   *  logged and close the socket so the backoff reopens it. */
  onOpen?: () => Promise<void> | void
  /** Unsolicited server push: `{id: null, method, params}`. */
  onPush?: (method: string, params: unknown) => void
  onClose?: (info: { code?: number; reason?: string }) => void
  onError?: (err: unknown) => void
  pingIntervalMs?: number
  initialReconnectDelayMs?: number
  maxReconnectDelayMs?: number
  /** Test seam: build the transport. Defaults to a real `ws` socket. */
  createSocket?: (url: string) => WhitebitSocket
}

export class WhitebitWsClient {
  private url: string
  private opts: WhitebitWsClientOptions
  private socket: WhitebitSocket | null = null
  private opened = false
  private closed = false
  private reconnectAttempt = 0
  private pingTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private nextId = 1
  /**
   * In-flight correlated requests, keyed by the JSON-RPC `id` we sent. The
   * standard shape for this — the piece of plumbing this integration adds that
   * no other exchange branch in this repo needed, because their SDKs own it.
   */
  private pending: Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (err: Error) => void
      timer: NodeJS.Timeout | null
      method: string
    }
  > = new Map()

  constructor(opts: WhitebitWsClientOptions) {
    this.opts = opts
    this.url = opts.url ?? WHITEBIT_WS_URL
  }

  get isOpen(): boolean {
    return this.opened && !this.closed
  }

  /** Open the socket. Resolves once `onOpen` has finished on a live socket. */
  start(timeoutMs = 15_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.safeCloseSocket()
        reject(
          new Error(
            `WhitebitWsClient(${this.opts.tag}) open timed out after ${timeoutMs}ms`,
          ),
        )
      }, timeoutMs)
      this.connect({
        onReady: () => {
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

  /** Permanently close — no further reconnects. */
  close(): void {
    this.closed = true
    this.stopPing()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.rejectAllPending(
      new Error(`WhitebitWsClient(${this.opts.tag}) closed`),
    )
    this.safeCloseSocket()
  }

  /** Fire-and-forget request (`ping`, every `*_subscribe`). */
  notify(method: string, params: unknown[]): void {
    const id = this.nextId++
    this.rawSend({ id, method, params })
  }

  /**
   * Send a request and await the response correlated by `id`. Only
   * `authorize` needs this today.
   */
  request(
    method: string,
    params: unknown[],
    timeoutMs = 10_000,
  ): Promise<unknown> {
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        entry.reject(
          new Error(
            `WhitebitWsClient(${this.opts.tag}) ${method} (id ${id}) timed out after ${timeoutMs}ms`,
          ),
        )
      }, timeoutMs)
      // `unref` so a pending request can never hold the process open; absent on
      // the fake timers a test may install.
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.rawSend({ id, method, params })
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err as Error)
      }
    })
  }

  /**
   * Feed one raw frame through the dispatcher. Public so a test can drive the
   * correlation logic without a socket at all.
   */
  handleMessage(raw: unknown): void {
    let msg: WhitebitRpcResponse
    try {
      msg = JSON.parse(
        typeof raw === 'string' ? raw : `${raw as { toString(): string }}`,
      ) as WhitebitRpcResponse
    } catch {
      // WhiteBit only speaks JSON; anything else is a protocol oddity.
      return
    }
    if (!msg || typeof msg !== 'object') return

    // Unsolicited push: `{id: null, method, params}`.
    if ((msg.id === null || msg.id === undefined) && msg.method) {
      this.opts.onPush?.(msg.method, msg.params)
      return
    }

    if (typeof msg.id !== 'number') return
    const entry = this.pending.get(msg.id)
    if (!entry) {
      // A `ping`/`_subscribe` ack, or a response to a request that already
      // timed out. Nothing is waiting on it.
      return
    }
    this.pending.delete(msg.id)
    if (entry.timer) clearTimeout(entry.timer)
    if (msg.error) {
      entry.reject(
        new Error(
          `WhiteBit ${entry.method} rejected: ${
            msg.error.message ?? JSON.stringify(msg.error)
          }`,
        ),
      )
      return
    }
    entry.resolve(msg.result)
  }

  private rawSend(frame: { id: number; method: string; params: unknown }) {
    const socket = this.socket
    if (!socket || !this.opened) {
      throw new Error(
        `WhitebitWsClient(${this.opts.tag}) not connected; dropped ${frame.method}`,
      )
    }
    socket.send(JSON.stringify(frame))
  }

  private rejectAllPending(err: Error) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
    }
  }

  private startPing() {
    this.stopPing()
    const every = this.opts.pingIntervalMs ?? WHITEBIT_PING_INTERVAL_MS
    if (every <= 0) return
    this.pingTimer = setInterval(() => {
      if (!this.opened) return
      try {
        // Fire-and-forget: WhiteBit answers `{"result":"pong"}`, and nothing
        // here waits for it — the socket staying open IS the signal.
        this.notify('ping', [])
      } catch (err) {
        this.opts.onError?.(err)
      }
    }, every)
    this.pingTimer.unref?.()
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private safeCloseSocket() {
    try {
      this.socket?.close()
    } catch {
      // best-effort cleanup
    }
  }

  private connect(handshake?: {
    onReady: () => void
    onEarlyFailure: (err: Error) => void
  }) {
    if (this.closed) return
    const socket: WhitebitSocket = this.opts.createSocket
      ? this.opts.createSocket(this.url)
      : (new WebSocket(this.url) as unknown as WhitebitSocket)
    this.socket = socket
    this.opened = false

    socket.on('open', () => {
      this.opened = true
      this.reconnectAttempt = 0
      this.startPing()
      void Promise.resolve()
        .then(() => this.opts.onOpen?.())
        .then(() => handshake?.onReady())
        .catch((err) => {
          logger.error(
            `WhitebitWsClient(${this.opts.tag}) onOpen failed: ${
              (err as Error)?.message ?? err
            }`,
          )
          this.opts.onError?.(err)
          // Let the close handler's backoff reopen and retry the handshake.
          this.safeCloseSocket()
          handshake?.onEarlyFailure(err as Error)
        })
    })

    socket.on('message', (raw) => this.handleMessage(raw))

    socket.on('error', (err) => {
      this.opts.onError?.(err)
      if (!this.opened) {
        handshake?.onEarlyFailure(err as Error)
      }
    })

    socket.on('close', (code, reason) => {
      const wasOpen = this.opened
      this.opened = false
      this.stopPing()
      const reasonText = reason ? `${reason}` : ''
      this.rejectAllPending(
        new Error(
          `WhitebitWsClient(${this.opts.tag}) socket closed (${code ?? ''})`,
        ),
      )
      this.opts.onClose?.({ code, reason: reasonText })
      if (!wasOpen) {
        handshake?.onEarlyFailure(
          new Error(
            `closed before open: code=${code ?? ''} reason="${reasonText}"`,
          ),
        )
      }
      if (this.closed) return
      const delay = Math.min(
        (this.opts.initialReconnectDelayMs ?? 1_000) *
          2 ** this.reconnectAttempt,
        this.opts.maxReconnectDelayMs ?? 60_000,
      )
      this.reconnectAttempt++
      logger.info(
        `WhitebitWsClient(${this.opts.tag}) reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`,
      )
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
      this.reconnectTimer.unref?.()
    })
  }
}

export default WhitebitWsClient
