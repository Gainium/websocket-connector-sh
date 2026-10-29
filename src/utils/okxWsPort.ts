import { WS_BASE_URL_MAP } from 'okx-api/lib/util/websocket-util'

/**
 * OKX stops accepting WebSocket connections on port 8443 after 31 Oct 2026
 * (ws.okx.com, wseea.okx.com, wsus.okx.com). Host and path stay the same and
 * the default port 443 already serves every endpoint, including the demo
 * host wspap.okx.com.
 *
 * okx-api 2.x hardcodes `:8443` in `WS_BASE_URL_MAP`, which every OKX client
 * here falls back to when no `wsUrl` is passed: the global and demo user
 * streams, and the price and candle sockets (okx-custom). The map is read at
 * connect time, so rewriting it once on import moves all of them to 443.
 * okx-api 3.x ships the same URLs without the port.
 */
export const stripOkxWsPort = (url: string) => url.replace(':8443/', '/')

export const OKX_EEA_PRIVATE_WS_URL = 'wss://wseea.okx.com/ws/v5/private'
export const OKX_US_PRIVATE_WS_URL = 'wss://wsus.okx.com/ws/v5/private'

const urlMap = WS_BASE_URL_MAP as Record<string, Record<string, string>>
for (const env of Object.values(urlMap)) {
  for (const key of Object.keys(env)) {
    env[key] = stripOkxWsPort(env[key])
  }
}
