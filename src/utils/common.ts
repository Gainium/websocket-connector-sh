export enum ExchangeEnum {
  binance = 'binance',
  kucoin = 'kucoin',
  ftx = 'ftx',
  bybit = 'bybit',
  binanceUS = 'binanceUS',
  ftxUS = 'ftxUS',
  paperBinance = 'paperBinance',
  paperKucoin = 'paperKucoin',
  paperFtx = 'paperFtx',
  paperBybit = 'paperBybit',
  binanceCoinm = 'binanceCoinm',
  binanceUsdm = 'binanceUsdm',
  paperBinanceCoinm = 'paperBinanceCoinm',
  paperBinanceUsdm = 'paperBinanceUsdm',
  bybitCoinm = 'bybitInverse',
  bybitUsdm = 'bybitLinear',
  paperBybitCoinm = 'paperBybitInverse',
  paperBybitUsdm = 'paperBybitLinear',
  okx = 'okx',
  okxLinear = 'okxLinear',
  okxInverse = 'okxInverse',
  paperOkx = 'paperOkx',
  paperOkxLinear = 'paperOkxLinear',
  paperOkxInverse = 'paperOkxInverse',
  coinbase = 'coinbase',
  paperCoinbase = 'paperCoinbase',
  kucoinLinear = 'kucoinLinear',
  kucoinInverse = 'kucoinInverse',
  paperKucoinLinear = 'paperKucoinLinear',
  paperKucoinInverse = 'paperKucoinInverse',
  bitget = 'bitget',
  bitgetUsdm = 'bitgetUsdm',
  bitgetCoinm = 'bitgetCoinm',
  paperBitget = 'paperBitget',
  paperBitgetUsdm = 'paperBitgetUsdm',
  paperBitgetCoinm = 'paperBitgetCoinm',
  mexc = 'mexc',
  paperMexc = 'paperMexc',
}

export const mapPaperToReal = (exchange: ExchangeEnum, warn = true) => {
  switch (exchange) {
    case ExchangeEnum.paperBinanceCoinm:
      return ExchangeEnum.binanceCoinm
    case ExchangeEnum.paperBinanceUsdm:
      return ExchangeEnum.binanceUsdm
    case ExchangeEnum.paperBinance:
      return ExchangeEnum.binance
    case ExchangeEnum.paperBybit:
      return ExchangeEnum.bybit
    case ExchangeEnum.paperFtx:
      return ExchangeEnum.ftx
    case ExchangeEnum.paperKucoin:
      return ExchangeEnum.kucoin
    case ExchangeEnum.paperBybitCoinm:
      return ExchangeEnum.bybitCoinm
    case ExchangeEnum.paperBybitUsdm:
      return ExchangeEnum.bybitUsdm
    case ExchangeEnum.paperOkx:
      return ExchangeEnum.okx
    case ExchangeEnum.paperOkxInverse:
      return ExchangeEnum.okxInverse
    case ExchangeEnum.paperOkxLinear:
      return ExchangeEnum.okxLinear
    case ExchangeEnum.paperCoinbase:
      return ExchangeEnum.coinbase
    case ExchangeEnum.paperKucoinInverse:
      return ExchangeEnum.kucoinInverse
    case ExchangeEnum.paperKucoinLinear:
      return ExchangeEnum.kucoinLinear
    case ExchangeEnum.paperBitget:
      return ExchangeEnum.bitget
    case ExchangeEnum.paperBitgetUsdm:
      return ExchangeEnum.bitgetUsdm
    case ExchangeEnum.paperBitgetCoinm:
      return ExchangeEnum.bitgetCoinm
    case ExchangeEnum.paperMexc:
      return ExchangeEnum.mexc
    default:
      if (warn) {
        console.warn(new Date(), ` | ${exchange} is not found as paper`)
      }
      return exchange
  }
}

export const wsLoggerOptions = {
  silly: () => null,
  debug: () => null,
  notice: () => null,
  info: () => null,
  warning: () => null,
  error: () => null,
}
