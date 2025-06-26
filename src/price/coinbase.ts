import { ExchangeEnum } from '../utils/common'
import logger from '../utils/logger'
import Coinbase, {
  WebSocketChannelName,
  WebSocketEvent,
  WebSocketTickerMessage,
} from 'coinbase-advanced-node'
import getAllExchangeInfo from '../utils/exchange'
import CommonConnector from './common'

class CoinbaseConnector extends CommonConnector {
  private coinbaseClient: Coinbase = this.getCoinbaseClient()
  constructor() {
    super()
    this.coinbaseSubscribeCb = this.coinbaseSubscribeCb.bind(this)
    this.coinbaseTickerCb = this.coinbaseTickerCb.bind(this)
    this.mainData = {
      [ExchangeEnum.coinbase]: this.base,
    }
    logger.info(`Coinbase Worker | >🚀 Price <-> Backend stream`)
  }

  private coinbaseSubscribeCb(symbols: string[]) {
    return () => {
      this.coinbaseClient.ws.subscribe({
        channel: WebSocketChannelName.TICKER_BATCH,
        product_ids: symbols,
      })
      logger.info(`Coinbase connected`)
    }
  }

  private coinbaseTickerCb() {
    return (data: WebSocketTickerMessage) => {
      const allTickers = data.events
        .map((e) =>
          e.tickers.map((t) => ({
            eventType: 'update',
            eventTime: +new Date(data.timestamp),
            symbol: t.product_id,
            curDayClose: t.price,
            bestBid: t.price,
            bestBidQnt: t.volume_24_h,
            bestAsk: t.price,
            bestAskQnt: t.volume_24_h,
            open: t.price,
            high: t.price,
            low: t.price,
            volume: t.volume_24_h,
            volumeQuote: t.volume_24_h,
          })),
        )
        .flat()
      for (const t of allTickers) {
        if (t.symbol.endsWith('-USD')) {
          allTickers.push({ ...t, symbol: `${t.symbol}C` })
        }
      }
      this.cbWs(allTickers, ExchangeEnum.coinbase)
    }
  }

  private getCoinbaseClient(current?: Coinbase) {
    if (current) {
      current.ws.disconnect()
    }
    const client = new Coinbase({
      cloudApiKeyName: process.env.COINBASE_API_KEY,
      cloudApiSecret: process.env.COINBASE_API_SECRET,
    })
    return client
  }

  private stopCoinbase() {
    this.coinbaseClient = this.getCoinbaseClient(this.coinbaseClient)
  }

  async init() {
    if (!this.isCandle || this.isAll) {
      this.initCoinbase()
    }
  }

  private async initCoinbase() {
    try {
      const symbols = await getAllExchangeInfo(ExchangeEnum.coinbase)
      this.coinbaseClient.ws.connect()
      this.coinbaseClient.ws.on(
        WebSocketEvent.ON_OPEN,
        this.coinbaseSubscribeCb(symbols),
      )
      this.coinbaseClient.ws.on(
        WebSocketEvent.ON_MESSAGE_TICKER,
        this.coinbaseTickerCb(),
      )
    } catch (e) {
      logger.error('Coinbase error', e)
    }
  }

  stop() {
    super.stop()
    this.stopCoinbase()
  }
}

export default CoinbaseConnector
