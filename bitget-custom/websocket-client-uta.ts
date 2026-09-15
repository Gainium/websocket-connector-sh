import WebSocket from 'isomorphic-ws'

import { BaseWebsocketClient } from './BaseWSClient'

/**
 * Private WebSocket for a Bitget Unified Trading Account (v3).
 *
 * A unified account's orders and balances are only published here — the
 * classic v2 private channels never see them. Login and heartbeat are the same
 * as v2 (HMAC over `timestamp + GET + /user/verify`, string `ping`/`pong`), so
 * the vendored base drives it; only the URL and the subscribe shape differ:
 * `{ instType: 'UTA', topic: 'order' | 'account' | 'position' | 'fill' }`.
 */
export type BitgetUtaTopic = 'order' | 'account' | 'position' | 'fill'

export type BitgetUtaSubscribeArgs = { instType: 'UTA'; topic: BitgetUtaTopic }

export const BITGET_UTA_PRIVATE_WS_KEY = 'v3Private'

type UtaWsKey = typeof BITGET_UTA_PRIVATE_WS_KEY

export class WebsocketClientUta extends BaseWebsocketClient<
  UtaWsKey,
  BitgetUtaSubscribeArgs
> {
  protected getWsKeyForTopic(): UtaWsKey {
    return BITGET_UTA_PRIVATE_WS_KEY
  }

  protected isPrivateChannel(): boolean {
    return true
  }

  protected shouldAuthOnConnect(): boolean {
    return true
  }

  protected getWsUrl(): string {
    return this.options.wsUrl || 'wss://ws.bitget.com/v3/ws/private'
  }

  protected getMaxTopicsPerSubscribeEvent(): number | null {
    return null
  }

  public connectAll(): Promise<WebSocket | undefined>[] {
    return [this.connect(BITGET_UTA_PRIVATE_WS_KEY)]
  }

  public subscribeTopic(topic: BitgetUtaTopic) {
    return this.subscribe({ instType: 'UTA', topic })
  }
}
