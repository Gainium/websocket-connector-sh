const convertXBTtoBTC = (symbol: string) => {
  return symbol.replace(/^XBT/, 'BTC')
}

const convertBTCtoXBT = (symbol: string) => {
  return symbol.replace(/^BTC/, 'XBT')
}

const convertQuoteAssetToUsd = (symbol: string) => {
  return symbol
    .replace(/USDTM$/, 'USDT')
    .replace(/USDCM$/, 'USDC')
    .replace(/USDM$/, 'USD')
}

const convertQuoteAssetToKucoin = (symbol: string) => {
  return symbol
    .replace(/USDT$/, 'USDTM')
    .replace(/USDC$/, 'USDCM')
    .replace(/USD$/, 'USDM')
}

export const convertSymbol = (symbol: string) => {
  return convertXBTtoBTC(convertQuoteAssetToUsd(symbol))
}

export const convertSymbolToKucoin = (symbol: string) => {
  return convertBTCtoXBT(convertQuoteAssetToKucoin(symbol))
}

const intervalMap: Record<string, string> = {
  '1m': '1min',
  '3m': '3min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '1hour',
  '2h': '2hour',
  '4h': '4hour',
  '6h': '6hour',
  '8h': '8hour',
  '12h': '12hour',
  '1d': '1day',
  '1w': '1week',
  '1M': '1month',
}

/**
 * Best-effort conversion of a canonical (binance-style) interval to kucoin
 * format. If the input is already in kucoin format (or anything else
 * unrecognized) it is passed through unchanged so callers that already
 * converted upstream still work.
 */
export const convertIntervalToKucoin = (interval: string): string => {
  return intervalMap[interval] ?? interval
}
