import WebSocket from 'isomorphic-ws'

import { BaseWebsocketClient } from './BaseWSClient'

/**
 * Bitget's v3 public WebSocket. Used only where v2 is silent: Reality stock
 * token (rAAPL…) candles are accepted on the v2 `candle*` channels but never
 * pushed there, while the v3 `kline` topic pushes them. Heartbeat is the same
 * string `ping`/`pong` as v2; subscribe args are
 * `{ instType: 'spot', topic: 'kline', symbol, interval }`.
 */
export type BitgetV3KlineArgs = {
  instType: 'spot'
  topic: 'kline'
  symbol: string
  interval: string
}

export const BITGET_V3_PUBLIC_WS_KEY = 'v3Public'

type V3PublicWsKey = typeof BITGET_V3_PUBLIC_WS_KEY

export class WebsocketClientV3Public extends BaseWebsocketClient<
  V3PublicWsKey,
  BitgetV3KlineArgs
> {
  protected getWsKeyForTopic(): V3PublicWsKey {
    return BITGET_V3_PUBLIC_WS_KEY
  }

  protected isPrivateChannel(): boolean {
    return false
  }

  protected shouldAuthOnConnect(): boolean {
    return false
  }

  protected getWsUrl(): string {
    return this.options.wsUrl || 'wss://ws.bitget.com/v3/ws/public'
  }

  protected getMaxTopicsPerSubscribeEvent(): number | null {
    return null
  }

  public connectAll(): Promise<WebSocket | undefined>[] {
    return [this.connect(BITGET_V3_PUBLIC_WS_KEY)]
  }
}
