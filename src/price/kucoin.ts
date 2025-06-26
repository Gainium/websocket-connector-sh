import KucoinWSClient from '@gainium/kucoin-api'
import { ExchangeEnum } from '../utils/common'
import logger from '../utils/logger'
import sleep from '../utils/sleep'
import { convertSymbolToKucoin, convertSymbol } from '../utils/kucoin'
import getAllExchangeInfo from '../utils/exchange'

import CommonConnector from './common'

type KucoinClient = {
  client: KucoinWSClient
  subs: number
  id: number
}[]

const maxSubs = 290

class KucoinConnector extends CommonConnector {
  private kucoinClient: KucoinClient = [
    { client: this.getKucoinClient(), id: 0, subs: 0 },
  ]
  private kucoinUsdmClient: KucoinClient = [
    { client: this.getKucoinClient(), id: 0, subs: 0 },
  ]
  private kucoinCoinmClient: KucoinClient = [
    { client: this.getKucoinClient(), id: 0, subs: 0 },
  ]
  private kucoinErrors = 0
  constructor() {
    super()
    this.mainData = {
      [ExchangeEnum.kucoin]: this.base,
      [ExchangeEnum.kucoinInverse]: this.base,
      [ExchangeEnum.kucoinLinear]: this.base,
    }
    logger.info(`Kucoin Worker | >🚀 Price <-> Backend stream`)
  }

  private getKucoinClient(current?: KucoinWSClient) {
    if (current) {
      const ws = current.ws().ws().public.ws
      if (ws) {
        ws.onclose = () => null
        try {
          ws.close()
        } catch (e) {
          logger.info(`Cannot close kucoin ws ${(e as Error)?.message ?? e}`)
        }
      }
    }
    return new KucoinWSClient()
  }

  async init() {
    if (!this.isCandle || this.isAll) {
      this.initKucoinWS()
    }
  }

  private stopKucoin() {
    this.kucoinClient = this.kucoinClient.map((k) => ({
      client: this.getKucoinClient(k.client),
      subs: 0,
      id: k.id,
    }))
    this.kucoinUsdmClient = this.kucoinUsdmClient.map((k) => ({
      client: this.getKucoinClient(k.client),
      subs: 0,
      id: k.id,
    }))
    this.kucoinCoinmClient = this.kucoinUsdmClient.map((k) => ({
      client: this.getKucoinClient(k.client),
      subs: 0,
      id: k.id,
    }))
  }

  private async kucoinError(msg: string) {
    logger.info(`Kucoin error: ${msg}`)
    if (
      msg.indexOf('Kucoin WS closed') !== -1 ||
      msg.indexOf('Ping error') !== -1
    ) {
      this.kucoinErrors += 1
      if (this.kucoinErrors >= 5) {
        process.exit(1)
      }
    }
  }

  private async initKucoinWS() {
    await this.kucoinClient[0]?.client
      .ws()
      .tickerAll(
        (ticker) => this.cbWs([ticker], ExchangeEnum.kucoin),
        this.kucoinError.bind(this),
      )
    await sleep(2000)
    const usdmData = await getAllExchangeInfo(ExchangeEnum.kucoinLinear)
    let chunks = usdmData.reduce((resultArray, item, index) => {
      const chunkIndex = Math.floor(index / maxSubs)
      if (!resultArray[chunkIndex]) {
        resultArray[chunkIndex] = []
      }
      resultArray[chunkIndex].push(item)
      return resultArray
    }, [] as string[][])
    let i = 0
    for (const chunk of chunks) {
      const cl = this.kucoinUsdmClient
        .filter((c) => c.subs < maxSubs)
        .sort((a, b) => b.subs - a.subs)[0]
      if (cl) {
        await cl.client.ws().futuresTicker(
          chunk.map((s) => convertSymbolToKucoin(s)),
          (ticker) =>
            this.cbWs(
              [{ ...ticker, symbol: convertSymbol(ticker.symbol) }],
              ExchangeEnum.kucoinLinear,
            ),
          this.kucoinError.bind(this),
        )
        cl.subs += chunk.length
        this.kucoinUsdmClient = this.kucoinUsdmClient.map((c) =>
          c.id === cl.id ? { ...cl } : c,
        )
      } else {
        const cl = this.getKucoinClient()
        await cl.ws().futuresTicker(
          chunk.map((s) => convertSymbolToKucoin(s)),
          (ticker) =>
            this.cbWs(
              [{ ...ticker, symbol: convertSymbol(ticker.symbol) }],
              ExchangeEnum.kucoinLinear,
            ),
          this.kucoinError.bind(this),
        )
        const last =
          this.kucoinUsdmClient.sort((a, b) => b.id - a.id)[0]?.id ?? 0
        this.kucoinUsdmClient.push({
          client: cl,
          subs: chunk.length,
          id: last + 1,
        })
      }
      i++
      logger.info(
        `Subscribed to chunk ${i} of ${chunks.length} kucoin USDM markets`,
      )
      await sleep(2000)
    }

    const coinmData = await getAllExchangeInfo(ExchangeEnum.kucoinInverse)
    chunks = usdmData.reduce((resultArray, item, index) => {
      const chunkIndex = Math.floor(index / maxSubs)
      if (!resultArray[chunkIndex]) {
        resultArray[chunkIndex] = []
      }
      resultArray[chunkIndex].push(item)
      return resultArray
    }, [] as string[][])
    i = 0
    for (const chunk of chunks) {
      const cl = this.kucoinCoinmClient
        .filter((c) => c.subs < maxSubs)
        .sort((a, b) => b.subs - a.subs)[0]
      if (cl) {
        await cl.client.ws().futuresTicker(
          coinmData.map((s) => convertSymbolToKucoin(s)),
          (ticker) =>
            this.cbWs(
              [{ ...ticker, symbol: convertSymbol(ticker.symbol) }],
              ExchangeEnum.kucoinInverse,
            ),
          this.kucoinError.bind(this),
        )
        cl.subs += chunk.length
        this.kucoinCoinmClient = this.kucoinCoinmClient.map((c) =>
          c.id === cl.id ? { ...cl } : c,
        )
      } else {
        const cl = this.getKucoinClient()
        await cl.ws().futuresTicker(
          coinmData.map((s) => convertSymbolToKucoin(s)),
          (ticker) =>
            this.cbWs(
              [{ ...ticker, symbol: convertSymbol(ticker.symbol) }],
              ExchangeEnum.kucoinInverse,
            ),
          this.kucoinError.bind(this),
        )
        const last =
          this.kucoinCoinmClient.sort((a, b) => b.id - a.id)[0]?.id ?? 0
        this.kucoinCoinmClient.push({
          client: cl,
          subs: chunk.length,
          id: last + 1,
        })
      }
      i++
      logger.info(
        `Subscribed to chunk ${i} of ${chunks.length} kucoin COINM markets`,
      )
      await sleep(2000)
    }
  }

  stop() {
    super.stop()
    this.stopKucoin()
  }
}

export default KucoinConnector
