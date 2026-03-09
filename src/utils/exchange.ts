import {
  APIResponseV3WithTime,
  RestClientV5 as BybitRESTClient,
  CategoryV5,
  InstrumentInfoResponseV5,
} from 'bybit-api'
import { ExchangeEnum } from './common'
import {
  Instrument,
  InstrumentType,
  RestClient as OKXRESTClient,
} from 'okx-api'
import axios from 'axios'
import logger from '../utils/logger'
import { OKXEnv, exchangeUrl } from './env'
import KucoinApi from '@gainium/kucoin-api'
import { convertSymbol } from './kucoin'
import Coinbase from 'coinbase-advanced-node'
import { RestClientV2 as BitgetClient } from 'bitget-api'
import {
  SpotClient as KrakenSpotClient,
  DerivativesClient as KrakenDerivativesClient,
} from '@siebly/kraken-api'

export type ExchangeInfo = {
  baseAsset: {
    minAmount: number
    maxAmount: number
    step: number
    name: string
    maxMarketAmount: number
  }
  quoteAsset: {
    minAmount: number
    name: string
  }
  maxOrders: number
  priceAssetPrecision: number
  priceMultiplier?: {
    up: number
    down: number
    decimals: number
  }
  type?: string
}

export enum StatusEnum {
  ok = 'OK',
  notok = 'NOTOK',
}

export type ReturnGood<T> = {
  status: StatusEnum.ok
  data: T
  reason?: null
}

export type ReturnBad = {
  status: StatusEnum.notok
  data: null
  reason: string
}

export type BaseReturn<T = any> = ReturnGood<T> | ReturnBad

export type SpotExchangeInfo = {
  symbol: string
  baseCoin: string
  quoteCoin: string
  minTradeAmount: string
  maxTradeAmount: string
  takerFeeRate: string
  makerFeeRate: string
  pricePrecision: string
  quantityPrecision: string
  quotePrecision: string
  minTradeUSDT: string
  status: string
  buyLimitPriceRatio: string
  sellLimitPriceRatio: string
  orderQuantity: string
  areaSymbol: string
}

export type FuturesContractConfig = {
  symbol: string
  baseCoin: string
  quoteCoin: string
  buyLimitPriceRatio: string
  sellLimitPriceRatio: string
  feeRateUpRatio: string
  makerFeeRate: string
  takerFeeRate: string
  openCostUpRatio: string
  supportMarginCoins: string[]
  minTradeNum: string
  priceEndStep: string
  volumePlace: string
  pricePlace: string
  sizeMultiplier: string
  symbolType: string
  minTradeUSDT: string
  maxSymbolOrderNum: string
  maxProductOrderNum: string
  maxPositionNum: string
  symbolStatus: string
  offTime: string
  limitOpenTime: string
  deliveryTime: string
  deliveryStartTime: string
  launchTime: string
  fundInterval: string
  minLever: string
  maxLever: string
  posLimit: string
  maintainTime: string
}

const getAllExchangeInfo = async (
  exchange: ExchangeEnum,
): Promise<string[]> => {
  const url = exchangeUrl()
  if (
    url &&
    exchange !== ExchangeEnum.kraken &&
    exchange !== ExchangeEnum.krakenUsdm
  ) {
    const data = await axios
      .get<BaseReturn<(ExchangeInfo & { pair: string })[]>>(
        `${url}/exchange/all?exchange=${exchange}`,
      )
      .then((r) => r.data)
      .catch((e) => {
        logger.error(`Cannot get exchange info for ${exchange} ${e}`)
        return {
          status: StatusEnum.notok,
          reason: 'Cannot get exchange info',
          data: null,
        } as ReturnBad
      })
    if (data.status === StatusEnum.ok) {
      return data.data.map((s) => s.pair)
    }
  }
  if (exchange === ExchangeEnum.coinbase) {
    try {
      const coinbaseClient = new Coinbase({
        cloudApiKeyName: process.env.COINBASE_API_KEY,
        cloudApiSecret: process.env.COINBASE_API_SECRET,
      })
      const data =
        (await coinbaseClient.rest.product.getProducts()).map(
          (p) => p.product_id,
        ) ?? []
      return data
    } catch (e) {
      logger.error('Coinbase error', e)
      return []
    }
  }
  if (
    [
      ExchangeEnum.bybit,
      ExchangeEnum.bybitCoinm,
      ExchangeEnum.bybitUsdm,
    ].includes(exchange)
  ) {
    const rest = new BybitRESTClient({})
    const categoryV5: CategoryV5 =
      exchange === ExchangeEnum.bybit
        ? 'spot'
        : exchange === ExchangeEnum.bybitUsdm
          ? 'linear'
          : 'inverse'
    const markets: APIResponseV3WithTime<
      InstrumentInfoResponseV5<typeof categoryV5>
    > | null = await rest
      .getInstrumentsInfo<typeof categoryV5>({ category: categoryV5 })
      .catch(() => {
        logger.warn('Failed to get bybit markets')
        return null
      })
    const allMarkets = new Set<string>()
    ;(markets?.result.list ?? []).forEach((m) => {
      allMarkets.add(m.symbol)
    })
    if (markets?.result.nextPageCursor) {
      let cursor: string | null = markets.result.nextPageCursor
      while (cursor) {
        const nextMarkets: APIResponseV3WithTime<
          InstrumentInfoResponseV5<typeof categoryV5>
        > | null = await rest
          .getInstrumentsInfo<typeof categoryV5>({
            category: categoryV5,
            cursor,
          })
          .catch(() => {
            logger.warn('Failed to get bybit markets')
            return null
          })

        ;(nextMarkets?.result.list ?? []).forEach((m) => {
          allMarkets.add(m.symbol)
        })

        cursor = nextMarkets?.result.nextPageCursor || null
      }
    }
    return [...allMarkets]
  }
  if (
    [
      ExchangeEnum.bitget,
      ExchangeEnum.bitgetCoinm,
      ExchangeEnum.bitgetUsdm,
    ].includes(exchange)
  ) {
    const rest = new BitgetClient({})
    if (exchange === ExchangeEnum.bitget) {
      return await rest
        .getSpotSymbolInfo()
        .then((res) =>
          (res.data as SpotExchangeInfo[])
            .filter((d) => d.status === 'online')
            .map((d) => d.symbol),
        )
        .catch((e) => {
          logger.warn('Failed to get bitget coinm markets', e)
          return []
        })
    }
    if (exchange === ExchangeEnum.bitgetCoinm) {
      return await rest
        .getFuturesContractConfig({
          productType: 'COIN-FUTURES',
        })
        .then((res) =>
          (res.data as FuturesContractConfig[])
            .filter((d) => d.symbolStatus === 'normal')
            .map((d) => d.symbol),
        )
        .catch((e) => {
          logger.warn('Failed to get bitget coinm markets', e)
          return []
        })
    }
    if (exchange === ExchangeEnum.bitgetUsdm) {
      return await Promise.all(
        (['USDT-FUTURES', 'USDC-FUTURES'] as const).map(async (productType) => {
          return await rest
            .getFuturesContractConfig({
              productType,
            })
            .then((res) =>
              (res.data as FuturesContractConfig[])
                .filter((d) => d.symbolStatus === 'normal')
                .map((d) => d.symbol),
            )
            .catch((e) => {
              logger.warn('Failed to get bitget coinm markets', e)
              return []
            })
        }),
      ).then((res) => res.flat())
    }
  }
  if (
    [
      ExchangeEnum.okx,
      ExchangeEnum.okxInverse,
      ExchangeEnum.okxLinear,
    ].includes(exchange)
  ) {
    const rest = new OKXRESTClient(undefined, OKXEnv())
    const type: InstrumentType = exchange === ExchangeEnum.okx ? 'SPOT' : 'SWAP'
    const markets = await rest.getInstruments({ instType: type }).catch(() => {
      logger.warn('Failed to get okx  markets')
      return [] as Instrument[]
    })
    return markets
      .filter((m) =>
        exchange === ExchangeEnum.okx
          ? true
          : exchange === ExchangeEnum.okxInverse
            ? m.ctType === 'inverse'
            : m.ctType === 'linear',
      )
      .map((m) => m.instId)
  }
  if (
    [ExchangeEnum.kucoinInverse, ExchangeEnum.kucoinLinear].includes(exchange)
  ) {
    const kucoinClient = new KucoinApi()
    const data = await kucoinClient.getFuturesSymbols()
    if (data.status === StatusEnum.ok) {
      return (data.data ?? [])
        .filter(
          (s) => (exchange === ExchangeEnum.kucoinInverse) === s.isInverse,
        )
        .map((s) => convertSymbol(s.symbol))
    }
  }
  if (
    exchange === ExchangeEnum.kraken ||
    exchange === ExchangeEnum.krakenUsdm
  ) {
    const maps = await getKrakenSymbolMaps(exchange)
    return [...maps.normalizedToWsname.keys()]
  }
  return []
}

export type KrakenSymbolMap = {
  wsnameToNormalized: Map<string, string>
  normalizedToWsname: Map<string, string>
  assetNameMap: Map<string, string>
}
const krakenMaps: {
  spot?: KrakenSymbolMap
  usdm?: KrakenSymbolMap
  coinm?: KrakenSymbolMap
} = {}

export const resetKrakenMaps = () => {
  krakenMaps.spot = undefined
  krakenMaps.usdm = undefined
  krakenMaps.coinm = undefined
}

export const getKrakenSymbolMaps = async (
  exchange: ExchangeEnum.kraken | ExchangeEnum.krakenUsdm,
): Promise<KrakenSymbolMap> => {
  if (exchange === ExchangeEnum.kraken && krakenMaps.spot) {
    return krakenMaps.spot
  }
  if (exchange === ExchangeEnum.krakenUsdm && krakenMaps.usdm) {
    return krakenMaps.usdm
  }
  const maps: KrakenSymbolMap = {
    wsnameToNormalized: new Map(),
    normalizedToWsname: new Map(),
    assetNameMap: new Map(),
  }
  const krakenClient = new KrakenSpotClient({})
  const realAssets = await krakenClient.getAssetInfo()
  ;(realAssets.result ? Object.entries(realAssets.result) : []).forEach(
    ([name, info]) => {
      maps.assetNameMap.set(name, info.altname)
      if (info.altname === 'XBT') {
        maps.assetNameMap.set(name, 'BTC')
        maps.assetNameMap.set('XBT', 'BTC')
      }
      if (info.altname === 'XDG') {
        maps.assetNameMap.set(name, 'DOGE')
        maps.assetNameMap.set('XDG', 'DOGE')
      }
    },
  )
  maps.assetNameMap.set('XBT', 'BTC')
  maps.assetNameMap.set('XDG', 'DOGE')
  if (exchange === ExchangeEnum.kraken) {
    try {
      const result = await krakenClient.getAssetPairs()
      if (result.result) {
        Object.entries(result.result).forEach(([_symbol, pair]) => {
          const base = pair.base
          const quote = pair.quote
          let normalizedBase = realAssets.result[base]?.altname || base
          let normalizedQuote = realAssets.result[quote]?.altname || quote
          if (normalizedBase === 'XBT') {
            normalizedBase = 'BTC'
          }
          if (normalizedQuote === 'XBT') {
            normalizedQuote = 'BTC'
          }
          if (normalizedQuote === 'XDG') {
            normalizedQuote = 'DOGE'
          }
          if (normalizedBase === 'XDG') {
            normalizedBase = 'DOGE'
          }
          const pairName = `${normalizedBase}-${normalizedQuote}` // e.g. BTC/USD

          const wsname = (pair.wsname || pairName)
            ?.replace('/XBT', '/BTC')
            .replace(new RegExp('^XBT\/'), 'BTC/')
            .replace('/XDG', '/DOGE')
            .replace(new RegExp('^XDG\/'), 'DOGE/')
          const normalized = pairName
          maps.wsnameToNormalized.set(wsname, normalized)
          maps.normalizedToWsname.set(normalized, wsname)
        })
      }
    } catch (e) {
      logger.error('Failed to get kraken spot symbol maps', e)
    }
  } else if (exchange === ExchangeEnum.krakenUsdm) {
    const isDemo = process.env.KRAKEN_ENV === 'demo'
    const krakenClient = new KrakenDerivativesClient(
      isDemo ? { testnet: true } : {},
    )
    try {
      const result = await krakenClient.getInstruments()
      if (result.result === 'success' && result.instruments) {
        // Filter by symbol prefix: PF_ for usdm, PI_ for coinm
        const symbolPrefix = exchange === ExchangeEnum.krakenUsdm ? 'PF' : 'PI'
        result.instruments
          .filter(
            (instrument) =>
              instrument.tradeable &&
              instrument.symbol.startsWith(symbolPrefix),
          )
          .forEach((instrument) => {
            const wsname = instrument.symbol // e.g. BTC-USD
            const normalized = `${instrument.base}-${instrument.quote}` // Futures symbols don't have /
            if (wsname) {
              maps.wsnameToNormalized.set(wsname, normalized)
              maps.normalizedToWsname.set(normalized, wsname)
            }
          })
      }
    } catch (e) {
      logger.error(
        `Failed to get kraken ${exchange === ExchangeEnum.krakenUsdm ? 'usdm' : 'coinm'} symbol maps`,
        e,
      )
    }
  }

  if (exchange === ExchangeEnum.kraken) {
    krakenMaps.spot = maps
  } else if (exchange === ExchangeEnum.krakenUsdm) {
    krakenMaps.usdm = maps
  }
  return maps
}

export type KucoinSymbol = { symbol: string; asset: string }

export const getKucoinSymbolsByMarket = async () => {
  const url = exchangeUrl()
  let result: {
    coinm: KucoinSymbol[]
    usdm: KucoinSymbol[]
  } = { coinm: [], usdm: [] }
  if (url) {
    for (const exchange of [
      ExchangeEnum.kucoinInverse,
      ExchangeEnum.kucoinLinear,
    ]) {
      const data = await axios
        .get<BaseReturn<(ExchangeInfo & { pair: string })[]>>(
          `${url}/exchange/all?exchange=${exchange}`,
        )
        .then((r) => r.data)
        .catch((e) => {
          logger.error(`Cannot get exchange info for ${exchange} ${e}`)
          return {
            status: StatusEnum.notok,
            reason: 'Cannot get exchange info',
            data: null,
          } as ReturnBad
        })
      if (data.status === StatusEnum.ok) {
        data.data.forEach((s) => {
          if (exchange === ExchangeEnum.kucoinInverse) {
            result.coinm.push({ symbol: s.pair, asset: s.baseAsset.name })
          } else {
            result.usdm.push({ symbol: s.pair, asset: s.quoteAsset.name })
          }
        })
      }
    }
  }
  if (result.coinm.length && result.usdm.length) {
    return result
  }
  const kucoinClient = new KucoinApi()
  const data = await kucoinClient.getFuturesSymbols()
  if (data.status === StatusEnum.ok) {
    result = (data.data ?? []).reduce(
      (acc, s) => {
        if (s.isInverse) {
          acc.coinm.push({
            symbol: convertSymbol(s.symbol),
            asset: convertSymbol(s.baseCurrency),
          })
        } else {
          acc.usdm.push({
            symbol: convertSymbol(s.symbol),
            asset: convertSymbol(s.quoteCurrency),
          })
        }
        return acc
      },
      { coinm: [], usdm: [] } as {
        coinm: KucoinSymbol[]
        usdm: KucoinSymbol[]
      },
    )
  }
  return result
}

export default getAllExchangeInfo
