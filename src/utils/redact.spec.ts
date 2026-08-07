process.env.NODE_ENV = 'testing'

/**
 * Unit-level check for `utils/redact.ts` — the credential redaction that every
 * exchange error log now goes through.
 *
 * SHARED SPEC — kept byte-identical in exchange-connector core and
 * websocket-connector core, alongside the module it covers. Both services drive
 * the same SDKs, so both need to prove they handle the same shapes.
 *
 * Those shapes are the real ones the SDKs throw and log (see `redact.ts` for the
 * `@siebly/kraken-api` call chain, the `bybit-custom` / `bitget-custom`
 * `parseException`s, and the `tryWsSend` frame logging), reconstructed with
 * SYNTHETIC key material. Never paste real credentials in here — this file is
 * committed to a public repo, and the whole point of the module under test is
 * that key material does not get written down.
 *
 * Run: npx ts-node --files --project tsconfig.json src/utils/redact.spec.ts
 *
 * No network / auth needed — the module is pure.
 */
import { safeStringify, isSecretKey } from './redact'

const FAKE_KEY = 'FAKE-KEY-AAAA'
const FAKE_SIGN = 'FAKE-SIGN-BBBB'
const FAKE_SECRET = 'FAKE-SECRET-CCCC'
const FAKE_TOKEN = 'FAKE-WS-TOKEN-DDDD'
const FAKE_PASS = 'FAKE-PASSPHRASE-EEEE'

let failures = 0
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` :: ${detail}` : ''}`,
  )
}

// 1) The Kraken shape, as thrown by parseException() for any rejected private
//    call — an order in the connector, GetWebSocketsToken in the ws connector.
//    Credentials ride inside requestParams.options.headers, right beside the
//    `APIKey` field the SDK does redact.
const krakenError = {
  code: 520,
  message: 'Origin Error',
  body: { error: ['EAPI:Invalid nonce'] },
  requestOptions: { apiKey: 'omittedFromError', apiSecret: 'omittedFromError' },
  requestParams: {
    method: 'POST',
    endpoint: '/0/private/AddOrder',
    options: {
      headers: {
        'API-Key': FAKE_KEY,
        'API-Sign': FAKE_SIGN,
        'Content-Type': 'application/x-www-form-urlencoded',
        APIKey: 'omittedFromError',
      },
    },
  },
}
const kraken = safeStringify(krakenError)
check('kraken: API-Key redacted', !kraken.includes(FAKE_KEY), kraken)
check('kraken: API-Sign redacted', !kraken.includes(FAKE_SIGN))
check(
  'kraken: diagnostics survive',
  kraken.includes('EAPI:Invalid nonce') &&
    kraken.includes('AddOrder') &&
    kraken.includes('x-www-form-urlencoded'),
)

// 2) bybit-custom / bitget-custom: credentials live in requestOptions.
const bybit = safeStringify({
  code: 401,
  body: { retMsg: 'invalid api_key' },
  requestOptions: { key: FAKE_KEY, secret: FAKE_SECRET, recv_window: 5000 },
})
check(
  'bybit: key+secret redacted',
  !bybit.includes(FAKE_KEY) && !bybit.includes(FAKE_SECRET),
  bybit,
)
check('bybit: retMsg survives', bybit.includes('invalid api_key'))

// 3) Credentials inside an ALREADY-SERIALIZED string. `tryWsSend()`'s catch
//    logs the outbound frame as text, and a REST transport can hand back a text
//    body; key-name matching on the enclosing object cannot see into either, so
//    the JSON has to be parsed and re-redacted.

// 3a) Kraken spot private subscribe — carries the live WS auth token.
const krakenFrame = safeStringify({
  wsMessage: JSON.stringify({
    method: 'subscribe',
    params: { channel: 'executions', token: FAKE_TOKEN },
    req_id: 1,
  }),
  wsKey: 'spotPrivateV2',
  exception: new Error('WebSocket is not open: readyState 2 (CLOSING)'),
})
check(
  'embedded json: kraken token redacted',
  !krakenFrame.includes(FAKE_TOKEN),
  krakenFrame,
)
check(
  'embedded json: kraken channel survives',
  krakenFrame.includes('executions') && krakenFrame.includes('subscribe'),
)

// 3b) bybit-custom auth — POSITIONAL args, so there is no property name to
//     match. The whole arg list of an auth frame goes.
const bybitFrame = safeStringify({
  wsMessage: JSON.stringify({
    op: 'auth',
    args: [FAKE_KEY, 1754500000000, FAKE_SIGN],
    req_id: 'v5PrivateTrade-auth',
  }),
  wsKey: 'v5PrivateTrade',
})
check(
  'embedded json: bybit positional auth redacted',
  !bybitFrame.includes(FAKE_KEY) && !bybitFrame.includes(FAKE_SIGN),
  bybitFrame,
)
check('embedded json: bybit op survives', bybitFrame.includes('auth'))

// 3c) bitget login — keyed, but nested inside the same serialized string.
const bitgetFrame = safeStringify({
  wsMessage: JSON.stringify({
    op: 'login',
    args: [{ apiKey: FAKE_KEY, passphrase: FAKE_PASS, sign: FAKE_SIGN }],
  }),
})
check(
  'embedded json: bitget login redacted',
  !bitgetFrame.includes(FAKE_KEY) &&
    !bitgetFrame.includes(FAKE_PASS) &&
    !bitgetFrame.includes(FAKE_SIGN),
  bitgetFrame,
)

// 3d) A REST error whose body came back as text rather than parsed JSON.
const textBody = safeStringify({
  code: 401,
  body: JSON.stringify({
    msg: 'Signature verification failed',
    sign: FAKE_SIGN,
  }),
})
check(
  'embedded json: text REST body redacted',
  !textBody.includes(FAKE_SIGN),
  textBody,
)
check(
  'embedded json: text REST body msg survives',
  textBody.includes('Signature verification failed'),
)

// 3e) A subscribe frame is NOT an auth frame — its topic list must survive,
//     because "which subscribe failed" is the whole reason we log it.
const subscribeFrame = safeStringify({
  wsMessage: JSON.stringify({
    op: 'subscribe',
    args: [{ instType: 'SPOT', channel: 'orders', instId: 'BTCUSDT' }],
  }),
})
check(
  'embedded json: subscribe args survive',
  subscribeFrame.includes('BTCUSDT') && subscribeFrame.includes('orders'),
  subscribeFrame,
)

// 3f) Ordinary log text that merely starts with a brace must come back intact.
const plain = safeStringify('{not really json at all')
check(
  'embedded json: non-JSON string untouched',
  plain === '"{not really json at all"',
  plain,
)

// 4) Suffix matching must cover every vendor's header prefix without a list.
for (const header of [
  'OK-ACCESS-KEY',
  'OK-ACCESS-SIGN',
  'OK-ACCESS-PASSPHRASE',
  'KC-API-KEY',
  'KC-API-SIGN',
  'KC-API-PASSPHRASE',
  'CB-ACCESS-KEY',
  'ACCESS-PASSPHRASE',
  'X-MBX-APIKEY',
  'api_key',
  'apiSecret',
  'Authorization',
  'privateKey',
  'wallet',
  'token',
  'sign',
  'key',
  'secret',
]) {
  check(`secret key: ${header}`, isSecretKey(header))
}

// 5) Ordinary diagnostic fields must NOT be redacted — a log that hides the
//    symbol and side to protect a key is a bad trade.
for (const field of [
  'symbol',
  'side',
  'price',
  'quantity',
  'endpoint',
  'status',
  'nonce',
  'wsKey',
  'channel',
  'interval',
]) {
  check(`kept: ${field}`, !isSecretKey(field))
}

// 6) The logging path must never throw or hang on a hostile object.
const cyclic: Record<string, unknown> = { a: 1 }
cyclic.self = cyclic
check(
  'cycle safe',
  safeStringify(cyclic).includes('[Circular]'),
  safeStringify(cyclic),
)
check(
  'Error keeps name + message',
  safeStringify(new TypeError('boom')) ===
    '{"name":"TypeError","message":"boom"}',
  safeStringify(new TypeError('boom')),
)
const deep = {
  l1: { l2: { l3: { l4: { l5: { l6: { l7: { secret: FAKE_SECRET } } } } } } },
}
check(
  'depth limit does not leak',
  !safeStringify(deep).includes(FAKE_SECRET),
  safeStringify(deep),
)
check(
  'null / undefined',
  safeStringify(null) === 'null' && safeStringify(undefined) === 'undefined',
)

// 7) An error re-wrapped so the same object appears twice — spread onto a new
//    envelope AND kept whole under a `originalError`/`cause` field. The ws
//    connector's `requestSubscribeTopics` patch emits exactly this; any retry
//    wrapper can. Both copies have to go.
const rewrapped = safeStringify({
  ...krakenError,
  message: 'EGeneral:Permission denied',
  source: 'requestSubscribeTopics',
  originalError: krakenError,
})
check(
  're-wrapped error: both copies redacted',
  !rewrapped.includes(FAKE_KEY) && !rewrapped.includes(FAKE_SIGN),
  rewrapped,
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
