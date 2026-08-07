/**
 * Credential redaction for anything that gets serialized into a log line.
 *
 * SHARED MODULE — kept byte-identical in exchange-connector core and
 * websocket-connector core. The two services drive the same exchange SDKs, so a
 * leaking shape found in one leaks in the other, and a divergent copy would mean
 * a shape fixed in one place quietly stays open in the other. Port changes to
 * both, or to neither.
 *
 * Exchange SDKs routinely staple the *request* they just made onto the error
 * they throw, and the signed request carries live credentials. `@siebly/kraken-api`
 * is the worst offender: `parseException()` blanks the `APIKey` option but
 * spreads `options.headers` verbatim, so the real `API-Key` / `API-Sign` headers
 * ride along inside `error.requestParams.options.headers` — right next to the
 * field it *did* redact. Our own `bybit-custom` / `bitget-custom` clients do the
 * same with `requestOptions: this.options`, which is where `key`/`secret` live.
 *
 * A credential does not have to arrive as an object property. Two shapes hide
 * inside an *already-serialized* string, which a walk over object keys cannot
 * see into — hence `redactJsonString` below:
 *   - the outbound websocket frame. Every client in this SDK family funnels
 *     sends through `tryWsSend()`, whose catch logs `{ wsMessage, wsKey,
 *     exception }`, and on a private connection `wsMessage` is the auth or
 *     private-subscribe request — a Kraken WS token, a bybit `op:'auth'` triple,
 *     a bitget `op:'login'` payload;
 *   - a REST error `body` / `config.data` the transport handed back as text
 *     rather than as parsed JSON.
 *
 * Those objects then reach `JSON.stringify` in an error log and land in the pm2
 * logs, which are retained for days, gzipped, shipped around and read by agents
 * and log-triage jobs. Redacting at the *serialization* boundary is what makes
 * this safe regardless of which SDK field a future log line happens to print:
 * never `JSON.stringify` an exchange error, an SDK logger's arguments, or
 * anything derived from one — use `safeStringify`.
 */

export const REDACTED = '[REDACTED]'

/** Lowercase, strip separators, so `API-Key`, `api_key` and `APIKey` all collapse. */
const normalize = (key: string): string =>
  key.toLowerCase().replace(/[-_\s]/g, '')

/**
 * Matched as a *suffix* so every vendor prefix is covered by one entry:
 * `OK-ACCESS-KEY`, `KC-API-KEY`, `X-MBX-APIKEY`, `CB-ACCESS-SIGN` and friends
 * all reduce to one of these without needing an exchange-by-exchange list.
 */
const SECRET_SUFFIXES = [
  'apikey',
  'apisign',
  'apisecret',
  'apipass',
  'apipassphrase',
  'accesskey',
  'accesssign',
  'accesspassphrase',
  'privatekey',
  'secretkey',
  'signature',
  'passphrase',
  'password',
  'secret',
  'authorization',
  'cookie',
  'token',
]

/** Bare names that are credentials on their own but too short to suffix-match safely. */
const SECRET_EXACT = new Set([
  'key',
  'sign',
  'auth',
  'wallet', // Hyperliquid: the signer's private key is passed as `wallet`
  'credentials',
])

export const isSecretKey = (key: string): boolean => {
  const k = normalize(key)
  return SECRET_EXACT.has(k) || SECRET_SUFFIXES.some((s) => k.endsWith(s))
}

/**
 * Websocket auth operations that pass credentials POSITIONALLY, where there is
 * no property name for `isSecretKey` to match on.
 *
 * bybit-custom builds `{ op: 'auth', args: [key, expiresAt, signature] }` and
 * bitget builds `{ op: 'login', args: [...] }`. Redact the whole argument list
 * of an auth frame rather than trying to guess which slot is the signature.
 * A subscribe/unsubscribe frame is untouched — the topic list is exactly the
 * diagnostic you want when a subscribe fails.
 */
const AUTH_OPERATIONS = new Set(['auth', 'login', 'access'])
const AUTH_ARG_KEYS = new Set(['args', 'params'])

const isAuthFrame = (val: object): boolean => {
  const op = (val as { op?: unknown }).op
  return typeof op === 'string' && AUTH_OPERATIONS.has(op.toLowerCase())
}

/** Above this a string is not a frame we serialized; don't spend the parse. */
const MAX_EMBEDDED_JSON_CHARS = 20_000

/**
 * Deep-copy `value` with every credential-shaped property replaced by
 * `[REDACTED]`. Cycle-safe and depth-limited so a stray axios/socket object
 * can't hang or blow the stack on the logging path.
 */
export const redactSecrets = (value: unknown, maxDepth = 6): unknown => {
  const seen = new WeakSet<object>()

  /**
   * A string that is itself a serialized JSON object gets parsed, redacted and
   * re-serialized — this is how a `wsMessage` frame or a text REST body gets
   * cleaned. Anything that is not parseable JSON comes back untouched, so
   * ordinary log text is never mangled.
   */
  const redactJsonString = (val: string, depth: number): string => {
    const trimmed = val.trim()
    if (trimmed.length > MAX_EMBEDDED_JSON_CHARS) return val
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return val
    try {
      const cleaned = JSON.stringify(walk(JSON.parse(trimmed), depth))
      return cleaned ?? val
    } catch {
      return val
    }
  }

  const walk = (val: unknown, depth: number): unknown => {
    if (typeof val === 'string') return redactJsonString(val, depth + 1)
    if (val === null || typeof val !== 'object') return val
    if (depth > maxDepth) return '[Truncated]'
    if (seen.has(val)) return '[Circular]'
    seen.add(val)

    if (Array.isArray(val)) return val.map((v) => walk(v, depth + 1))

    const authFrame = isAuthFrame(val)

    const out: Record<string, unknown> = {}
    // Error's `name`/`message` are non-enumerable, so a plain key walk turns a
    // real Error into `{}` — the exact reason a fallback `JSON.stringify(e)`
    // reads as empty in the logs today.
    if (val instanceof Error) {
      out.name = val.name
      out.message = val.message
    }
    for (const [k, v] of Object.entries(val)) {
      out[k] =
        isSecretKey(k) || (authFrame && AUTH_ARG_KEYS.has(k.toLowerCase()))
          ? REDACTED
          : walk(v, depth + 1)
    }
    return out
  }

  return walk(value, 0)
}

/** `JSON.stringify` with credentials stripped. Never throws. */
export const safeStringify = (value: unknown, maxDepth = 6): string => {
  try {
    return JSON.stringify(redactSecrets(value, maxDepth)) ?? String(value)
  } catch {
    return String(value)
  }
}
