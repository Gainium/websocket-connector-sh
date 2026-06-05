import { networkInterfaces } from 'os'
// Default import only: ws 7.x exports the class via `module.exports =
// WebSocket` with no named `WebSocket` property, so a named import
// resolves to `undefined` at runtime even though the TS types pass.
// `ClientOptions` is a compile-time type — `import type` keeps it
// from emitting a runtime require.
import WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import logger from './logger'

/**
 * Hyperliquid IP rotation for the user-stream worker.
 *
 * Hyperliquid enforces a 10-WebSocket cap **per source IP**. A host
 * provisioned with N external IPs can therefore carry N × 10 unique
 * HL users — but only if each connection actually goes out a
 * different IP. The default OS routing usually pins every outbound
 * connection to a single primary IP, so the cap stays at 10 unless
 * we explicitly bind each socket to a different local address.
 *
 * What this module does, in worker mode only:
 *   1. Enumerates all non-internal IPv4 addresses on the host.
 *   2. Monkey-patches `globalThis.WebSocket` with a subclass of
 *      `ws.WebSocket` that injects a round-robin `localAddress` into
 *      every constructor call. `@nktkas/hyperliquid` instantiates
 *      its sockets via `new WebSocket(url, protocols)` and reads the
 *      class from the global scope, so this is the cleanest hook
 *      without forking the library.
 *   3. Returns the new effective per-process cap.
 *
 * What this module does NOT do:
 *   - Verify routability of each IP. If you list 5 IPs in
 *     `networkInterfaces()` but only 2 actually reach the internet,
 *     the other 3 connections will hang or fail. Ops responsibility.
 *   - Patch any other WebSocket consumer. Binance/Bybit/etc. use
 *     their own ws clients directly; only consumers reading
 *     `globalThis.WebSocket` (which is `@nktkas/hyperliquid`) are
 *     affected. In the HL-only worker this is fine.
 *
 * Idempotent — call at most once per process. Safe to call on a
 * single-IP host: no monkey-patch is applied and the function
 * returns the unchanged cap.
 */

const PER_IP_CAP = 10

let detectedIps: string[] = []
let installed = false
/**
 * Per-IP active connection count, maintained by the patched
 * `WebSocket` class via its own `open`/`close` events. Source of truth
 * for the picker (least-loaded) and for the queryable status snapshot.
 */
const ipLoad = new Map<string, number>()

const socketLocalAddress = new WeakMap<object, string>()

export function getBoundLocalAddress(socket: unknown): string | undefined {
  if (!socket || typeof socket !== 'object') return undefined
  return socketLocalAddress.get(socket as object)
}

/**
 * RFC1918 private + 169.254/16 link-local + 100.64/10 CGNAT.
 * Docker bridges live in 172.16/12 (e.g. 172.17.0.1, 172.20.0.1) and
 * 192.168/16, so without this filter the bridge gateways show up as
 * "external IPs" — round-robin would send half the HL sockets out
 * interfaces that can't reach the public internet, hanging the open
 * handshake until timeout. `addr.internal` only flags loopback.
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true
  const [a, b] = parts
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  return false
}

/** Returns all routable public IPv4 addresses on the host. Filters
 *  loopback (`addr.internal`), IPv6, and RFC1918/link-local/CGNAT.
 *  Deduped and sorted for deterministic round-robin order across
 *  restarts. */
export function detectAvailableIPs(): string[] {
  const ips = new Set<string>()
  const ifs = networkInterfaces()
  for (const name of Object.keys(ifs)) {
    for (const addr of ifs[name] ?? []) {
      if (addr.internal) continue
      // HL endpoints are IPv4; skip IPv6 so the round-robin pool
      // matches the cap-counting authority.
      if (addr.family !== 'IPv4') continue
      if (isPrivateIPv4(addr.address)) continue
      ips.add(addr.address)
    }
  }
  return [...ips].sort()
}

/**
 * Pick the least-loaded IP, breaking ties by `detectedIps` order
 * (which is sorted for determinism). Returns `undefined` when no IPs
 * are configured or every IP is at the per-IP cap — the caller
 * (the patched WebSocket constructor) treats that as "use whatever
 * the OS picks" and the connection will likely fail at HL's 10-cap.
 */
function pickLeastLoadedIp(): string | undefined {
  if (detectedIps.length === 0) return undefined
  let best: string | undefined
  let bestLoad = PER_IP_CAP
  for (const ip of detectedIps) {
    const load = ipLoad.get(ip) ?? 0
    if (load >= PER_IP_CAP) continue
    if (load < bestLoad) {
      bestLoad = load
      best = ip
    }
  }
  return best
}

function increment(ip: string) {
  ipLoad.set(ip, (ipLoad.get(ip) ?? 0) + 1)
}

function decrement(ip: string) {
  ipLoad.set(ip, Math.max(0, (ipLoad.get(ip) ?? 0) - 1))
}

export function reserveHyperliquidIp(): string | undefined {
  const ip = pickLeastLoadedIp()
  if (ip) increment(ip)
  return ip
}

export function releaseHyperliquidIp(ip: string): void {
  decrement(ip)
}

/**
 * Snapshot of current per-IP load. Cheap to call — backed by an
 * in-memory map. The worker logs this on every heartbeat so you can
 * spot saturation in operations.
 */
export function hyperliquidIpStatus(): {
  ips: string[]
  load: Record<string, number>
  perIpCap: number
  totalCap: number
} {
  return {
    ips: detectedIps,
    load: Object.fromEntries(
      detectedIps.map((ip) => [ip, ipLoad.get(ip) ?? 0]),
    ),
    perIpCap: PER_IP_CAP,
    totalCap: Math.max(PER_IP_CAP, detectedIps.length * PER_IP_CAP),
  }
}

/**
 * Install the monkey-patch and return the resulting cap. Idempotent:
 * the second call is a no-op and returns the cached values. Call from
 * the worker's boot path **before** any `WebSocketTransport` is
 * constructed.
 */
export function installHyperliquidIpRotation(): {
  ips: string[]
  cap: number
} {
  if (installed) {
    return {
      ips: detectedIps,
      cap: Math.max(PER_IP_CAP, detectedIps.length * PER_IP_CAP),
    }
  }
  installed = true
  detectedIps = detectAvailableIPs()

  if (detectedIps.length <= 1) {
    logger.info(
      `Hyperliquid IP rotation: ${detectedIps.length} external IPv4 detected (${
        detectedIps.join(',') || '<none>'
      }); leaving global WebSocket alone, per-process cap=${PER_IP_CAP}`,
    )
    return { ips: detectedIps, cap: PER_IP_CAP }
  }

  /**
   * Subclass of `ws.WebSocket` that round-robins through the detected
   * IPs. Caller-supplied `localAddress` (rare, but legal) wins over
   * our rotation so we don't break anyone who knows what they're
   * doing. `@nktkas/hyperliquid` invokes `new WebSocket(url, protocols)`
   * with only two args, so the rotation always fires for HL.
   */
  class IpRotatingWebSocket extends WebSocket {
    constructor(
      url: string | URL,
      protocols?: string | string[],
      options?: ClientOptions,
    ) {
      const localAddress = options?.localAddress ?? pickLeastLoadedIp()
      super(url, protocols, {
        ...options,
        ...(localAddress ? { localAddress } : {}),
      })
      if (localAddress) {
        socketLocalAddress.set(this, localAddress)
        logger.info(
          `IpRotatingWebSocket constructed bound=${localAddress} url=${String(url)}`,
        )
        // Increment on construction so concurrent picks see this slot
        // as taken even before the socket finishes opening. Decrement
        // exactly once on close.
        increment(localAddress)
        let released = false
        const release = () => {
          if (released) return
          released = true
          decrement(localAddress)
        }
        this.addEventListener('close', release, { once: true })
        // Belt-and-braces: if the socket errors out before 'open' and
        // never emits 'close' (rare but observed under TLS failure),
        // 'error' followed by GC would leak. Hook 'error' too — both
        // are gated by the `released` flag so we still only decrement
        // once.
        this.addEventListener('error', release, { once: true })
      }
    }
  }

  // The cast is required because `ws.WebSocket` adds extras over the
  // WHATWG interface (ping/pong helpers, EventEmitter methods, etc.).
  // `@nktkas/hyperliquid` only touches the WHATWG surface (constructor,
  // readyState, send, close, addEventListener/removeEventListener,
  // onmessage/onopen/onclose/onerror) — all present on `ws.WebSocket`.
  ;(globalThis as any).WebSocket = IpRotatingWebSocket

  const cap = detectedIps.length * PER_IP_CAP
  logger.info(
    `Hyperliquid IP rotation: ${detectedIps.length} external IPv4 detected [${detectedIps.join(
      ',',
    )}]; monkey-patched globalThis.WebSocket; per-process cap=${cap}`,
  )
  return { ips: detectedIps, cap }
}
