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
  private krakenFuturesClients: KrakenClient = []
  private krakenCandleClient: KrakenWsClient | null = null
  private spotSymbolMaps: KrakenSymbolMap = {
    wsnameToNormalized: new Map(),
    normalizedToWsname: new Map(),
  }
  private futuresSymbolMaps: KrakenSymbolMap = {
    wsnameToNormalized: new Map(),
    normalizedToWsname: new Map(),
  }

  constructor(
    private subscribedCandlesMap: Map<ExchangeEnum, Set<string>> = new Map(),
  ) {
    super()
    this.mainData = {
      [ExchangeEnum.kraken]: this.base,
      [ExchangeEnum.krakenUsdm]: this.base,
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
        : this.futuresSymbolMaps

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
      }
    }
  }

  private krakenCandleCb(exchange: ExchangeEnum) {
    return (msg: any) => {
      if (msg.channel === 'ohlc' && msg.data) {
        const symbolMaps =
          exchange === ExchangeEnum.kraken
            ? this.spotSymbolMaps
            : this.futuresSymbolMaps

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
        this.connectKrakenCandleStream(symbol, interval, false)
      }
      if (
        [ExchangeEnum.krakenUsdm, ExchangeEnum.paperKrakenUsdm].includes(
          exchange,
        )
      ) {
        this.connectKrakenCandleStream(symbol, interval, true)
      }
    }
  }

  private connectKrakenCandleStream(
    symbol: string,
    interval: string,
    isFutures: boolean,
  ) {
    if (!this.krakenCandleClient) {
      this.krakenCandleClient = this.getKrakenClient('candle', isFutures)
      this.krakenCandleClient.on(
        'message',
        this.krakenCandleCb(
          isFutures ? ExchangeEnum.krakenUsdm : ExchangeEnum.kraken,
        ),
      )
    }

    // Convert normalized symbol to wsname format for subscription
    const symbolMaps = isFutures ? this.futuresSymbolMaps : this.spotSymbolMaps
    const wsnameSymbol = symbolMaps.normalizedToWsname.get(symbol) || symbol

    // Subscribe to ohlc for the symbol
    const wsKey = isFutures ? 'derivativesPublicV1' : 'spotPublicV2'
    this.krakenCandleClient.subscribe(
      [{ topic: 'ohlc', payload: { symbol: wsnameSymbol, interval } }],
      wsKey,
    )
  }

  @IdMute(mutex, () => 'initKrakenWS')
  async init() {
    try {
      // Load symbol maps before initializing websocket connections
      logger.info('Kraken Worker | Loading symbol maps...')
      this.spotSymbolMaps = await getKrakenSymbolMaps(ExchangeEnum.kraken)
      this.futuresSymbolMaps = await getKrakenSymbolMaps(
        ExchangeEnum.krakenUsdm,
      )
      logger.info(
        `Kraken Worker | Symbol maps loaded: ${this.spotSymbolMaps.wsnameToNormalized.size} spot, ${this.futuresSymbolMaps.wsnameToNormalized.size} futures`,
      )

      if (!this.isCandle || this.isAll) {
        await this.initKrakenSpotWS()
        await this.initKrakenFuturesWS()
      }
      if (this.isCandle || this.isAll) {
        // Initialize candle streams for already subscribed symbols
        for (const [exchange, symbols] of this.subscribedCandlesMap) {
          if (
            [ExchangeEnum.kraken, ExchangeEnum.paperKraken].includes(exchange)
          ) {
            for (const data of symbols) {
              const [symbol, interval] = this.splitCandleRoomName(data)
              this.connectKrakenCandleStream(symbol, interval, false)
            }
          }
          if (
            [ExchangeEnum.krakenUsdm, ExchangeEnum.paperKrakenUsdm].includes(
              exchange,
            )
          ) {
            for (const data of symbols) {
              const [symbol, interval] = this.splitCandleRoomName(data)
              this.connectKrakenCandleStream(symbol, interval, true)
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

  private async initKrakenFuturesWS() {
    const symbols = await getAllExchangeInfo(ExchangeEnum.krakenUsdm)

    if (!symbols.length) {
      logger.warn('No Kraken futures symbols found, skipping subscription')
      return
    }

    // Convert normalized symbols to wsname format for subscription (futures typically don't need conversion, but keeping consistent)
    const wsnameSymbols = symbols
      .map(
        (symbol) =>
          this.futuresSymbolMaps.normalizedToWsname.get(symbol) || symbol,
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
      const existingClient = this.krakenFuturesClients
        .filter((c) => c.subs < maxSubsPerClient)
        .sort((a, b) => b.subs - a.subs)[0]

      if (existingClient) {
        existingClient.client.subscribe(
          [{ topic: 'ticker', payload: { product_ids: chunk } }],
          'derivativesPublicV1',
        )
        existingClient.subs += chunk.length
        this.krakenFuturesClients = this.krakenFuturesClients.map((c) =>
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
          this.krakenFuturesClients.sort((a, b) => b.id - a.id)[0]?.id ?? 0
        this.krakenFuturesClients.push({
          client: newClient,
          subs: chunk.length,
          id: lastId + 1,
        })
      }

      i++
      logger.info(
        `Subscribed to chunk ${i} of ${chunks.length} Kraken futures markets`,
      )
      await sleep(500)
    }

    logger.info(
      `Subscribed to ${symbols.length} Kraken futures markets across ${this.krakenFuturesClients.length} connections`,
    )
  }

  override stop() {
    super.stop()
    this.krakenSpotClients.forEach((k) => {
      k.client.closeAll(true)
      k.client.removeAllListeners()
    })
    this.krakenFuturesClients.forEach((k) => {
      k.client.closeAll(true)
      k.client.removeAllListeners()
    })
    if (this.krakenCandleClient) {
      this.krakenCandleClient.closeAll(true)
      this.krakenCandleClient.removeAllListeners()
    }
  }
}

export default KrakenConnector
