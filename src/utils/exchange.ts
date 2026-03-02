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
  if (exchange === ExchangeEnum.kraken) {
    const krakenClient = new KrakenSpotClient({})
    try {
      const result = await krakenClient.getAssetPairs()
      if (result.result) {
        return Object.entries(result.result)
          .filter(([_symbol, pair]) => {
            // Filter out dark pool pairs, halted pairs, and pairs without wsname
            if (
              !pair.wsname ||
              pair.status !== 'online' ||
              _symbol.endsWith('.d')
            ) {
              return false
            }
            // Filter out XBT pairs (not supported on WebSocket)
            if (pair.wsname.includes('/XBT')) {
              return false
            }
            return true
          })
          .map(([_symbol, pair]) => {
            // Normalize: BTC/USD -> BTCUSD
            return pair.wsname!.replace('/', '')
          })
      }
    } catch (e) {
      logger.error('Failed to get kraken spot markets', e)
      return []
    }
  }
  if (exchange === ExchangeEnum.krakenUsdm) {
    const isDemo = process.env.KRAKEN_ENV === 'demo'
    const krakenClient = new KrakenDerivativesClient(
      isDemo ? { testnet: true } : {},
    )
    try {
      const result = await krakenClient.getInstruments()
      if (result.result === 'success' && result.instruments) {
        return result.instruments
          .filter((instrument) => instrument.tradeable)
          .map((instrument) => instrument.symbol)
      }
    } catch (e) {
      logger.error('Failed to get kraken futures markets', e)
      return []
    }
  }
  return []
}

export type KrakenSymbolMap = {
  wsnameToNormalized: Map<string, string>
  normalizedToWsname: Map<string, string>
}

export const getKrakenSymbolMaps = async (
  exchange: ExchangeEnum.kraken | ExchangeEnum.krakenUsdm,
): Promise<KrakenSymbolMap> => {
  const maps: KrakenSymbolMap = {
    wsnameToNormalized: new Map(),
    normalizedToWsname: new Map(),
  }

  if (exchange === ExchangeEnum.kraken) {
    const krakenClient = new KrakenSpotClient({})
    try {
      const result = await krakenClient.getAssetPairs()
      if (result.result) {
        Object.entries(result.result).forEach(([_symbol, pair]) => {
          // Filter out dark pool pairs, halted pairs, and pairs without wsname
          if (
            !pair.wsname ||
            pair.status !== 'online' ||
            _symbol.endsWith('.d')
          ) {
            return
          }
          // Filter out XBT pairs (not supported on WebSocket)
          if (pair.wsname.includes('/XBT')) {
            return
          }

          const wsname = pair.wsname
          const normalized = wsname.replace('/', '') // BTC/USD -> BTCUSD
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
        result.instruments
          .filter((instrument) => instrument.tradeable)
          .forEach((instrument) => {
            const wsname = `${instrument.base}-${instrument.quote}` // e.g. BTC-USD
            const normalized = wsname // Futures symbols don't have /
            maps.wsnameToNormalized.set(wsname, normalized)
            maps.normalizedToWsname.set(normalized, wsname)
          })
      }
    } catch (e) {
      logger.error('Failed to get kraken futures symbol maps', e)
    }
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
