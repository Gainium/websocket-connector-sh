import { WebsocketClient as KrakenWsClient } from '@siebly/kraken-api'
import { ExchangeEnum, mapPaperToReal } from '../utils/common'
import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'
import CommonConnector from './common'
import getAllExchangeInfo, {
  getKrakenSymbolMaps,
  type KrakenSymbolMap,
} from '../utils/exchange'
import sleep from '../utils/sleep'

import type { Ticker, StreamType, SubscribeCandlePayload } from './types'

const mutex = new IdMutex()

const isDemo = process.env.KRAKEN_ENV === 'demo'

const maxSubsPerClient = 200 // Conservative limit for Kraken

const chunkSize = 100 // Symbols per subscription request

type KrakenClient = {
  client: KrakenWsClient
  subs: number
  id: number
}[]

class KrakenConnector extends CommonConnector {
  private krakenSpotClients: KrakenClient = []
  private krakenUsdmClients: KrakenClient = []
  private krakenCoinmClients: KrakenClient = []
  private krakenCandleClient: KrakenWsClient | null = null
  private krakenUsdmCandleClient: KrakenWsClient | null = null
  private krakenCoinmCandleClient: KrakenWsClient | null = null
  private spotSymbolMaps: KrakenSymbolMap = {
    wsnameToNormalized: new Map(),
    normalizedToWsname: new Map(),
    assetNameMap: new Map(),
  }
  private usdmSymbolMaps: KrakenSymbolMap = {
    wsnameToNormalized: new Map(),
    normalizedToWsname: new Map(),
    assetNameMap: new Map(),
  }
  private coinmSymbolMaps: KrakenSymbolMap = {
    wsnameToNormalized: new Map(),
    normalizedToWsname: new Map(),
    assetNameMap: new Map(),
  }

  constructor(
    private subscribedCandlesMap: Map<ExchangeEnum, Set<string>> = new Map(),
  ) {
    super()
    this.mainData = {
      [ExchangeEnum.kraken]: this.base,
      [ExchangeEnum.krakenUsdm]: this.base,
      [ExchangeEnum.krakenCoinm]: this.base,
    }
    logger.info(`Kraken Worker | >🚀 Price <-> Backend stream`)
  }

  private getKrakenClient(
    type: StreamType,
    isFutures: boolean = false,
    current?: KrakenWsClient,
  ) {
    if (current) {
      current.closeAll(true)
      current.removeAllListeners()
    }

    const client = new KrakenWsClient(
      {
        ...(isFutures && isDemo && { testnet: true }),
      },
      {
        trace: () => null,
        info: () => null,
        error: () => null,
      },
    )

    client.on('open', (data) => {
      logger.info(
        `Kraken ${isFutures ? 'futures' : 'spot'} ${type} opened ${data.wsKey}`,
      )
    })

    client.on('reconnected', (data) => {
      logger.info(
        `Kraken ${isFutures ? 'futures' : 'spot'} ${type} reconnected ${data?.wsKey}`,
      )
    })

    client.on('exception', (data) => {
      logger.error(
        `Kraken ${isFutures ? 'futures' : 'spot'} ${type} exception: ${JSON.stringify(data)}`,
      )
    })

    return client
  }

  private convertKrakenTicker(msg: any, exchange: ExchangeEnum): Ticker[] {
    // Kraken ticker format varies between spot and futures
    // Spot: { channel: 'ticker', type: 'snapshot', data: [...] }
    // Futures: { channel: 'ticker', type: 'snapshot', product_ids: [...], tickers: [...] }

    if (!msg.data && !msg.tickers) {
      return []
    }

    const tickers = msg.data || msg.tickers || []
    const symbolMaps =
      exchange === ExchangeEnum.kraken
        ? this.spotSymbolMaps
        : exchange === ExchangeEnum.krakenUsdm
          ? this.usdmSymbolMaps
          : this.coinmSymbolMaps

    return tickers.map((ticker: any) => {
      const wsname = ticker.symbol || ticker.product_id || ''
      // Convert wsname to normalized symbol (BTC/USD -> BTCUSD)
      const symbol = symbolMaps.wsnameToNormalized.get(wsname) || wsname

      return {
        eventType: '24hrTicker',
        eventTime: ticker.timestamp ? +new Date(ticker.timestamp) : Date.now(),
        symbol,
        curDayClose: ticker.last || ticker.last_price || '0',
        bestBid: ticker.bid || ticker.best_bid || ticker.last || '0',
        bestBidQnt: ticker.bid_qty || ticker.bid_size || '0',
        bestAsk: ticker.ask || ticker.best_ask || ticker.last || '0',
        bestAskQnt: ticker.ask_qty || ticker.ask_size || '0',
        open: ticker.open || ticker.open_24h || '0',
        high: ticker.high || ticker.high_24h || '0',
        low: ticker.low || ticker.low_24h || '0',
        volume: ticker.volume || ticker.volume_24h || '0',
        volumeQuote: ticker.volumeQuote || ticker.volume_quote || '0',
      }
    })
  }

  private krakenTickerCb(exchange: ExchangeEnum) {
    return (msg: any) => {
      if (
        msg.channel === 'ticker' &&
        (msg.type === 'snapshot' || msg.type === 'update')
      ) {
        const tickers = this.convertKrakenTicker(msg, exchange)
        if (tickers.length) {
          this.cbWs(tickers, exchange)
        }
      } else if (msg.feed === 'ticker') {
        if (
          !(msg?.product_id ?? '').startsWith('PI') &&
          !(msg?.product_id ?? '').startsWith('PF')
        ) {
          return
        }
        const symbolMaps =
          exchange === ExchangeEnum.kraken
            ? this.spotSymbolMaps
            : exchange === ExchangeEnum.krakenUsdm
              ? this.usdmSymbolMaps
              : this.coinmSymbolMaps
        this.cbWs(
          [
            {
              eventType: '24hrTicker',
              eventTime: msg.time ? +new Date(msg.time) : Date.now(),
              symbol:
                symbolMaps.wsnameToNormalized.get(msg.product_id) ||
                msg.product_id ||
                '',
              curDayClose: msg.last,
              bestBid: msg.bid,
              bestBidQnt: msg.bid_size,
              bestAsk: msg.ask,
              bestAskQnt: msg.ask_size,
              open: msg.last,
              high: msg.high,
              low: msg.low,
              volume: msg.volume,
              volumeQuote: msg.volumeQuote,
            },
          ],
          exchange,
        )
      }
    }
  }

  private krakenCandleCb(exchange: ExchangeEnum) {
    return (msg: any) => {
      const symbolMaps =
        exchange === ExchangeEnum.kraken
          ? this.spotSymbolMaps
          : exchange === ExchangeEnum.krakenUsdm
            ? this.usdmSymbolMaps
            : this.coinmSymbolMaps

      // Spot OHLC format: { channel: 'ohlc', data: [...] }
      if (msg.channel === 'ohlc' && msg.data) {
        for (const candle of msg.data) {
          const wsname = candle.symbol
          // Convert wsname to normalized symbol
          const symbol = symbolMaps.wsnameToNormalized.get(wsname) || wsname

          this.cbWsTrade(
            {
              e: 'kline',
              E: Date.now(),
              s: symbol,
              k: {
                o: candle.open || '0',
                h: candle.high || '0',
                l: candle.low || '0',
                c: candle.close || '0',
                v: candle.volume || '0',
                i: candle.interval || msg.interval || '1m',
                t: candle.timestamp ? +new Date(candle.timestamp) : Date.now(),
              },
            },
            exchange,
          )
        }
      }
      // Futures candles_trade format: { feed: 'candles_trade_1m', candle: {...} }
      else if (msg.feed?.startsWith('candles_trade_') && msg.candle) {
        const { time, open, high, low, close, volume } = msg.candle
        const product_id = msg.product_id || ''
        // Convert product_id to normalized symbol
        const symbol =
          symbolMaps.wsnameToNormalized.get(product_id) || product_id

        // Extract interval from feed name (e.g., 'candles_trade_1m' -> '1m')
        const interval = msg.feed.replace('candles_trade_', '')

        this.cbWsTrade(
          {
            e: 'kline',
            E: Date.now(),
            s: symbol,
            k: {
              o: open || '0',
              h: high || '0',
              l: low || '0',
              c: close || '0',
              v: volume || '0',
              i: interval,
              t: time ? +new Date(time) : Date.now(),
            },
          },
          exchange,
        )
      }
    }
  }

  override subscribeCandleCb({
    symbol,
    exchange: _exchange,
    interval,
  }: SubscribeCandlePayload) {
    if (!this.isCandle && !this.isAll) {
      return
    }
    const exchange = mapPaperToReal(_exchange, false)
    const data = this.getCandleRoomName(symbol, exchange, interval)
    const set = this.subscribedCandlesMap.get(exchange) ?? new Set()
    let process = false
    if (!set.has(data)) {
      set.add(data)
      this.subscribedCandlesMap.set(exchange, set)
      process = true
    }
    if (process) {
      if ([ExchangeEnum.kraken, ExchangeEnum.paperKraken].includes(exchange)) {
        // Spot: use OHLC WebSocket channel
        this.connectKrakenCandleStream(symbol, interval)
      } else if (
        [ExchangeEnum.krakenUsdm, ExchangeEnum.paperKrakenUsdm].includes(
          exchange,
        )
      ) {
        // USDM Futures: use candles_trade WebSocket channel
        this.connectKrakenFuturesCandleStream(
          symbol,
          interval,
          ExchangeEnum.krakenUsdm,
        )
      } else if (
        [ExchangeEnum.krakenCoinm, ExchangeEnum.paperKrakenCoinm].includes(
          exchange,
        )
      ) {
        // COINM Futures: use candles_trade WebSocket channel
        this.connectKrakenFuturesCandleStream(
          symbol,
          interval,
          ExchangeEnum.krakenCoinm,
        )
      }
    }
  }

  private connectKrakenCandleStream(symbol: string, interval: string) {
    if (!this.krakenCandleClient) {
      this.krakenCandleClient = this.getKrakenClient('candle', false)
      this.krakenCandleClient.on(
        'message',
        this.krakenCandleCb(ExchangeEnum.kraken),
      )
    }

    // Convert normalized symbol to wsname format for subscription
    const wsnameSymbol =
      this.spotSymbolMaps.normalizedToWsname.get(symbol) || symbol

    // Subscribe to ohlc for the symbol (spot only)
    this.krakenCandleClient.subscribe(
      [{ topic: 'ohlc', payload: { symbol: wsnameSymbol, interval } }],
      'spotPublicV2',
    )
  }

  private connectKrakenFuturesCandleStream(
    symbol: string,
    interval: string,
    exchange: ExchangeEnum.krakenUsdm | ExchangeEnum.krakenCoinm,
  ) {
    const isUsdm = exchange === ExchangeEnum.krakenUsdm
    const symbolMaps = isUsdm ? this.usdmSymbolMaps : this.coinmSymbolMaps
    const client = isUsdm
      ? this.krakenUsdmCandleClient
      : this.krakenCoinmCandleClient

    if (!client) {
      const newClient = this.getKrakenClient('candle', true)
      newClient.on('message', this.krakenCandleCb(exchange))

      if (isUsdm) {
        this.krakenUsdmCandleClient = newClient
      } else {
        this.krakenCoinmCandleClient = newClient
      }
    }

    // Convert normalized symbol to wsname format (e.g., BTCUSD -> PF_XBTUSD)
    const wsnameSymbol = symbolMaps.normalizedToWsname.get(symbol) || symbol

    // Subscribe to candles_trade feed
    const feed = `candles_trade_${interval}`
    const targetClient = isUsdm
      ? this.krakenUsdmCandleClient!
      : this.krakenCoinmCandleClient!

    targetClient.subscribe(
      [
        {
          // @ts-expect-error undocumented feed
          topic: feed,
          payload: {
            product_ids: [wsnameSymbol],
          },
        },
      ],
      'derivativesPublicV1',
    )
  }

  @IdMute(mutex, () => 'initKrakenWS')
  async init() {
    try {
      // Load symbol maps before initializing websocket connections
      logger.info('Kraken Worker | Loading symbol maps...')
      this.spotSymbolMaps = await getKrakenSymbolMaps(ExchangeEnum.kraken)
      this.usdmSymbolMaps = await getKrakenSymbolMaps(ExchangeEnum.krakenUsdm)
      this.coinmSymbolMaps = await getKrakenSymbolMaps(ExchangeEnum.krakenCoinm)
      logger.info(
        `Kraken Worker | Symbol maps loaded: ${this.spotSymbolMaps.wsnameToNormalized.size} spot, ${this.usdmSymbolMaps.wsnameToNormalized.size} usdm, ${this.coinmSymbolMaps.wsnameToNormalized.size} coinm`,
      )

      if (!this.isCandle || this.isAll) {
        await this.initKrakenSpotWS()
        await this.initKrakenUsdmWS()
        await this.initKrakenCoinmWS()
      }
      if (this.isCandle || this.isAll) {
        // Initialize candle streams for already subscribed symbols
        for (const [exchange, symbols] of this.subscribedCandlesMap) {
          if (
            [ExchangeEnum.kraken, ExchangeEnum.paperKraken].includes(exchange)
          ) {
            for (const data of symbols) {
              const [symbol, interval] = this.splitCandleRoomName(data)
              this.connectKrakenCandleStream(symbol, interval)
            }
          } else if (
            [ExchangeEnum.krakenUsdm, ExchangeEnum.paperKrakenUsdm].includes(
              exchange,
            )
          ) {
            for (const data of symbols) {
              const [symbol, interval] = this.splitCandleRoomName(data)
              this.connectKrakenFuturesCandleStream(
                symbol,
                interval,
                ExchangeEnum.krakenUsdm,
              )
            }
          } else if (
            [ExchangeEnum.krakenCoinm, ExchangeEnum.paperKrakenCoinm].includes(
              exchange,
            )
          ) {
            for (const data of symbols) {
              const [symbol, interval] = this.splitCandleRoomName(data)
              this.connectKrakenFuturesCandleStream(
                symbol,
                interval,
                ExchangeEnum.krakenCoinm,
              )
            }
          }
        }
      }
    } catch (e) {
      logger.error(`Kraken init error: ${(e as Error)?.message ?? e}`)
      throw e
    }
  }

  private async initKrakenSpotWS() {
    const symbols = await getAllExchangeInfo(ExchangeEnum.kraken)

    if (!symbols.length) {
      logger.warn('No Kraken spot symbols found, skipping subscription')
      return
    }
    // Convert normalized symbols to wsname format for subscription
    const wsnameSymbols = symbols
      .map(
        (symbol) =>
          this.spotSymbolMaps.normalizedToWsname.get(symbol) || symbol,
      )
      .filter(Boolean)

    // Split symbols into chunks
    const chunks = wsnameSymbols.reduce((acc, symbol, index) => {
      const chunkIndex = Math.floor(index / chunkSize)
      if (!acc[chunkIndex]) {
        acc[chunkIndex] = []
      }
      acc[chunkIndex].push(symbol)
      return acc
    }, [] as string[][])

    let i = 0
    for (const chunk of chunks) {
      // Find existing client with available capacity
      const existingClient = this.krakenSpotClients
        .filter((c) => c.subs < maxSubsPerClient)
        .sort((a, b) => b.subs - a.subs)[0]

      if (existingClient) {
        existingClient.client.subscribe(
          [{ topic: 'ticker', payload: { symbol: chunk } }],
          'spotPublicV2',
        )
        existingClient.subs += chunk.length
        this.krakenSpotClients = this.krakenSpotClients.map((c) =>
          c.id === existingClient.id ? { ...existingClient } : c,
        )
      } else {
        // Create new client
        const newClient = this.getKrakenClient('ticker', false)
        newClient.on('message', this.krakenTickerCb(ExchangeEnum.kraken))

        newClient.subscribe(
          [{ topic: 'ticker', payload: { symbol: chunk } }],
          'spotPublicV2',
        )

        const lastId =
          this.krakenSpotClients.sort((a, b) => b.id - a.id)[0]?.id ?? 0
        this.krakenSpotClients.push({
          client: newClient,
          subs: chunk.length,
          id: lastId + 1,
        })
      }

      i++
      logger.info(
        `Subscribed to chunk ${i} of ${chunks.length} Kraken spot markets`,
      )
      await sleep(500)
    }

    logger.info(
      `Subscribed to ${symbols.length} Kraken spot markets across ${this.krakenSpotClients.length} connections`,
    )
  }

  private async initKrakenUsdmWS() {
    const symbols = await getAllExchangeInfo(ExchangeEnum.krakenUsdm)

    if (!symbols.length) {
      logger.warn('No Kraken USDM symbols found, skipping subscription')
      return
    }

    // Convert normalized symbols to wsname format for subscription
    const wsnameSymbols = symbols
      .map(
        (symbol) =>
          this.usdmSymbolMaps.normalizedToWsname.get(symbol) || symbol,
      )
      .filter(Boolean)

    // Split symbols into chunks
    const chunks = wsnameSymbols.reduce((acc, symbol, index) => {
      const chunkIndex = Math.floor(index / chunkSize)
      if (!acc[chunkIndex]) {
        acc[chunkIndex] = []
      }
      acc[chunkIndex].push(symbol)
      return acc
    }, [] as string[][])

    let i = 0
    for (const chunk of chunks) {
      // Find existing client with available capacity
      const existingClient = this.krakenUsdmClients
        .filter((c) => c.subs < maxSubsPerClient)
        .sort((a, b) => b.subs - a.subs)[0]

      if (existingClient) {
        existingClient.client.subscribe(
          [{ topic: 'ticker', payload: { product_ids: chunk } }],
          'derivativesPublicV1',
        )
        existingClient.subs += chunk.length
        this.krakenUsdmClients = this.krakenUsdmClients.map((c) =>
          c.id === existingClient.id ? { ...existingClient } : c,
        )
      } else {
        // Create new client
        const newClient = this.getKrakenClient('ticker', true)
        newClient.on('message', this.krakenTickerCb(ExchangeEnum.krakenUsdm))

        newClient.subscribe(
          [{ topic: 'ticker', payload: { product_ids: chunk } }],
          'derivativesPublicV1',
        )

        const lastId =
          this.krakenUsdmClients.sort((a, b) => b.id - a.id)[0]?.id ?? 0
        this.krakenUsdmClients.push({
          client: newClient,
          subs: chunk.length,
          id: lastId + 1,
        })
      }

      i++
      logger.info(
        `Subscribed to chunk ${i} of ${chunks.length} Kraken USDM markets`,
      )
      await sleep(500)
    }

    logger.info(
      `Subscribed to ${symbols.length} Kraken USDM markets across ${this.krakenUsdmClients.length} connections`,
    )
  }

  private async initKrakenCoinmWS() {
    const symbols = await getAllExchangeInfo(ExchangeEnum.krakenCoinm)

    if (!symbols.length) {
      logger.warn('No Kraken COINM symbols found, skipping subscription')
      return
    }

    // Convert normalized symbols to wsname format for subscription
    const wsnameSymbols = symbols
      .map(
        (symbol) =>
          this.coinmSymbolMaps.normalizedToWsname.get(symbol) || symbol,
      )
      .filter(Boolean)

    // Split symbols into chunks
    const chunks = wsnameSymbols.reduce((acc, symbol, index) => {
      const chunkIndex = Math.floor(index / chunkSize)
      if (!acc[chunkIndex]) {
        acc[chunkIndex] = []
      }
      acc[chunkIndex].push(symbol)
      return acc
    }, [] as string[][])

    let i = 0
    for (const chunk of chunks) {
      // Find existing client with available capacity
      const existingClient = this.krakenCoinmClients
        .filter((c) => c.subs < maxSubsPerClient)
        .sort((a, b) => b.subs - a.subs)[0]

      if (existingClient) {
        existingClient.client.subscribe(
          [{ topic: 'ticker', payload: { product_ids: chunk } }],
          'derivativesPublicV1',
        )
        existingClient.subs += chunk.length
        this.krakenCoinmClients = this.krakenCoinmClients.map((c) =>
          c.id === existingClient.id ? { ...existingClient } : c,
        )
      } else {
        // Create new client
        const newClient = this.getKrakenClient('ticker', true)
        newClient.on('message', this.krakenTickerCb(ExchangeEnum.krakenCoinm))

        newClient.subscribe(
          [{ topic: 'ticker', payload: { product_ids: chunk } }],
          'derivativesPublicV1',
        )

        const lastId =
          this.krakenCoinmClients.sort((a, b) => b.id - a.id)[0]?.id ?? 0
        this.krakenCoinmClients.push({
          client: newClient,
          subs: chunk.length,
          id: lastId + 1,
        })
      }

      i++
      logger.info(
        `Subscribed to chunk ${i} of ${chunks.length} Kraken COINM markets`,
      )
      await sleep(500)
    }

    logger.info(
      `Subscribed to ${symbols.length} Kraken COINM markets across ${this.krakenCoinmClients.length} connections`,
    )
  }

  override stop() {
    super.stop()
    this.krakenSpotClients.forEach((k) => {
      k.client.closeAll(true)
      k.client.removeAllListeners()
    })
    this.krakenUsdmClients.forEach((k) => {
      k.client.closeAll(true)
      k.client.removeAllListeners()
    })
    this.krakenCoinmClients.forEach((k) => {
      k.client.closeAll(true)
      k.client.removeAllListeners()
    })
    if (this.krakenCandleClient) {
      this.krakenCandleClient.closeAll(true)
      this.krakenCandleClient.removeAllListeners()
    }
    if (this.krakenUsdmCandleClient) {
      this.krakenUsdmCandleClient.closeAll(true)
      this.krakenUsdmCandleClient.removeAllListeners()
    }
    if (this.krakenCoinmCandleClient) {
      this.krakenCoinmCandleClient.closeAll(true)
      this.krakenCoinmCandleClient.removeAllListeners()
    }
  }
}

export default KrakenConnector
