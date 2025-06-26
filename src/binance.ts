//@ts-ignore
import type {
  ReconnectingWebSocketHandler,
  MarkPrice,
  Depth,
  PartialDepth,
  Ticker,
  MiniTicker,
  Candle,
  WSTrade,
  AggregatedTrade,
  ForceOrder,
  UserDataStreamEvent,
} from 'binance-api-node'

declare module 'binance-api-node' {
  export interface WebSocket {
    customSubStream: (
      pair: string | string[],
      callback: (data: any) => void,
    ) => ReconnectingWebSocketHandler
    futuresAllMarkPrices: (
      payload: { updateSpeed: '1s' | '3s' },
      callback: (data: MarkPrice[]) => void,
    ) => ReconnectingWebSocketHandler
    futuresCustomSubStream: (
      pair: string | string[],
      callback: (data: any) => void,
    ) => ReconnectingWebSocketHandler
    depth: (
      pair: string | string[],
      callback: (depth: Depth) => void,
      transform?: boolean,
    ) => ReconnectingWebSocketHandler
    futuresDepth: (
      pair: string | string[],
      callback: (depth: Depth) => void,
      transform?: boolean,
    ) => ReconnectingWebSocketHandler
    partialDepth: (
      options:
        | { symbol: string; level: number }
        | { symbol: string; level: number }[],
      callback: (depth: PartialDepth) => void,
      transform?: boolean,
    ) => ReconnectingWebSocketHandler
    futuresPartialDepth: (
      options:
        | { symbol: string; level: number }
        | { symbol: string; level: number }[],
      callback: (depth: PartialDepth) => void,
      transform?: boolean,
    ) => ReconnectingWebSocketHandler
    ticker: (
      pair: string | string[],
      callback: (ticker: Ticker) => void,
    ) => ReconnectingWebSocketHandler
    miniTicker: (
      pair: string | string[],
      callback: (ticker: MiniTicker) => void,
    ) => ReconnectingWebSocketHandler
    allMiniTickers: (
      callback: (ticker: MiniTicker[]) => void,
    ) => ReconnectingWebSocketHandler
    futuresTicker: (
      pair: string | string[],
      callback: (ticker: Ticker) => void,
    ) => ReconnectingWebSocketHandler
    allTickers: (
      callback: (tickers: Ticker[]) => void,
    ) => ReconnectingWebSocketHandler
    futuresAllTickers: (
      callback: (tickers: Ticker[]) => void,
    ) => ReconnectingWebSocketHandler
    deliveryAllTickers: (
      callback: (tickers: Ticker[]) => void,
    ) => ReconnectingWebSocketHandler
    candles: (
      pair: string | string[],
      period: string,
      callback: (ticker: Candle) => void,
    ) => ReconnectingWebSocketHandler
    trades: (
      pairs: string | string[],
      callback: (trade: WSTrade) => void,
    ) => ReconnectingWebSocketHandler
    aggTrades: (
      pairs: string | string[],
      callback: (trade: AggregatedTrade) => void,
    ) => ReconnectingWebSocketHandler
    futuresLiquidations: (
      symbol: string | string[],
      callback: (forecOrder: ForceOrder) => void,
    ) => ReconnectingWebSocketHandler
    futuresAllLiquidations: (
      callback: (forecOrder: ForceOrder) => void,
    ) => ReconnectingWebSocketHandler
    futuresAggTrades: (
      pairs: string | string[],
      callback: (trade: AggregatedTrade) => void,
    ) => ReconnectingWebSocketHandler
    futuresCandles: (
      pair: string | string[],
      period: string,
      callback: (ticker: Candle) => void,
    ) => ReconnectingWebSocketHandler

    user: (
      callback: (msg: UserDataStreamEvent) => void,
    ) => Promise<ReconnectingWebSocketHandler>
    marginUser: (
      callback: (msg: OutboundAccountInfo | ExecutionReport) => void,
    ) => Promise<ReconnectingWebSocketHandler>
    futuresUser: (
      callback: (
        msg:
          | OutboundAccountInfo
          | ExecutionReport
          | AccountUpdate
          | OrderUpdate
          | AccountConfigUpdate
          | MarginCall,
      ) => void,
    ) => Promise<ReconnectingWebSocketHandler>
  }
}
