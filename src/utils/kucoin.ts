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
