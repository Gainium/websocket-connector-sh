/**
 * Binance issues exchange order ids as JSON *numbers*. USDM futures ids are now
 * routinely 19 digits (e.g. 8389766269723522123), which is far above
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1). `JSON.parse` has no representation for
 * such an integer, so it silently returns the nearest IEEE-754 double and the low
 * digits are gone: 8389766269723522123 comes back as 8389766269723522000.
 *
 * The vendor `binance` websocket client parses every frame with a bare `JSON.parse`
 * (`parseRawWsMessage`, `lib/util/websockets/websocket-util.js:798`) — so every
 * user-stream order event reaching this connector had already lost those digits
 * before `utils/binance.js` read `m.o.i`. Because the rounding is many-to-one,
 * distinct venue orders collapse onto one id (spec 004 §2.2: 22 collision groups /
 * 52 rows / 6 users on production).
 *
 * The digits only exist in the raw frame text, so the repair has to happen before
 * `JSON.parse` sees them: quote the id so it survives as a string. See
 * `specs/004.binance-user-stream-order-id-precision-loss.md`.
 *
 * PORTED from `exchange-connector-sh core/src/binance-custom/losslessOrderId.ts`,
 * which fixed the REST half of the same defect (shipped 2026-09-05). The scan is
 * carried over unchanged; only `UNSAFE_INT_KEYS` differs, because the websocket
 * wire spells the field `i` where REST spells it `orderId`. The two cores share no
 * package, so this is a copy for the same reason `utils/redact.ts` is.
 */

/**
 * Object keys whose value is a venue-issued integer id that can exceed 2^53 and
 * must therefore be preserved as text.
 *
 * Deliberately narrow. `i` is the exchange order id in both user-stream shapes —
 * `o.i` in a futures `ORDER_TRADE_UPDATE` and `i` in a spot `executionReport` —
 * and is the only user-stream field that is a venue integer id at all. The REST
 * spelling `orderId` is *not* included: `userStream.ts` only ever subscribes to
 * user data and places no orders, so no WS-API order response travels on these
 * sockets. A kline's `i` (the interval, `"1m"`) is a JSON string and is skipped
 * whole by the scan below — and klines do not travel on a user stream regardless.
 *
 * Widening this retypes a field from number to string for the consumer of the
 * account channel payload — add a key only with that consumer checked (spec §5).
 */
const UNSAFE_INT_KEYS = new Set(['i'])

/** Digits `0`-`9`. */
function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

/**
 * Index just past the JSON string literal that starts at `start` (which must be the
 * opening quote), honouring backslash escapes. Returns `raw.length` for an
 * unterminated literal, so a truncated frame degrades to "no rewrite" rather than
 * looping.
 */
function endOfStringLiteral(raw: string, start: number): number {
  let i = start + 1
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '"') return i + 1
    i += 1
  }
  return raw.length
}

/** Index of the next character that is not JSON insignificant whitespace. */
function skipWhitespace(raw: string, start: number): number {
  let i = start
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      i += 1
      continue
    }
    return i
  }
  return i
}

/**
 * Rewrite `"i": <huge integer>` as `"i": "<huge integer>"` in raw JSON text, so
 * `JSON.parse` yields the exact digits instead of a rounded double.
 *
 * The scan is string-literal aware: it always jumps over a complete string literal,
 * so digits appearing *inside* a value (a `clientOrderId`, a Binance error `msg`)
 * are never touched (spec 004 §4.3.2). Only a literal that is followed by `:` counts
 * as a key.
 *
 * Ids at or below `Number.MAX_SAFE_INTEGER` are left as JSON numbers (§4.3.1), which
 * makes this a no-op for the overwhelming majority of orders and keeps their type
 * exactly as it is today.
 */
export function quoteUnsafeIntegerIds(raw: string): string {
  let out = ''
  let copiedTo = 0
  let i = 0

  while (i < raw.length) {
    if (raw[i] !== '"') {
      i += 1
      continue
    }

    const literalEnd = endOfStringLiteral(raw, i)
    const afterLiteral = skipWhitespace(raw, literalEnd)

    // Not a key (no `:` follows) — it was a string value. Skipping the whole
    // literal is what keeps its contents out of reach of this rewrite.
    if (raw[afterLiteral] !== ':') {
      i = literalEnd
      continue
    }

    const key = raw.slice(i + 1, literalEnd - 1)
    if (!UNSAFE_INT_KEYS.has(key)) {
      i = literalEnd
      continue
    }

    const valueStart = skipWhitespace(raw, afterLiteral + 1)
    let digitsEnd = valueStart
    while (digitsEnd < raw.length && isDigit(raw.charCodeAt(digitsEnd))) {
      digitsEnd += 1
    }

    // Only a bare run of digits qualifies. Anything else (an already-quoted id, a
    // negative placeholder such as -1, null, a nested object) is left alone.
    if (digitsEnd === valueStart) {
      i = literalEnd
      continue
    }

    const digits = raw.slice(valueStart, digitsEnd)
    if (Number.isSafeInteger(Number(digits))) {
      i = digitsEnd
      continue
    }

    out += raw.slice(copiedTo, valueStart) + '"' + digits + '"'
    copiedTo = digitsEnd
    i = digitsEnd
  }

  if (copiedTo === 0) return raw
  return out + raw.slice(copiedTo)
}

/**
 * Drop-in replacement for the vendor client's default `JSON.parse` of an incoming
 * websocket frame, keeping Binance order ids exact.
 *
 * The SDK's own contract is `(raw: string) => object`, and it calls this inside the
 * `try` in `onWsMessage`. A frame that is not JSON therefore has to keep throwing
 * exactly as `JSON.parse` does today (spec 004 §4.3.3) — swallowing it here would
 * turn a malformed frame into an unrecognised-event log line instead of the
 * existing handled exception.
 */
export function parseBinanceWsFrame(raw: string): object {
  return JSON.parse(quoteUnsafeIntegerIds(raw))
}
