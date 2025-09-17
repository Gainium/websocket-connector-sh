import { ExchangeEnum } from '../utils/common'

export interface Ticker {
  eventType: string
  eventTime: number
  symbol: string
  curDayClose: string
  bestBid: string
  bestBidQnt: string
  bestAsk: string
  bestAskQnt: string
  open: string
  high: string
  low: string
  volume: string
  volumeQuote: string
}

export interface Candle {
  start: number
  open: string
  high: string
  low: string
  close: string
  volume: string
}

export interface WSTrade {
  e: string
  E: number
  s: string
  k: {
    c: string
    v: string
    o: string
    h: string
    l: string
    i: string
    t: number
  }
}

export type StreamType = 'candle' | 'ticker'

export type SubscribeCandlePayload = {
  symbol: string
  exchange: ExchangeEnum
  interval: string
}

export enum ExchangeIntervals {
  oneM = '1m',
  threeM = '3m',
  fiveM = '5m',
  fifteenM = '15m',
  thirtyM = '30m',
  oneH = '1h',
  twoH = '2h',
  fourH = '4h',
  eightH = '8h',
  oneD = '1d',
  oneW = '1w',
}

export type Market = 'spot' | 'linear' | 'inverse'

export type BinancePayload = {
  isIntl: boolean
  isUs: boolean
}
