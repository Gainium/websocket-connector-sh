import { ExchangeEnum } from '../utils/common'
import { workerData } from 'worker_threads'
import BybitConnector from './bybit'
import BinanceConnector from './binance'
import KucoinConnector from './kucoin'
import OkxConnector from './okx'
import CoinbaseConnector from './coinbase'
import BitgetConnector from './bitget'
import logger from '../utils/logger'
import sleep from '../utils/sleep'
import { skipReason } from '../../type'
import type { BinancePayload } from './types'

type ConnectorType =
  | ExchangeEnum.binance
  | ExchangeEnum.bybit
  | ExchangeEnum.kucoin
  | ExchangeEnum.okx
  | ExchangeEnum.coinbase
  | ExchangeEnum.bitget
  | ExchangeEnum.mexc

type Payload = {
  subscribedCandlesMap: Map<ExchangeEnum, Set<string>>
  subscribedTopics: Map<ExchangeEnum, Set<string>>
}

const createConnector = (
  exchange: ConnectorType,
  payload: Payload,
  binancePayload?: BinancePayload,
) => {
  if (exchange === ExchangeEnum.binance) {
    return new BinanceConnector(payload.subscribedCandlesMap, binancePayload)
  }
  if (exchange === ExchangeEnum.bitget) {
    return new BitgetConnector(payload.subscribedCandlesMap)
  }
  if (exchange === ExchangeEnum.bybit) {
    return new BybitConnector(
      payload.subscribedCandlesMap,
      payload.subscribedTopics,
    )
  }
  if (exchange === ExchangeEnum.kucoin) {
    return new KucoinConnector()
  }
  if (exchange === ExchangeEnum.okx) {
    return new OkxConnector(payload.subscribedCandlesMap)
  }
  if (exchange === ExchangeEnum.coinbase) {
    return new CoinbaseConnector()
  }
}

const data = workerData.data as {
  exchange: ConnectorType
  payload: Payload
  binance?: BinancePayload
}

let retry = 0

const retryCount = 1

let retryStart = 0

const retryTimeout = 60 * 1000

const getStream = () => {
  const str = createConnector(data.exchange, data.payload, data.binance)
  if (str) {
    str.init()
  }
  return str
}

let stream = getStream()

let lock = false

process
  .on('unhandledRejection', async (reason, p) => {
    if (
      skipReason.filter((r) => r.indexOf(`${reason}`.toLowerCase()) !== -1)
        .length ||
      skipReason.filter((r) => `${reason}`.toLowerCase().indexOf(`${r}`) !== -1)
        .length
    ) {
      return
    }
    if (lock) {
      return
    }
    logger.error(reason, 'Unhandled Rejection at Promise', p)
    const time = +new Date()
    if (`${reason}`.includes('response: 403')) {
      const sleepSec = (retry + 1) * 30000
      logger.error(`Got 403 error. Sleeps ${sleepSec / 1000}s`)
      lock = true
      await sleep(sleepSec)
      lock = false
    }
    if (retryStart + retryTimeout > time) {
      retry++
      if (retry === retryCount) {
        process.exit(1)
      }
    } else {
      retry = 1
    }
    retryStart = time
    if (stream) {
      stream.stop()
    }
    stream = getStream()
  })
  .on('uncaughtException', async (err) => {
    if (
      skipReason.filter((r) => r.indexOf(`${err.message}`.toLowerCase()) !== -1)
        .length ||
      skipReason.filter(
        (r) => `${err.message}`.toLowerCase().indexOf(`${r}`) !== -1,
      ).length
    ) {
      return
    }
    if (lock) {
      return
    }
    logger.error(err.message, 'Uncaught Exception thrown')
    console.error(err)
    if (`${err.message}`.includes('response: 403')) {
      const sleepSec = (retry + 1) * 30000
      logger.error(`Got 403 error. Sleeps ${sleepSec / 1000}s`)
      lock = true
      await sleep(sleepSec)
      lock = false
    }
    const time = +new Date()
    if (retryStart + retryTimeout > time) {
      retry++
      if (retry === retryCount) {
        process.exit(1)
      }
    } else {
      retry = 1
    }
    retryStart = time
    if (stream) {
      stream.stop()
    }
    stream = getStream()
  })
