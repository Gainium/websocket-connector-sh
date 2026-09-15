import {
  DefaultLogger,
  WebsocketAPIClient,
  WebsocketClient,
  WSAPIClientConfigurableOptions,
  WSClientConfigurableOptions,
} from 'binance'
import { withLosslessOrderIds } from './index'

/** The one WS-API connection a spot user data stream is bound to. */
export const BINANCE_WS_API_USER_STREAM_KEY = 'mainWSAPI'

export type BinanceWsApiUserStream = {
  client: WebsocketClient
  /** Initial `userDataStream.subscribe` on the WS-API connection. */
  start: () => Promise<void>
  /** Close the connection and turn any queued SDK resubscribe into a no-op. */
  stop: () => void
}

/**
 * Binance spot user data stream over the WebSocket API (Ed25519 keys).
 *
 * A WS-API user data stream is bound to its connection, so after a transport
 * reconnect Binance delivers nothing until `userDataStream.subscribe` is sent
 * again. The SDK does that itself: `WebsocketAPIClient`'s constructor attaches a
 * REQUIRED `reconnected` listener to the socket client that queues the
 * resubscribe (`handleWSReconnectedEvent`). The user stream used to call
 * `client.removeAllListeners('reconnected')` on this client to silence the SDK's
 * console logging, which removed that listener too: the socket reconnected, the
 * session logged back on, `ws has reconnected` was logged — and no order or
 * balance event ever arrived again until the room was rebuilt (spec 008).
 *
 * `attachEventListeners: false` is the SDK's own switch for the logging-only
 * listeners, so nobody needs to strip listeners from this client any more.
 *
 * `onResubscribed` fires once the SDK's post-reconnect resubscribe has actually
 * been accepted — not on the transport reconnect, which lands ~2s earlier
 * (`resubscribeUserDataStreamDelaySeconds`). A reconcile signalled at the
 * reconnect would read venue state while the stream is still unsubscribed and
 * miss whatever filled in that gap.
 */
export function createBinanceWsApiUserStream(
  options: WSClientConfigurableOptions &
    Partial<WSAPIClientConfigurableOptions>,
  logger: DefaultLogger | undefined,
  onResubscribed: () => void,
): BinanceWsApiUserStream {
  const wsAPI = new WebsocketAPIClient(
    { ...withLosslessOrderIds(options), attachEventListeners: false },
    logger,
  )
  const client = wsAPI.getWSClient()
  let started = false
  let stopped = false
  // Every SDK path — our initial subscribe and its own post-reconnect
  // `tryResubscribeUserDataStream` — goes through this instance method, so this
  // is the one place to learn that a resubscribe landed, and to stop one that
  // was queued before the room was torn down (sending it would re-open the
  // socket the room just closed).
  const sdkSubscribe = wsAPI.subscribeUserDataStream.bind(wsAPI)
  wsAPI.subscribeUserDataStream = async (wsKey, isRefreshingToken) => {
    if (stopped) return undefined
    const result = await sdkSubscribe(wsKey, isRefreshingToken)
    if (started && !stopped) onResubscribed()
    return result
  }
  return {
    client,
    start: async () => {
      await wsAPI.subscribeUserDataStream(BINANCE_WS_API_USER_STREAM_KEY)
      started = true
    },
    stop: () => {
      stopped = true
      client.closeAll(false)
    },
  }
}
