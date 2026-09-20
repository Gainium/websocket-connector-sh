import WebSocket from 'isomorphic-ws'

import { BaseWebsocketClient } from './BaseWSClient'

/**
 * Bitget's v3 public WebSocket. Used where v2 is silent:
 *
 * - Reality stock token (rAAPL…) candles are accepted on the v2 `candle*`
 *   channels and never pushed there, while the v3 `kline` topic pushes them.
 * - The inverse perpetuals moved to the unified line entirely, so v2 quotes
 *   neither their tickers nor their candles.
 *
 * Heartbeat is the same string `ping`/`pong` as v2; subscribe args are
 * `{ instType, topic, symbol }` plus `interval` for `kline`.
 */
export type BitgetV3InstType = 'spot' | 'coin-futures'

export type BitgetV3KlineArgs = {
  instType: BitgetV3InstType
  topic: 'kline'
  symbol: string
  interval: string
}

export type BitgetV3TickerArgs = {
  instType: BitgetV3InstType
  topic: 'ticker'
  symbol: string
}

export type BitgetV3PublicArgs = BitgetV3KlineArgs | BitgetV3TickerArgs

export const BITGET_V3_PUBLIC_WS_KEY = 'v3Public'

type V3PublicWsKey = typeof BITGET_V3_PUBLIC_WS_KEY

export class WebsocketClientV3Public extends BaseWebsocketClient<
  V3PublicWsKey,
  BitgetV3PublicArgs
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
