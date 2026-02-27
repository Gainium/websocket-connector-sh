import { convert, convertFutures } from './utils/binance'
import { WebsocketAPIClient, WebsocketClient } from 'binance'
import * as hl from '@nktkas/hyperliquid'
import KucoinApi from '@gainium/kucoin-api'
import Coinbase, {
  OrderSide,
  OrderStatus,
  WebSocketChannelName,
  WebSocketEvent,
  WebsocketUserMessage,
} from 'coinbase-advanced-node'
import crypto from 'crypto'
import { CategoryV5 } from 'bybit-api'
import { WebsocketClient as BybitClient } from '../bybit-custom/websocket-client'
import { WebsocketClient as OKXClient, WsChannelArgInstType } from 'okx-api'
import { WebsocketClientV2 as BitgetClient, BitgetInstTypeV2 } from 'bitget-api'
import { connectPaper } from './utils/paperTradingWS'
import logger from './utils/logger'
import { IdMute, IdMutex } from './utils/mutex'
import sleep from './utils/sleep'
import { KucoinSymbol, getKucoinSymbolsByMarket } from './utils/exchange'
import { convertSymbol, convertSymbolToKucoin } from './utils/kucoin'
import { ExchangeEnum, mapPaperToReal, wsLoggerOptions } from './utils/common'
import RedisClient from './utils/redis'
import { v4 } from 'uuid'
import Rabbit from './utils/rabbit'
import { rabbitUsersStreamKey, serviceLogRedis } from '../type'
import { RestClientV5 } from 'bybit-api'
import ExpirableMap from './utils/expirableMap'

const mutex = new IdMutex()

export type PaperExchangeType =
  | ExchangeEnum.paperFtx
  | ExchangeEnum.paperBybit
  | ExchangeEnum.paperBinance
  | ExchangeEnum.paperKucoin
  | ExchangeEnum.paperBinanceCoinm
  | ExchangeEnum.paperBinanceUsdm
  | ExchangeEnum.paperBybitCoinm
  | ExchangeEnum.paperBybitUsdm
  | ExchangeEnum.paperOkx
  | ExchangeEnum.paperOkxLinear
  | ExchangeEnum.paperOkxInverse
  | ExchangeEnum.paperCoinbase
  | ExchangeEnum.paperKucoinInverse
  | ExchangeEnum.paperKucoinLinear
  | ExchangeEnum.paperBitget
  | ExchangeEnum.paperBitgetCoinm
  | ExchangeEnum.paperBitgetCoinm
  | ExchangeEnum.paperMexc
  | ExchangeEnum.paperHyperliquid
  | ExchangeEnum.paperHyperliquidLinear

export const paperExchanges = [
  ExchangeEnum.paperFtx,
  ExchangeEnum.paperBybit,
  ExchangeEnum.paperBinance,
  ExchangeEnum.paperKucoin,
  ExchangeEnum.paperBinanceCoinm,
  ExchangeEnum.paperBinanceUsdm,
  ExchangeEnum.paperBybitUsdm,
  ExchangeEnum.paperBybitCoinm,
  ExchangeEnum.paperOkx,
  ExchangeEnum.paperOkxInverse,
  ExchangeEnum.paperOkxLinear,
  ExchangeEnum.paperCoinbase,
  ExchangeEnum.paperKucoinInverse,
  ExchangeEnum.paperKucoinLinear,
  ExchangeEnum.paperBitget,
  ExchangeEnum.paperBitgetUsdm,
  ExchangeEnum.paperBitgetCoinm,
  ExchangeEnum.paperMexc,
  ExchangeEnum.paperHyperliquid,
  ExchangeEnum.paperHyperliquidLinear,
]

export enum BybitHost {
  eu = 'eu',
  com = 'com',
  nl = 'nl',
  tr = 'tr',
  kz = 'kz',
  ge = 'ge',
}

export const bybitHostMap: Record<BybitHost, string> = {
  [BybitHost.eu]: 'wss://stream.bybit.eu/v5/private',
  [BybitHost.com]: 'wss://stream.bybit.com/v5/private',
  [BybitHost.nl]: 'wss://stream.bybit.nl/v5/private',
  [BybitHost.tr]: 'wss://stream.bybit-tr.com/v5/private',
  [BybitHost.kz]: 'wss://stream.bybit.kz/v5/private',
  [BybitHost.ge]: 'wss://stream.bybitgeorgia.ge/v5/private',
}

export const bybitHostAPIMap: Record<BybitHost, string> = {
  [BybitHost.eu]: 'https://api.bybit.eu',
  [BybitHost.com]: 'https://api.bybit.com',
  [BybitHost.nl]: 'https://api.bybit.eu',
  [BybitHost.tr]: 'https://api.bybit-tr.com',
  [BybitHost.kz]: 'https://api.bybit.kz',
  [BybitHost.ge]: 'https://api.bybitgeorgia.ge',
}

export interface AssetBalance {
  asset: string
  free: string
  locked: string
}

export interface OutboundAccountPosition {
  balances: AssetBalance[]
  eventTime: number
  eventType: 'outboundAccountPosition'
  lastAccountUpdate: number
  uniqueMessageId?: string
}

export interface BalanceUpdate {
  asset: string
  balanceDelta: string
  clearTime: number
  eventTime: number
  eventType: 'balanceUpdate'
}

export type OrderStatus_LT =
  | 'CANCELED'
  | 'FILLED'
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'EXPIRED'
  | 'PENDING_CANCEL'
  | 'REJECTED'

export type FuturesOrderType_LT =
  | 'LIMIT'
  | 'MARKET'
  | 'STOP'
  | 'TAKE_PROFIT'
  | 'STOP_MARKET'
  | 'TAKE_PROFIT_MARKET'
  | 'TRAILING_STOP_MARKET'

export type OrderSide_LT = 'BUY' | 'SELL'

export interface ExecutionReport {
  creationTime: number // Order creation time
  eventTime: number
  eventType: 'executionReport'
  newClientOrderId: string // Client order ID
  orderId: number | string // Order ID
  orderStatus: OrderStatus_LT // Current order status
  orderTime: number // Transaction time
  orderType: FuturesOrderType_LT // Order type
  originalClientOrderId: string | null // Original client order ID; This is the ID of the order being canceled
  price: string // Order price
  quantity: string // Order quantity
  side: OrderSide_LT // Side
  symbol: string // Symbol
  totalQuoteTradeQuantity: string // Cumulative quote asset transacted quantity
  totalTradeQuantity: string // Cumulative filled quantity
  uniqueMessageId?: string
  liquidation?: boolean
}

export type UserDataStreamEvent =
  | OutboundAccountPosition
  | ExecutionReport
  | BalanceUpdate

export enum CoinbaseKeysType {
  legacy = 'legacy',
  cloud = 'cloud',
}

export enum OKXSource {
  my = 'my',
  app = 'app',
  com = 'com',
}

type OpenStreamInput = {
  userId: string
  api: {
    key: string
    secret: string
    passphrase?: string
    bybitHost?: BybitHost
    provider: ExchangeEnum
    environment?: 'live' | 'sandbox'
    keysType?: CoinbaseKeysType
    okxSource?: OKXSource
  }
}

type User = {
  close: () => void
  timer: NodeJS.Timeout | null
  pending: boolean
  id: string
  provider: ExchangeEnum
}

type BybitOrderMessage = {
  id: string
  topic: string
  creationTime: string
  data: {
    createType: string
    symbol: string
    orderId: string
    side: string
    orderType: string
    cancelType: string
    price: string
    qty: string
    orderIv: string
    timeInForce: string
    orderStatus: string
    orderLinkId: string
    lastPriceOnCreated: string
    reduceOnly: boolean
    leavesQty: string
    leavesValue: string
    cumExecQty: string
    cumExecValue: string
    avgPrice: string
    blockTradeId: string
    positionIdx: number
    cumExecFee: string
    createdTime: string
    updatedTime: string
    rejectReason: string
    stopOrderType: string
    tpslMode: string
    triggerPrice: string
    takeProfit: string
    stopLoss: string
    tpTriggerBy: string
    slTriggerBy: string
    tpLimitPrice: string
    slLimitPrice: string
    triggerDirection: number
    triggerBy: string
    closeOnTrigger: boolean
    category: string
    placeType: string
    smpType: string
    smpGroup: number
    smpOrderId: string
    feeCurrency: string
  }[]
}

type BitgetSpotOrder = {
  instId: string
  orderId: string
  clientOid: string
  size: string
  newSize: string
  notional: string
  orderType: string
  force: string
  side: string
  fillPrice: string
  tradeId: string
  baseVolume: string
  fillTime: string
  fillFee: string
  fillFeeCoin: string
  tradeScope: string
  accBaseVolume: string
  priceAvg: string
  price: string
  status: string
  cTime: string
  uTime: string
  stpMode: string
  feeDetail: {
    feeCoin: string
    fee: string
  }[]
  enterPointSource: string
}

type BitgetSpotBalance = {
  coin: string
  available: string
  frozen: string
  locked: string
  limitAvailable: string
  uTime: string
}

type BitgetFuturesBalance = {
  marginCoin: string
  frozen: string
  available: string
  maxOpenPosAvailable: string
  maxTransferOut: string
  equity: string
  usdtEquity: string
}

export type PaperOrderMessage = {
  _id: string
  price: number
  filledAmount: number
  filledQuoteAmount: number
  amount: number
  type: string
  symbol: string
  externalId: string
  status: OrderStatus_LT
  createdAt: string
  updatedAt: string
  side: string
  quoteAmount: number
  exchange: string
}

export type OKXAccountMsg = {
  adjEq: string
  borrowFroz: string
  details: {
    availBal: string
    availEq: string
    borrowFroz: string
    cashBal: string
    ccy: string
    coinUsdPrice: string
    crossLiab: string
    disEq: string
    eq: string
    eqUsd: string
    fixedBal: string
    frozenBal: string
    interest: string
    isoEq: string
    isoLiab: string
    isoUpl: string
    liab: string
    maxLoan: string
    mgnRatio: string
    notionalLever: string
    ordFrozen: string
    spotInUseAmt: string
    spotIsoBal: string
    stgyEq: string
    twap: string
    uTime: string
    upl: string
    uplLiab: string
  }[]
  imr: string
  isoEq: string
  mgnRatio: string
  mmr: string
  notionalUsd: string
  ordFroz: string
  totalEq: string
  uTime: string
}

export type OKXOrderMsg = {
  accFillSz: string
  algoClOrdId: string
  algoId: string
  amendResult: string
  amendSource: string
  attachAlgoClOrdId: string
  attachAlgoOrds: any[]
  avgPx: string
  cTime: string
  cancelSource: string
  category: string
  ccy: string
  clOrdId: string
  code: string
  execType: string
  fee: string
  feeCcy: string
  fillFee: string
  fillFeeCcy: string
  fillFwdPx: string
  fillMarkPx: string
  fillMarkVol: string
  fillNotionalUsd: string
  fillPnl: string
  fillPx: string
  fillPxUsd: string
  fillPxVol: string
  fillSz: string
  fillTime: string
  instId: string
  instType: string
  lastPx: string
  lever: string
  msg: string
  notionalUsd: string
  ordId: string
  ordType: string
  pnl: string
  posSide: string
  px: string
  pxType: string
  pxUsd: string
  pxVol: string
  quickMgnType: string
  rebate: string
  rebateCcy: string
  reduceOnly: string
  reqId: string
  side: string
  slOrdPx: string
  slTriggerPx: string
  slTriggerPxType: string
  source: string
  state: string
  stpId: string
  stpMode: string
  sz: string
  tag: string
  tdMode: string
  tgtCcy: string
  tpOrdPx: string
  tpTriggerPx: string
  tpTriggerPxType: string
  tradeId: string
  uTime: string
}

export type BybitOutboundAccountInfo = {
  id: string
  topic: string
  creationTime: string
  data: {
    accountIMRate: string
    accountMMRate: string
    totalEquity: string
    totalWalletBalance: string
    totalMarginBalance: string
    totalAvailableBalance: string
    totalPerpUPL: string
    totalInitialMargin: string
    totalMaintenanceMargin: string
    coin: {
      coin: string
      equity: string
      usdValue: string
      walletBalance: string
      availableToWithdraw: string
      availableToBorrow: string
      borrowAmount: string
      accruedInterest: string
      totalOrderIM: string
      totalPositionIM: string
      totalPositionMM: string
      unrealisedPnl: string
      cumRealisedPnl: string
      bonus: string
      collateralSwitch: boolean
      marginCollateral: boolean
      locked: string
      free: string
    }[]
    accountLTV: string
    accountType: 'CONTRACT' | 'UNIFIED' | 'SPOT'
  }[]
}

export type PaperOutboundAccountInfo = PaperBalance

export type PaperBalance = {
  balance: { asset: string; free: number; locked: number }[]
}

const hyperliquidExpirableMap = new ExpirableMap<string, hl.Fill[]>(
  5 * 60 * 60 * 1000,
  true,
)

class UserConnector {
  private redisSet = RedisClient.getInstance()
  private redis = RedisClient.getInstance()
  private rabbit = new Rabbit()
  private testMode: boolean
  /** Array of users for whom binance stream are opened */
  private users: User[]
  private subscribersMap: Map<string, number> = new Map()
  /** Binance errors */
  private binanceErrors: Map<string, number> = new Map()
  /** Bitget errors */
  private bitgetErrors: Map<string, Map<string, number>> = new Map()
  /** Bybit errors */
  private bybitErrors: Map<string, Map<string, number>> = new Map()
  /** OKX errors */
  private okxErrors: Map<string, Map<string, number>> = new Map()
  /** Coinbase errors */
  private coinbaseErrors: Map<string, Map<string, number>> = new Map()
  /** Kucoin errors */
  private kucoinErrors: Map<string, number> = new Map()
  private kucoinSymbols: { coinm: KucoinSymbol[]; usdm: KucoinSymbol[] } = {
    coinm: [],
    usdm: [],
  }
  private subscribeMsgsMap: Map<string, OpenStreamInput> = new Map()
  /** Constructor method
   * Determine class variables
   * Start server
   * Set callback to open stream event
   * Set call back to close stream event
   * @returns {UserConnector} self
   * @public
   */
  constructor(testMode = false) {
    /** Determine class varibales */
    this.testMode = testMode
    this.users = []
    this.openStreamCallback = this.openStreamCallback.bind(this)
    this.closeStreamCallback = this.closeStreamCallback.bind(this)

    if (!testMode) {
      this.setupRabbit()
      this.redis?.publish(
        serviceLogRedis,
        JSON.stringify({ restart: 'userStream' }),
      )
    }
  }

  private setupRabbit() {
    this.rabbit?.listenWithCallback<
      | { event: 'open stream'; data: OpenStreamInput; uuid: string }
      | { event: 'close stream'; uuid: string }
    >(
      rabbitUsersStreamKey,
      (msg) => {
        if (msg.event === 'open stream') {
          this.openStreamCallback(msg.data, msg.uuid)
        }
        if (msg.event === 'close stream') {
          this.closeStreamCallback(msg.uuid)
        }
      },
      0,
    )
  }

  /** Logger
   * log any message with adding date
   * @param {Socket} socket socket instance
   * @param {any} msg message to log
   * @param {boolean} [err=false] log as error or default
   * @returns {void}
   * @private
   */
  private logger(msg: any, err = false) {
    if (err) {
      return logger.error(msg)
    }
    return logger.info(msg)
  }

  get OKXEnv() {
    return process.env.ENVOKX === 'sandbox' ? 'demo' : 'prod'
  }

  /** Save user to array
   * Filter array to exclude new data
   * Push new data
   * @param {User} user object of user data, that need to be saved
   * @returns {void}
   * @private
   */
  private saveUser(user: User) {
    this.users = this.users.filter((us) => us.id !== user.id)
    this.users.push(user)
  }

  @IdMute(mutex, () => `closeStreamBybit`)
  private async closeBybitConnection(client: BybitClient) {
    client.closeAll(true)
    client.on('exception', () => null)
    client.on('update', () => null)
  }

  @IdMute(mutex, () => `closeStreamBitget`)
  private async closeBitgetConnection(client: BitgetClient) {
    client.closeAll(true)
    client.on('exception', () => null)
    client.on('update', () => null)
  }

  /** Open stream callback
   * Check if stream for this user is already opened
   * If not - try open, catch and emit error
   * If exist, check if bot exist in subscriber
   * If not - add to subscribers and to socket room
   * Emit successful message
   * @param {Socket} socket socket instance
   * @param {OpenStreamInput} msg data from bot
   * @returns {void}
   * @private
   */
  @IdMute(
    mutex,
    (msg: OpenStreamInput) =>
      `openStream${
        msg?.api?.provider
          ? msg.api.provider.startsWith('bybit')
            ? 'bybit'
            : msg.api.provider.startsWith('okx')
              ? 'okx'
              : msg.api.provider.startsWith('binance')
                ? 'binance'
                : msg.api.provider.startsWith('bitget')
                  ? 'bitget'
                  : msg.api.provider.startsWith('kucoin')
                    ? 'kucoin'
                    : msg.api.provider.startsWith('hyperliquid')
                      ? 'hyperliquid'
                      : msg.api.provider
          : 'undefined'
      }`,
  )
  private async openStreamCallback(msg: OpenStreamInput, uuid?: string) {
    if (!msg || !msg.userId || !msg.api) {
      return this.logger('Not enough data', true)
    }
    if (!msg.api.provider) {
      return this.logger('Provider must be set', true)
    }
    if (
      !Object.values(ExchangeEnum)
        .filter((v) => isNaN(+v))
        .includes(msg.api.provider)
    ) {
      return this.logger(
        'Socket only supports Binance(US), Kucoin, FTX(US), ByBit, OKX, Bitget, Coinbase and MEXC',
        true,
      )
    }
    const { userId, api } = msg
    api.key = (api.key ?? '').trim()
    api.secret = (api.secret ?? '').trim()
    if (api.passphrase) {
      api.passphrase = (api.passphrase ?? '').trim()
    }
    const id =
      uuid ??
      crypto
        .createHash('sha1')
        .update(
          `${userId}${api.key}${api.secret}${api.provider}${api.passphrase}${api.keysType}${api.okxSource}`,
        )
        .digest('hex')
    let findUser = this.users.find((user) => user.id === id)
    if (!findUser) {
      findUser = {
        pending: true,
        close: () => null,
        timer: null,
        id,
        provider: msg.api.provider,
      }
      this.saveUser(findUser)
    } else if (findUser && findUser.pending) {
      this.logger(`waiting for 500ms to process ${api.provider}`)
      findUser.timer = setTimeout(async () => {
        const findUser = this.users.find((user) => user.id === id)
        if (findUser) {
          findUser.timer = null
          this.users = this.users.filter((user) => user.id !== id)
          this.users.push(findUser)
        }
        await this.openStreamCallback(msg, uuid)
      }, 500)
      return
    }

    const find = this.subscribersMap.get(id)

    /** Does this user id exist already in opened streams */
    if (!find) {
      /** User do not exist in users array */
      if (
        [
          ExchangeEnum.binance,
          ExchangeEnum.binanceUS,
          ExchangeEnum.binanceCoinm,
          ExchangeEnum.binanceUsdm,
        ].includes(api.provider)
      ) {
        const useWebsocketAPI =
          api.provider === ExchangeEnum.binance &&
          api.secret.includes('PRIVATE KEY') &&
          !api.secret.includes('RSA PRIVATE KEY')
        /** New exchange instance */
        let client: WebsocketClient
        let startMethod: () => Promise<void> = async () => {
          let result: WebSocket | undefined
          if (
            [ExchangeEnum.binance, ExchangeEnum.binanceUS].includes(
              api.provider,
            )
          ) {
            //@ts-ignore
            result = await client.subscribeSpotUserDataStream()
          }
          if (api.provider === ExchangeEnum.binanceUsdm) {
            //@ts-ignore
            result = await client.subscribeUsdFuturesUserDataStream()
          }
          if (api.provider === ExchangeEnum.binanceCoinm) {
            //@ts-ignore
            result = await client.subscribeCoinFuturesUserDataStream()
          }
          if (!result) {
            await sleep(1000)
            throw new Error('Connection not created')
          }
        }
        let stopMethod: () => Promise<void> = async () => {
          client.closeAll(false)
          //@ts-ignore
          client.respawnUserDataStream = (...args: unknown[]) =>
            new Promise((resolve) => resolve)
        }
        api.secret = (api.secret ?? '')
          .replace(
            /-----BEGIN PRIVATE KEY----- /g,
            '-----BEGIN PRIVATE KEY-----\n',
          )
          .replace(/ -----END PRIVATE KEY-----/g, '\n-----END PRIVATE KEY-----')
        if (api.provider === ExchangeEnum.binanceUS) {
          client = new WebsocketClient(
            {
              api_key: api.key,
              api_secret: api.secret,
              restOptions: {
                baseUrl: 'https://api.binance.us',
              },
              wsUrl: 'wss://stream.binance.us:9443/ws',
            },
            wsLoggerOptions,
          )
        } else {
          if (useWebsocketAPI) {
            const wsAPI = new WebsocketAPIClient(
              {
                api_key: api.key,
                api_secret: api.secret,
              },
              wsLoggerOptions,
            )

            client = wsAPI.getWSClient()
            startMethod = async () => {
              await wsAPI.subscribeUserDataStream('mainWSAPI')
            }
            stopMethod = async () => {
              wsAPI.unsubscribeUserDataStream('mainWSAPI')
              //@ts-ignore
              client.respawnUserDataStream = (...args: unknown[]) =>
                new Promise((resolve) => resolve)
            }
          } else {
            client = new WebsocketClient(
              {
                api_key: api.key,
                api_secret: api.secret,
              },
              wsLoggerOptions,
            )
          }
        }
        if (!useWebsocketAPI && api.provider === ExchangeEnum.binance) {
          startMethod = async () => {
            throw new Error(
              `Support of legacy subscribed is dropped for binance, please use websocket API key to avoid connection issues`,
            )
          }
        }

        client.removeAllListeners('open')
        client.removeAllListeners('reconnecting')
        client.removeAllListeners('reconnected')
        client.removeAllListeners('authenticated')
        client.removeAllListeners('exception')
        client.on('message', (data: any) => {
          if (
            [ExchangeEnum.binance, ExchangeEnum.binanceUS].includes(
              api.provider,
            )
          ) {
            this.userStreamEvent(id, convert(data) as UserDataStreamEvent)
          } else {
            this.userStreamEvent(
              id,
              convertFutures(data) as UserDataStreamEvent,
            )
          }
        }) // notification when a connection is opened
        client.on('open', (data) => {
          this.logger(
            //@ts-ignore
            `${id} connection opened open: ${data.wsKey} ${data.wsUrl} ${api.provider}`,
          )
        })
        // receive notification when a ws connection is reconnecting automatically
        client.on('reconnecting', (data) => {
          this.logger(
            `${id} ws automatically reconnecting ${data.wsKey} ${api.provider}`,
          )
        }) // receive notification that a reconnection completed successfully (e.g use REST to check for missing data)
        client.on('reconnected', (data) => {
          this.logger(`${id} ws has reconnected ${data.wsKey}  ${api.provider}`)
        })
        client.on('close', (data) => {
          this.logger(`${id} ws has closed ${data.wsKey} ${api.provider}`)
        })

        // Recommended: receive error events (e.g. first reconnection failed)
        client.on('exception', async (data) => {
          let errorMsg = ''
          try {
            errorMsg = JSON.stringify(data)
          } catch {
            errorMsg = `error stringifying errorMsg ${data}`
          }
          this.logger(
            `${id} ${userId} ws saw error ${data?.wsKey} ${errorMsg} ${api.provider}`,
            true,
          )
          this.binanceErrors.set(id, (this.binanceErrors.get(id) ?? 0) + 1)
          if ((this.binanceErrors.get(id) ?? 0) >= 2) {
            await stopMethod()
            this.users = this.users.filter((u) => u.id !== id)
            await sleep(5000)

            const get = this.subscribersMap.get(id)
            this.subscribersMap.delete(id)
            if (get) {
              ;[...Array(get)].forEach(() => this.openStreamCallback(msg, uuid))
            }

            this.binanceErrors.delete(id)
            this.logger(`restart connection ${data.wsKey} ${api.provider}`)
          }
        })
        /** Open stream and set callback  */
        try {
          await startMethod()

          /** Save user id and close function in users array */
          findUser = { ...findUser, close: stopMethod }

          this.subscribersMap.set(id, (this.subscribersMap.get(id) ?? 0) + 1)

          /** Log stream created for user */
          this.logger(
            `Stream for ${userId} room ${id} was successfully created (${msg.api.provider}) ${api.provider}`,
          )
          /** Log bot subscribed to the user */
          this.logger(
            `Was subscribed to the user ${userId} room ${id} ${api.provider}`,
          )
          await sleep(1000)
        } catch (err) {
          findUser = { ...findUser, pending: false }
          this.saveUser(findUser)
          return this.logger(
            `${id} ${userId} ${(err as Error).message || JSON.stringify(err)} ${api.provider}`,
            true,
          )
        }
      }
      if (
        [
          ExchangeEnum.kucoin,
          ExchangeEnum.kucoinLinear,
          ExchangeEnum.kucoinInverse,
        ].includes(api.provider)
      ) {
        if (
          (api.provider === ExchangeEnum.kucoinInverse &&
            !this.kucoinSymbols.coinm.length) ||
          (api.provider === ExchangeEnum.kucoinLinear &&
            !this.kucoinSymbols.usdm.length)
        ) {
          this.kucoinSymbols = await getKucoinSymbolsByMarket()
        }
        /** New exchange instance */
        const client = new KucoinApi({
          key: api.key,
          secret: api.secret,
          passphrase: api.passphrase,
        })
        /** Open stream and set callback  */
        try {
          const handleError = async (msgKucoin: string) => {
            this.logger(`Kucoin error: ${msgKucoin} | ${id}`, true)
            if (
              msgKucoin.indexOf('Kucoin WS closed') !== -1 ||
              msgKucoin.indexOf('Ping error') !== -1
            ) {
              this.kucoinErrors.set(id, (this.kucoinErrors.get(id) ?? 0) + 1)
              if ((this.kucoinErrors.get(id) ?? 0) >= 10) {
                this.logger(
                  `${this.kucoinErrors.get(id) ?? 0} kucoin errors  ${id}`,
                  true,
                )

                const user = this.users.find((u) => u.id === id)
                if (user?.close) {
                  user.close()
                  client.onError = false
                }
                this.users = this.users.filter((u) => u.id !== id)
                await sleep(5000)

                const get = this.subscribersMap.get(id)
                this.subscribersMap.delete(id)
                if (get) {
                  ;[...Array(get)].forEach(() =>
                    this.openStreamCallback(msg, uuid),
                  )
                }

                this.kucoinErrors.delete(id)
                this.logger(`Restart due to Kucoin error ${id}`, true)
              }
            }
          }
          const futures = [
            ExchangeEnum.kucoinInverse,
            ExchangeEnum.kucoinLinear,
          ].includes(api.provider)
          const closeOrder = futures
            ? await client.ws().futuresOrder((streamMsg) => {
                const symbols =
                  api.provider === ExchangeEnum.kucoinInverse
                    ? this.kucoinSymbols.coinm.map((s) => s.symbol)
                    : this.kucoinSymbols.usdm.map((s) => s.symbol)
                const symbol = convertSymbol(streamMsg.symbol)
                if (symbols.includes(symbol)) {
                  this.userStreamEvent(id, {
                    ...streamMsg,
                    creationTime: streamMsg.eventTime || +new Date(),
                    newClientOrderId: streamMsg.newClientOrderId || '',
                    orderStatus: streamMsg.orderStatus as OrderStatus_LT,
                    orderType: streamMsg.orderType as FuturesOrderType_LT,
                    originalClientOrderId:
                      streamMsg.originalClientOrderId || null,
                    quantity: streamMsg.quantity || '0',
                    side: streamMsg.side as OrderSide_LT,
                    symbol,
                    uniqueMessageId: `${streamMsg.eventTime}${streamMsg.eventType}${streamMsg.orderStatus}${streamMsg.newClientOrderId}${streamMsg.price}${streamMsg.quantity}`,
                  })
                }
              }, handleError)
            : await client.ws().order((streamMsg) => {
                this.userStreamEvent(id, {
                  ...streamMsg,
                  creationTime: streamMsg.eventTime || +new Date(),
                  newClientOrderId: streamMsg.newClientOrderId || '',
                  orderStatus: streamMsg.orderStatus as OrderStatus_LT,
                  orderType: streamMsg.orderType as FuturesOrderType_LT,
                  originalClientOrderId:
                    streamMsg.originalClientOrderId || null,
                  quantity: streamMsg.quantity || '0',
                  side: streamMsg.side as OrderSide_LT,
                  uniqueMessageId: `${streamMsg.eventTime}${streamMsg.eventType}${streamMsg.orderStatus}${streamMsg.newClientOrderId}${streamMsg.price}${streamMsg.quantity}`,
                })
              }, handleError)
          await sleep(200)
          const closeBalance = futures
            ? await client.ws().futuresBalance((streamMsg) => {
                const assets =
                  api.provider === ExchangeEnum.kucoinInverse
                    ? this.kucoinSymbols.coinm.map((s) => s.asset)
                    : this.kucoinSymbols.usdm.map((s) => s.asset)
                const balances = streamMsg.balances
                  .map((b) => ({ ...b, asset: convertSymbol(b.asset) }))
                  .filter((b) => assets.includes(b.asset))
                if (!balances.length) {
                  return
                }
                this.userStreamEvent(id, {
                  ...streamMsg,
                  balances: balances,
                  uniqueMessageId: `${streamMsg.eventType}${streamMsg.eventTime}${streamMsg.lastAccountUpdate}${streamMsg.balances[0]?.asset}${streamMsg.balances[0]?.free}${streamMsg.balances[0]?.locked}`,
                })
              }, handleError)
            : await client.ws().balance((streamMsg) => {
                this.userStreamEvent(id, {
                  ...streamMsg,
                  uniqueMessageId: `${streamMsg.eventType}${streamMsg.eventTime}${streamMsg.lastAccountUpdate}${streamMsg.balances[0]?.asset}${streamMsg.balances[0]?.free}${streamMsg.balances[0]?.locked}`,
                })
              }, handleError)
          const symbols =
            api.provider === ExchangeEnum.kucoinInverse
              ? this.kucoinSymbols.coinm.map((s) => s.symbol)
              : this.kucoinSymbols.usdm.map((s) => s.symbol)
          await sleep(200)
          const closePositions = futures
            ? await client.ws().futuresPositions(
                symbols.map((s) => convertSymbolToKucoin(s)),
                (streamMsg) => {
                  const symbol = convertSymbol(streamMsg.symbol)
                  if (symbols.includes(symbol)) {
                    const order: ExecutionReport = {
                      creationTime: streamMsg.currentTimestamp,
                      eventTime: streamMsg.currentTimestamp,
                      eventType: 'executionReport',
                      newClientOrderId: `${+new Date()}${symbol}${Math.random()}`,
                      orderId: '-1',
                      orderStatus: 'FILLED',
                      orderTime: streamMsg.currentTimestamp,
                      orderType: 'MARKET',
                      originalClientOrderId: `${+new Date()}${symbol}${Math.random()}`,
                      price: `${streamMsg.markPrice}`,
                      quantity: `${streamMsg.currentCost}`,
                      side: streamMsg.currentCost > 0 ? 'SELL' : 'BUY',
                      symbol,
                      totalQuoteTradeQuantity: `${streamMsg.currentCost}`,
                      totalTradeQuantity: `${streamMsg.currentCost}`,
                      liquidation: true,
                    }
                    logger.info(`${api.provider}|${JSON.stringify(streamMsg)}`)
                    this.userStreamEvent(id, {
                      ...order,
                      uniqueMessageId: `${api.provider}|${JSON.stringify(
                        order,
                      )}`,
                    })
                  }
                },
              )
            : () => void null
          const close = () => {
            closeOrder().then(closeBalance).then(closePositions)
          }
          /** Save user id and close function in users array */
          findUser = { ...findUser, close }

          this.subscribersMap.set(id, (this.subscribersMap.get(id) ?? 0) + 1)

          /** Log stream created for user */
          this.logger(
            `Stream for ${userId} room ${id} was successfully created (${msg.api.provider}) ${api.provider}`,
          )
          /** Log bot subscribed to the user */
          this.logger(
            `Was subscribed to the user ${userId} room ${id} ${api.provider}`,
          )
        } catch (err) {
          findUser = { ...findUser, pending: false }
          this.saveUser(findUser)
          return this.logger(
            `${id} ${userId} ${(err as Error).message} ${api.provider}`,
            true,
          )
        }
      }
      if (
        [
          ExchangeEnum.bybit,
          ExchangeEnum.bybitCoinm,
          ExchangeEnum.bybitUsdm,
        ].includes(api.provider)
      ) {
        /** Open stream and set callback  */
        try {
          const wsUrl =
            bybitHostMap[api.bybitHost || BybitHost.com] ||
            bybitHostMap[BybitHost.com]
          const baseUrl =
            bybitHostAPIMap[api.bybitHost || BybitHost.com] ||
            bybitHostAPIMap[BybitHost.com]
          /** New exchange instance */
          const client = new BybitClient(
            {
              market: 'v5',
              key: api.key,
              secret: api.secret,
              testnet: api.environment === 'sandbox',
              sleepTimeout: 650,
              pongTimeout: 20000,
              pingInterval: 20000,
              reconnectTimeout: 2000,
              wsUrl,
            },
            {
              trace: () => null,
              info: (...msg) => {
                if (msg[0] === 'Websocket reconnected') {
                  this.redis?.publish(
                    `userStreamInfo${id}`,
                    `Subscribed to user ${id}`,
                  )
                }
                this.logger(
                  `${id} ${userId} bybit info log ${JSON.stringify({
                    msg: msg?.[0],
                  })} ${api.provider}`,
                )
              },
              error: (...msg) =>
                this.logger(
                  `${id} ${userId} bybit error log ${JSON.stringify({
                    msg: msg?.[0],
                  })} ${api.provider}`,
                ),
            },
          )
          const type = await new RestClientV5({
            key: api.key,
            secret: api.secret,
            baseUrl,
          })
            .getAccountInfo()
            .then((r) => {
              const account = r?.result?.unifiedMarginStatus
              if (typeof account === 'undefined') {
                try {
                  console.error(
                    'Bybit getAccountInfo undefined',
                    JSON.stringify(r),
                    api.provider,
                    baseUrl,
                    wsUrl,
                    userId,
                    id,
                  )
                } catch {
                  try {
                    console.error(
                      'Bybit getAccountInfo undefined, and error stringifying response',
                      r,
                      api.provider,
                      baseUrl,
                      wsUrl,
                      userId,
                      id,
                    )
                  } catch {
                    console.error(
                      'Bybit getAccountInfo undefined, and error stringifying response',
                      api.provider,
                      baseUrl,
                      wsUrl,
                      userId,
                      id,
                    )
                  }
                }
              }
              if (
                r.retMsg === 'API key is invalid.' ||
                r.retMsg === 'Your api key has expired.' ||
                r.retMsg.includes('Error sign')
              ) {
                throw new Error(
                  `Request not authorized ${api.key} ${api.secret} ${api.provider} ${baseUrl} ${wsUrl}`,
                )
              }
              return account
            })
            .catch((e) => {
              if (e?.message?.includes('Request not authorized')) {
                throw e
              }
              return (this.logger(`Error gettings account type ${e}`, true), 0)
            })
          this.logger(
            `${id} ${userId} bybit getting account type ${type} ${api.provider}`,
          )
          const category =
            api.provider === ExchangeEnum.bybit
              ? 'spot'
              : api.provider === ExchangeEnum.bybitCoinm
                ? 'inverse'
                : 'linear'
          client.subscribeV5(['wallet', 'order'], category, true)
          client.on('update', (msg) => {
            if (msg.topic === 'order') {
              const orders = this.prepareBybitOrderMsg(msg, category)
              orders.forEach((o) => this.userStreamEvent(id, o))
            }
            if (msg.topic === 'wallet') {
              const convertedMessage = this.prepareBybitOutboundAccountInfo(
                msg,
                category,
                type >= 5,
              )
              if (convertedMessage) {
                this.userStreamEvent(id, convertedMessage)
              }
            }
          })
          client.on('reconnected', () => {
            this.redis?.publish(
              `userStreamInfo${id}`,
              `Subscribed to user ${id}`,
            )
          })
          const close = () => {
            this.closeBybitConnection(client)
          }
          client.on('exception', async (error: Error | string) => {
            const message = typeof error !== 'string' ? error.message : error
            let m = `${message}`
            try {
              m = message ?? JSON.stringify(error)
              this.logger(
                `${id} ${userId} bybit error ${m} ${api.provider} ${api.bybitHost} ${wsUrl}`,
                true,
              )
            } catch {
              m = message ?? error
              this.logger(
                `${id} ${userId} bybit error ${m} ${api.provider} ${api.bybitHost} ${wsUrl}`,
                true,
              )
            }
            const apiError = m.indexOf('Request not authorized') !== -1
            const getById =
              this.bybitErrors.get(id) ?? new Map<string, number>()
            getById.set(message, (getById.get(message) ?? 0) + 1)
            this.bybitErrors.set(id, getById)
            if ((getById.get(id) ?? 0) >= 10 || apiError) {
              close()
              const user = this.users.find((u) => u.id === id)
              if (user?.close) {
                user.close()
              }
              this.users = this.users.filter((u) => u.id !== id)
              await sleep(30000)

              const get = this.subscribersMap.get(id)
              this.subscribersMap.delete(id)
              if (get && !apiError) {
                ;[...Array(get)].forEach(() =>
                  this.openStreamCallback(msg, uuid),
                )
              }

              this.bybitErrors.delete(id)
              if (!apiError) {
                this.logger(`restart connection ${id} ${api.provider}`)
              } else {
                this.logger(
                  `catch api keys error, will close connection ${id} ${api.provider}`,
                )
              }
            }
          })
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              this.logger(
                `Bybit connection timeout ${id} ${api.provider}`,
                true,
              )
              reject()
            }, 60 * 1000)
            client.once('open', () => {
              clearTimeout(timer)
              resolve()
            })
            client.once('error', () => {
              clearTimeout(timer)
              reject(`Bybit connection timeout ${id} ${api.provider}`)
            })
          })

          /** Save user id and close function in users array */
          findUser = { ...findUser, close }

          this.subscribersMap.set(id, (this.subscribersMap.get(id) ?? 0) + 1)

          /** Log stream created for user */
          this.logger(
            `Stream for ${userId} room ${id} was successfully created ${api.provider}`,
          )
          /** Log bot subscribed to the user */
          this.logger(
            `Was subscribed to the user ${userId} room ${id} ${api.provider}`,
          )
          await sleep(2000)
        } catch (err) {
          /** Catch error, emit error to socket */

          findUser = { ...findUser, pending: false }
          this.saveUser(findUser)
          return this.logger(
            `${(err as Error)?.message ?? err} ${api.provider}`,
            true,
          )
        }
      }
      if (
        [
          ExchangeEnum.okx,
          ExchangeEnum.okxInverse,
          ExchangeEnum.okxLinear,
        ].includes(api.provider)
      ) {
        /** Open stream and set callback  */
        try {
          /** New exchange instance */
          const client = new OKXClient(
            {
              accounts: [
                {
                  apiKey: api.key,
                  apiSecret: api.secret,
                  apiPass: api.passphrase ?? '',
                },
              ],
              market: this.OKXEnv,
              wsUrl:
                api.okxSource === OKXSource.my
                  ? 'wss://wseea.okx.com:8443/ws/v5/private'
                  : api.okxSource === OKXSource.app
                    ? 'wss://wsus.okx.com:8443/ws/v5/private'
                    : undefined,
            },
            {
              silly: () => null,
              debug: () => null,
              notice: () => null,
              info: () => null,
              warning: () => null,
              error: () => null,
            },
          )
          const instType: WsChannelArgInstType =
            api.provider === ExchangeEnum.okx ? 'SPOT' : 'SWAP'
          const subscriptions = [
            {
              channel: 'account',
              extraParams: `
                {
                "updateInterval": "0"
                }
                `,
            },
            { channel: 'orders', instType },
          ]
          //@ts-ignore
          client.subscribe(subscriptions)
          client.on('update', (msg) => {
            if (msg.arg.channel === 'account') {
              const convertedMessage = this.prepareOkxOutboundAccountInfo(
                msg?.data[0],
              )
              if (convertedMessage) {
                this.userStreamEvent(id, convertedMessage)
              }
            }
            //@ts-ignore
            if (msg.arg.channel === 'orders' && msg.arg.instType === instType) {
              const orders = this.prepareOkxOrderMsg(msg.data, instType)
              orders.forEach((o) => this.userStreamEvent(id, o))
            }
          })
          const stopErrors = [
            '50100',
            '50101',
            '50103',
            '50104',
            '50105',
            '50106',
            '50107',
            '50108',
            '50109',
            '50110',
            '50111',
            '50112',
            '50113',
            '50114',
            '50115',
            '50118',
            '50119',
            '50120',
            '50121',
            '60024',
            '60032',
          ]
          const close = () => {
            //@ts-ignore
            client.unsubscribe(subscriptions)
          }
          client.on(
            'error',
            async (
              error:
                | {
                    event: 'error'
                    msg: string
                    code: string
                    connId: string
                    wsKey: string
                  }
                | string,
            ) => {
              const message = typeof error !== 'string' ? error.msg : error
              try {
                this.logger(
                  `${id} ${userId} okx error ${
                    message ?? JSON.stringify(error)
                  } ${api.provider}`,
                  true,
                )
              } catch {
                this.logger(
                  `${id} ${userId} okx error ${message ?? error} ${
                    api.provider
                  }`,
                  true,
                )
              }
              if (
                stopErrors.includes(
                  typeof error !== 'string' ? (error.code ?? '') : '',
                ) ||
                `${message || error}` === 'Invalid apiKey'
              ) {
                client.closeAll(false)
                this.users = this.users.filter((u) => u.id !== id)
                return
              }
              const getById =
                this.okxErrors.get(id) ?? new Map<string, number>()
              getById.set(message, (getById.get(message) ?? 0) + 1)
              this.okxErrors.set(id, getById)

              if ((getById.get(id) ?? 0) >= 10) {
                client.closeAll(false)
                const user = this.users.find((u) => u.id === id)
                if (user?.close) {
                  user.close()
                }
                await sleep(10000)

                const get = this.subscribersMap.get(id)
                this.subscribersMap.delete(id)
                if (get) {
                  ;[...Array(get)].forEach(() =>
                    this.openStreamCallback(msg, uuid),
                  )
                }

                this.okxErrors.delete(id)
                this.logger(`restart connection ${id} ${api.provider}`)
              }
            },
          )

          /** Save user id and close function in users array */
          findUser = { ...findUser, close }

          this.subscribersMap.set(id, (this.subscribersMap.get(id) ?? 0) + 1)

          /** Log stream created for user */
          this.logger(
            `Stream for ${userId} room ${id} was successfully created ${api.provider}`,
          )
          /** Log bot subscribed to the user */
          this.logger(
            `Was subscribed to the user ${userId} room ${id} ${api.provider}`,
          )
          await sleep(650)
        } catch (err) {
          findUser = { ...findUser, pending: false }
          this.saveUser(findUser)
          return this.logger(`${(err as Error).message} ${api.provider}`, true)
        }
      }
      if (api.provider === ExchangeEnum.coinbase) {
        /** New exchange instance */
        const client = new Coinbase(
          api.keysType === CoinbaseKeysType.cloud
            ? { cloudApiKeyName: api.key, cloudApiSecret: api.secret }
            : {
                apiKey: api.key,
                apiSecret: api.secret,
              },
        )
        /** Open stream and set callback  */
        try {
          const stopErrors = ['authentication failure']
          client.ws.on(WebSocketEvent.ON_OPEN, () => {
            client.ws.subscribe({ channel: WebSocketChannelName.USER })
          })
          client.ws.on(WebSocketEvent.ON_USER_UPDATE, (_msg) => {
            this.prepareCoinbaseOrderMsg(_msg).forEach((m) =>
              this.userStreamEvent(id, m),
            )
          })
          const close = () => {
            try {
              client.ws.unsubscribe({
                channel: WebSocketChannelName.USER,
              })
              client.ws.disconnect()
            } catch (error) {
              logger.error('Error during disconnect:', error)
            }
          }
          client.ws.on(WebSocketEvent.ON_ERROR, async (_msg) => {
            const message = `${_msg.message}`
            this.logger(
              `${id} ${userId} coinbase error ${message} ${api.provider}`,
              true,
            )
            if (stopErrors.includes(_msg.message)) {
              close()
              this.users = this.users.filter((u) => u.id !== id)
              return
            }

            const getById =
              this.coinbaseErrors.get(id) ?? new Map<string, number>()
            getById.set(message, (getById.get(message) ?? 0) + 1)
            this.coinbaseErrors.set(id, getById)

            if ((getById.get(id) ?? 0) >= 10) {
              const user = this.users.find((u) => u.id === id)
              if (user?.close) {
                user.close()
              }
              this.users = this.users.filter((u) => u.id !== id)
              await sleep(10000)

              const get = this.subscribersMap.get(id)
              this.subscribersMap.delete(id)
              if (get) {
                ;[...Array(get)].forEach(() =>
                  this.openStreamCallback(msg, uuid),
                )
              }

              this.coinbaseErrors.delete(id)
              this.logger(`restart connection ${id} ${api.provider}`)
            }
          })

          client.ws.on(WebSocketEvent.ON_MESSAGE_ERROR, async (_msg) => {
            const message = `${_msg.message}: ${_msg.reason}`
            this.logger(
              `${id} ${userId} coinbase message error ${message} ${api.provider}`,
              true,
            )
            if (stopErrors.includes(_msg.message)) {
              close()
              this.users = this.users.filter((u) => u.id !== id)
              return
            }

            const getById =
              this.coinbaseErrors.get(id) ?? new Map<string, number>()
            getById.set(message, (getById.get(message) ?? 0) + 1)
            this.coinbaseErrors.set(id, getById)

            if ((getById.get(id) ?? 0) >= 10) {
              const user = this.users.find((u) => u.id === id)
              if (user?.close) {
                user.close()
              }
              this.users = this.users.filter((u) => u.id !== id)
              await sleep(10000)

              const get = this.subscribersMap.get(id)
              this.subscribersMap.delete(id)
              if (get) {
                ;[...Array(get)].forEach(() =>
                  this.openStreamCallback(msg, uuid),
                )
              }

              this.coinbaseErrors.delete(id)
              this.logger(`restart connection ${id} ${api.provider}`)
            }
          })
          client.ws.connect()

          /** Save user id and close function in users array */
          findUser = { ...findUser, close }
          this.subscribersMap.set(id, (this.subscribersMap.get(id) ?? 0) + 1)

          /** Log stream created for user */
          this.logger(
            `Stream for ${userId} room ${id} was successfully created (${msg.api.provider}) ${api.provider}`,
          )
          /** Log bot subscribed to the user */
          this.logger(
            `Was subscribed to the user ${userId} room ${id} ${api.provider}`,
          )
        } catch (err) {
          findUser = { ...findUser, pending: false }
          this.saveUser(findUser)
          return this.logger(
            `${id} ${userId} ${(err as Error).message} ${api.provider}`,
            true,
          )
        }
      }
      if (
        [
          ExchangeEnum.bitget,
          ExchangeEnum.bitgetCoinm,
          ExchangeEnum.bitgetUsdm,
        ].includes(api.provider)
      ) {
        /** Open stream and set callback  */
        try {
          /** New exchange instance */
          const client = new BitgetClient(
            {
              apiKey: api.key,
              apiPass: api.passphrase,
              apiSecret: api.secret,
            },
            {
              silly: () => null,
              debug: (...msg) =>
                this.logger(
                  `${id} ${userId} bitget debug log ${JSON.stringify({
                    msg,
                  })} ${api.provider}`,
                ),
              notice: (...msg) =>
                this.logger(
                  `${id} ${userId} bitget notice log ${JSON.stringify({
                    msg,
                  })} ${api.provider}`,
                ),
              info: (...msg) => {
                if (msg[0] === 'Websocket reconnected') {
                  this.redis?.publish(
                    `userStreamInfo${id}`,
                    `Subscribed to user ${id}`,
                  )
                }
                this.logger(
                  `${id} ${userId} bitget info log ${JSON.stringify({
                    msg: msg?.[0],
                  })} ${api.provider}`,
                )
              },
              warning: (...msg) =>
                this.logger(
                  `${id} ${userId} bitget warning log ${JSON.stringify({
                    msg: msg?.[0],
                  })} ${api.provider}`,
                ),
              error: (...msg) =>
                this.logger(
                  `${id} ${userId} bitget error log ${JSON.stringify({
                    msg: msg?.[0],
                  })} ${api.provider}`,
                ),
            },
          )
          const categories: BitgetInstTypeV2[] =
            api.provider === ExchangeEnum.bitget
              ? ['SPOT']
              : api.provider === ExchangeEnum.bitgetUsdm
                ? ['USDT-FUTURES', 'USDC-FUTURES']
                : ['COIN-FUTURES']
          for (const category of categories) {
            client.subscribeTopic(category, 'orders', 'default')
            await sleep(100)
            client.subscribeTopic(category, 'account', 'default')
            await sleep(100)
          }
          client.on('update', (msg) => {
            if (!categories.includes(msg.arg.instType)) {
              return
            }
            if (
              (msg.action === 'snapshot' || msg.action === 'update') &&
              msg.arg.channel === 'orders'
            ) {
              const orders = this.prepareBitgetOrderMsg(msg.data)
              orders.forEach((o) => this.userStreamEvent(id, o))
            }
            if (
              (msg.action === 'snapshot' || msg.action === 'update') &&
              msg.arg.channel === 'account'
            ) {
              const convertedMessage =
                msg.arg.instType === 'SPOT'
                  ? this.prepareBitgetSpotOutboundAccountInfo(
                      msg.data,
                      msg.ts,
                      uuid || userId,
                    )
                  : this.prepareBitgetFuturesOutboundAccountInfo(
                      msg.data,
                      msg.ts,
                      uuid || userId,
                    )
              if (convertedMessage) {
                this.userStreamEvent(id, convertedMessage)
              }
            }
          })
          client.on('reconnected', () => {
            this.redis?.publish(
              `userStreamInfo${id}`,
              `Subscribed to user ${id}`,
            )
          })
          const close = () => {
            this.closeBitgetConnection(client)
          }
          client.on('exception', async (error: Error | string) => {
            const message = typeof error !== 'string' ? error.message : error
            try {
              this.logger(
                `${id} ${userId} bitget error ${
                  message ?? JSON.stringify(error)
                } ${api.provider}`,
                true,
              )
            } catch {
              this.logger(
                `${id} ${userId} bitget error ${message ?? error} ${
                  api.provider
                }`,
                true,
              )
            }
            const getById =
              this.bitgetErrors.get(id) ?? new Map<string, number>()
            getById.set(message, (getById.get(message) ?? 0) + 1)
            this.bitgetErrors.set(id, getById)
            if ((getById.get(id) ?? 0) >= 10) {
              close()

              const user = this.users.find((u) => u.id === id)
              if (user?.close) {
                user.close()
              }
              this.users = this.users.filter((u) => u.id !== id)
              await sleep(30000)

              const get = this.subscribersMap.get(id)
              this.subscribersMap.delete(id)
              if (get) {
                ;[...Array(get)].forEach(() =>
                  this.openStreamCallback(msg, uuid),
                )
              }

              this.bitgetErrors.delete(id)
              this.logger(`restart connection ${id} ${api.provider}`)
            }
          })
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              this.logger(
                `Bitget connection timeout ${id} ${api.provider}`,
                true,
              )
              reject()
            }, 60 * 1000)
            client.once('open', () => {
              clearTimeout(timer)
              resolve()
            })
            client.once('exception', () => {
              clearTimeout(timer)
              reject()
            })
            client.once('error', () => {
              clearTimeout(timer)
              reject()
            })
          })

          /** Save user id and close function in users array */
          findUser = { ...findUser, close }

          this.subscribersMap.set(id, (this.subscribersMap.get(id) ?? 0) + 1)

          /** Log stream created for user */
          this.logger(
            `Stream for ${userId} room ${id} was successfully created ${api.provider}`,
          )
          /** Log bot subscribed to the user */
          this.logger(
            `Was subscribed to the user ${userId} room ${id} ${api.provider}`,
          )
          await sleep(2000)
        } catch (err) {
          findUser = { ...findUser, pending: false }
          this.saveUser(findUser)
          return this.logger(
            `${(err as Error)?.message ?? err} ${api.provider}`,
            true,
          )
        }
      }
      if (
        [ExchangeEnum.hyperliquid, ExchangeEnum.hyperliquidLinear].includes(
          api.provider,
        )
      ) {
        /** Open stream and set callback  */
        try {
          const transport = new hl.WebSocketTransport({
            url:
              process.env.HYPERLIQUIDENV === 'demo'
                ? 'wss://api.hyperliquid-testnet.xyz/ws'
                : 'wss://api.hyperliquid.xyz/ws',
            reconnect: {
              maxRetries: 100,
              connectionDelay: (attempt) =>
                Math.min((1 << attempt) * 150, 10000),
            },
          })
          transport.socket.onclose = (event) => {
            this.logger(`Hyperliquid closed: ${event.reason} ${id}`)
          }
          transport.socket.onerror = (event) => {
            this.logger(
              `Hyperliquid error: ${JSON.stringify(event)} ${id}`,
              true,
            )
          }
          transport.socket.onopen = () => {
            this.logger(`Hyperliquid connected ${id}`)
          }
          /** New exchange instance */
          const client = new hl.SubscriptionClient({
            transport,
          })

          const close = (
            await client.orderUpdates(
              { user: api.key as `0x${string}` },
              async (msg) =>
                (await this.prepareHyperliquidOrder(msg)).map((o) =>
                  this.userStreamEvent(id, o),
                ),
            )
          ).unsubscribe

          client.userFills({ user: api.key as `0x${string}` }, (data) => {
            if (data.isSnapshot) {
              return
            }
            for (const f of data.fills) {
              if (!f.cloid) {
                continue
              }
              const get = hyperliquidExpirableMap.get(f.cloid) ?? []
              get.push(f)
              hyperliquidExpirableMap.set(f.cloid, get)
            }
          })

          const closeFn = async () => {
            await close()
            transport.close()
          }

          /** Save user id and close function in users array */
          findUser = { ...findUser, close: closeFn }

          this.subscribersMap.set(id, (this.subscribersMap.get(id) ?? 0) + 1)

          /** Log stream created for user */
          this.logger(
            `Stream for ${userId} room ${id} was successfully created ${api.provider}`,
          )
          /** Log bot subscribed to the user */
          this.logger(
            `Was subscribed to the user ${userId} room ${id} ${api.provider}`,
          )
          await sleep(2000)
        } catch (err) {
          findUser = { ...findUser, pending: false }
          this.saveUser(findUser)
          return this.logger(
            `${(err as Error)?.message ?? err} ${api.provider}`,
            true,
          )
        }
      }
      if (paperExchanges.includes(api.provider)) {
        const exchange = mapPaperToReal(api.provider as PaperExchangeType)
        if (!exchange) {
          return
        }
        try {
          const cbOrder = (msg?: PaperOrderMessage) => {
            if (msg?.exchange !== exchange) {
              return
            }
            if (msg) {
              this.userStreamEvent(id, this.preparePaperOrderMsg(msg))
            }
          }
          const cbAccount = (msg?: PaperOutboundAccountInfo) => {
            if (!msg || !msg.balance) {
              return
            }
            if (msg) {
              this.userStreamEvent(
                id,
                this.preparePaperOutboundAccountInfo(msg),
              )
            }
          }
          const close = connectPaper(
            { key: api.key, secret: api.secret },
            cbOrder,
            cbAccount,
          )
          /** Save user id and close function in users array */
          findUser = { ...findUser, close }
          this.subscribersMap.set(id, (this.subscribersMap.get(id) ?? 0) + 1)

          /** Log stream created for user */
          this.logger(
            `Stream for ${userId} room ${id} was successfully created ${api.provider}`,
          )
          /** Log bot subscribed to the user */
          this.logger(
            `Was subscribed to the user ${userId} room ${id} ${api.provider}`,
          )
        } catch (err) {
          findUser = { ...findUser, pending: false }
          this.saveUser(findUser)
          return this.logger(`${(err as Error).message} ${api.provider}`, true)
        }
      }
    } else {
      this.logger(`User ${id} already exists`)
      this.subscribersMap.set(id, (this.subscribersMap.get(id) ?? 0) + 1)
    }
    findUser = { ...findUser, pending: false }
    this.saveUser(findUser)
    if (find) {
      return
    }
    this.subscribeMsgsMap.set(id, msg)
    const usersMap: Map<string, number> = new Map()
    this.users.forEach((u) => {
      usersMap.set(u.provider, (usersMap.get(u.provider) ?? 0) + 1)
    })
    logger.info(usersMap)

    if (!this.testMode) {
      return this.redis?.publish(
        `userStreamInfo${id}`,
        `Subscribed to user ${id}`,
      )
    } else {
      console.log(`Successfully subscribed to user stream: ${id}`)
    }
  }

  /** Test connection method for CLI usage
   * @param {Object} options - Connection options
   * @param {string} options.provider - Exchange provider
   * @param {string} options.key - API key
   * @param {string} options.secret - API secret
   * @param {string} [options.passphrase] - API passphrase (for exchanges that require it)
   * @param {string} [options.environment] - Environment (live/sandbox)
   * @param {string} [options.bybitHost] - Bybit host
   * @param {string} [options.keysType] - Coinbase keys type
   * @param {string} [options.okxSource] - OKX source
   * @returns {Promise<void>}
   * @public
   */
  public async testConnection(options: {
    provider: string
    key: string
    secret: string
    passphrase?: string
    environment?: 'live' | 'sandbox'
    bybitHost?: string
    keysType?: string
    okxSource?: string
  }): Promise<void> {
    if (!this.testMode) {
      throw new Error('testConnection can only be used in test mode')
    }

    console.log(`Testing connection to ${options.provider}...`)

    const testInput: OpenStreamInput = {
      userId: 'test-user',
      api: {
        key: options.key,
        secret: options.secret,
        provider: options.provider as ExchangeEnum,
        ...(options.passphrase && { passphrase: options.passphrase }),
        ...(options.environment && { environment: options.environment }),
        ...(options.bybitHost && { bybitHost: options.bybitHost as BybitHost }),
        ...(options.keysType && {
          keysType: options.keysType as CoinbaseKeysType,
        }),
        ...(options.okxSource && { okxSource: options.okxSource as OKXSource }),
      },
    }

    try {
      await this.openStreamCallback(testInput, 'test-connection-id')
      console.log(
        '✅ Connection test successful! Stream is active and receiving data.',
      )
      console.log('Press Ctrl+C to stop the test.')

      // Keep the process running to observe stream events
      process.on('SIGINT', () => {
        console.log('\n🛑 Stopping connection test...')
        this.closeStreamCallback('test-connection-id')
        process.exit(0)
      })
    } catch (error) {
      console.error('❌ Connection test failed:', error)
      throw error
    }
  }

  @IdMute(mutex, () => 'restartStreams')
  public async restartStreams() {
    let c = 0
    for (const user of this.users) {
      c++
      if (paperExchanges.includes(user.provider)) {
        continue
      }
      const count = this.subscribersMap.get(user.id) || 0
      const msg = this.subscribeMsgsMap.get(user.id)
      if (count && msg) {
        for (let i = 0; i < count; i++) {
          this.closeStreamCallback(user.id)
        }
        await sleep(250)
        for (let i = 0; i < count; i++) {
          await this.openStreamCallback(msg, undefined)
        }
        this.logger(
          `Restarted ${c} of ${this.users.length} ${user.id} ${msg.userId}`,
        )
      }
    }
  }

  /** Close stream callback
   * Check if bot subscribed to any user
   * If not - emit and log error
   * Remove bot from subcribers
   * Check if there any other subscriber to user
   * If not - close stream
   * @param {Socket} socket socket instance
   * @returns {void}
   * @private
   */
  private closeStreamCallback(uuid?: string) {
    if (uuid) {
      const find = this.subscribersMap.get(uuid)
      if (!find) {
        return this.logger(`${uuid} has no subscribers`, true)
      }
      const left = find - 1
      this.subscribersMap.set(uuid, left)
      if (!left) {
        const user = this.users.find((us) => us.id === uuid)
        /** Is user found */
        if (user) {
          /** Disconnect from user Binance stream */
          try {
            user.close()
          } catch (err) {
            /** Catch error and emit to bot */
            return this.logger(err, true)
          }
          /** Remove user id from users array */
          this.users = this.users.filter((user) => user.id !== uuid)
          /** Log bot unsubscribed from user */
          this.logger(`${uuid} unsubscribed event`)
          /** Log user stream closed */
          this.logger(`User ${uuid} stream was closed`)
        } else {
          return this.logger(`User ${uuid} not found`, true)
        }
      } else {
        this.logger(`${uuid} unsubscribed event`)
      }
      return
    }
  }

  /** Callback on user stream event from Binance
   * Retranslate stream message to user id room
   * @param {string} id id for current stream
   * @param {UserDataStreamEvent} streamMsg Binance stream message
   * @returns {void}
   * @private
   */
  private userStreamEvent(
    id: string,
    streamMsg: UserDataStreamEvent & { uniqueMessageId?: string },
  ) {
    if (!streamMsg) {
      return
    }
    logger.info(`msg ${streamMsg.uniqueMessageId}`)

    if (!this.testMode) {
      this.redis.publish(id, JSON.stringify(streamMsg))
    } else {
      console.log('Stream Event:', JSON.stringify(streamMsg, null, 2))
    }
    if (this.redisSet && !this.testMode) {
      const msg = streamMsg as any
      if (
        msg?.eventType === 'executionReport' ||
        msg?.eventType === 'ORDER_TRADE_UPDATE'
      ) {
        const id =
          msg.eventType === 'executionReport'
            ? msg.newClientOrderId || (msg.liquidation ? `liq_${v4()}` : '')
            : msg.id || (msg.liquidation ? `liq_${v4()}` : '')
        if (
          !msg.liquidation &&
          !id.includes('GRID-TP') &&
          !id.includes('GRIDTP') &&
          !id.includes('GRID-STAB') &&
          !id.includes('GRIDSTAB') &&
          !id.includes('GRID-BO') &&
          !id.includes('GRIDBO') &&
          !id.includes('GRID-RO') &&
          !id.includes('GRIDRO') &&
          !id.includes('GA-F') &&
          !id.includes('GAF') &&
          !id.includes('D-ROA') &&
          !id.includes('DROA') &&
          !id.includes('D-SR') &&
          !id.includes('DSR') &&
          !id.includes('D-BO') &&
          !id.includes('DBO') &&
          !id.includes('D-TP') &&
          !id.includes('DTP') &&
          !id.includes('D-MTP') &&
          !id.includes('DMTP') &&
          !id.includes('D-MSL') &&
          !id.includes('DMSL') &&
          !id.includes('D-RO') &&
          !id.includes('DRO') &&
          !id.includes('CMB-BO') &&
          !id.includes('CMBBO') &&
          !id.includes('CMB-GR') &&
          !id.includes('CMBGR') &&
          !id.includes('CMB-RO') &&
          !id.includes('CMBRO') &&
          !id.includes('CMB-H') &&
          !id.includes('CMBH') &&
          !id.startsWith('0x')
        ) {
          return
        }
        if (id) {
          this.redisSet
            .hSet('orders', id, JSON.stringify(msg))
            .then(
              () =>
                this.redisSet &&
                this.redisSet.hExpire(
                  'orders',
                  id,
                  msg?.orderStatus === 'NEW' ||
                    msg?.orderStatus === 'PARTIALLY_FILLED'
                    ? 24 * 60 * 60
                    : 5 * 60,
                ),
            )
        }
      }
    }
  }

  private clearSymbol(s: string) {
    return s.replace(/-SWAP$/, '')
  }

  private prepareOkxOrderMsg(
    msg?: OKXOrderMsg[],
    instType?: WsChannelArgInstType,
  ): ExecutionReport[] {
    if (!msg) {
      return []
    }

    return msg
      .filter((d) => d.instType === instType)
      .map((data) => {
        const symbol = this.clearSymbol(data.instId)
        return {
          creationTime: parseInt(data.cTime),
          eventTime: parseInt(data.uTime),
          eventType: 'executionReport',
          newClientOrderId: data.clOrdId,
          orderId: data.ordId,
          orderTime: parseInt(data.uTime),
          orderStatus:
            data.state === 'live'
              ? 'NEW'
              : data.state === 'partially_filled'
                ? 'PARTIALLY_FILLED'
                : data.state === 'filled'
                  ? 'FILLED'
                  : 'CANCELED',
          orderType: data.ordType === 'limit' ? 'LIMIT' : 'MARKET',
          originalClientOrderId: data.clOrdId,
          price: `${+data.avgPx || +data.px}`,
          quantity: data.sz,
          side: data.side === 'buy' ? 'BUY' : 'SELL',
          symbol,
          totalQuoteTradeQuantity: `${
            (+(data.avgPx ?? data.px) || +data.px) * +data.accFillSz
          }`,
          totalTradeQuantity: data.accFillSz,
          uniqueMessageId: `${data.instId}executionReport${data.uTime}${symbol}${data.state}${data.sz}${data.px}${data.accFillSz}${data.ordType}${data.clOrdId}${data.category}`,
          liquidation: data.category === 'full_liquidation',
        }
      })
  }

  private prepareCoinbaseOrderMsg(
    msg: WebsocketUserMessage,
  ): ExecutionReport[] {
    if (msg.sequence_num === 0) {
      return []
    }
    return msg.events
      .map((data) =>
        (data.orders ?? [])
          .filter((order) => order.status !== OrderStatus.PENDING)
          .map((order) => {
            const updateTime = +new Date(msg.timestamp)
            return {
              creationTime: +new Date(order.creation_time),
              eventTime: updateTime,
              eventType: 'executionReport' as const,
              newClientOrderId: order.client_order_id,
              orderId: order.order_id,
              orderTime: updateTime,
              orderStatus:
                order.status === OrderStatus.PENDING ||
                order.status === OrderStatus.OPEN
                  ? ('NEW' as const)
                  : order.status === OrderStatus.FILLED
                    ? ('FILLED' as const)
                    : ('CANCELED' as const),
              orderType:
                `${order.order_type}` === 'Limit'
                  ? ('LIMIT' as const)
                  : ('MARKET' as const),
              originalClientOrderId: order.client_order_id,
              price: order.avg_price,
              quantity: order.cumulative_quantity,
              side:
                order.order_side === OrderSide.BUY
                  ? ('BUY' as const)
                  : ('SELL' as const),
              symbol: order.product_id,
              totalQuoteTradeQuantity: '',
              totalTradeQuantity: order.cumulative_quantity,
              uniqueMessageId: `${Object.entries(order)
                .map(([k, v]) => `${k}:${v}`)
                .join(',')}`,
            }
          }),
      )
      .flat()
  }

  private prepareBybitOrderMsg(
    msg: BybitOrderMessage,
    category: CategoryV5,
  ): ExecutionReport[] {
    return msg.data
      .filter((d) => d.category === category)
      .map((data) => ({
        creationTime: parseInt(data.createdTime),
        eventTime: parseInt(data.updatedTime),
        eventType: 'executionReport',
        newClientOrderId: data.orderLinkId,
        orderId: data.orderId,
        orderTime: parseInt(data.updatedTime),
        orderStatus: (() => {
          const { orderStatus } = data
          if (['New', 'Created'].includes(orderStatus)) {
            return 'NEW'
          }
          if (orderStatus === 'PartiallyFilled') {
            return 'PARTIALLY_FILLED'
          }
          if (orderStatus === 'Filled') {
            return 'FILLED'
          }
          return 'CANCELED'
        })(),
        orderType: data.orderType === 'Limit' ? 'LIMIT' : 'MARKET',
        originalClientOrderId: data.orderLinkId,
        price:
          data.orderType === 'Market' && data.avgPrice
            ? `${+data.avgPrice || +data.price}`
            : data.price === '0' && data.cumExecQty !== '0'
              ? `${
                  parseFloat(data.cumExecValue || '0') /
                  parseFloat(data.cumExecQty || '1')
                }`
              : data.price,
        quantity: data.qty,
        side: data.side === 'Buy' ? 'BUY' : 'SELL',
        symbol: data.symbol,
        totalQuoteTradeQuantity:
          category === 'inverse' ? data.cumExecQty : data.cumExecValue,
        totalTradeQuantity:
          category === 'inverse' ? data.cumExecValue : data.cumExecQty,
        uniqueMessageId: `${data.category}executionReport${data.updatedTime}${data.symbol}${data.orderStatus}${data.qty}${data.price}${data.cumExecQty}${data.orderType}${data.orderLinkId}${data.createType}`,
        liquidation: data.createType === 'CreateByTakeOver_PassThrough',
      }))
  }

  private prepareBitgetOrderMsg(msg: BitgetSpotOrder[]): ExecutionReport[] {
    return msg.map((data) => ({
      creationTime: parseInt(data.cTime),
      eventTime: parseInt(data.uTime),
      eventType: 'executionReport',
      newClientOrderId: data.clientOid,
      orderId: data.orderId,
      orderTime: parseInt(data.uTime),
      orderStatus: (() => {
        const { status } = data
        if (['live'].includes(status)) {
          return 'NEW'
        }
        if (status === 'partially_filled') {
          return 'PARTIALLY_FILLED'
        }
        if (status === 'filled') {
          return 'FILLED'
        }
        return 'CANCELED'
      })(),
      orderType: data.orderType === 'limit' ? 'LIMIT' : 'MARKET',
      originalClientOrderId: data.clientOid,
      price: `${+data.priceAvg || +data.price}`,
      quantity: data.baseVolume,
      side: data.side === 'buy' ? 'BUY' : 'SELL',
      symbol: data.instId,
      totalQuoteTradeQuantity:
        +data.accBaseVolume && +data.priceAvg
          ? `${+data.accBaseVolume * +data.priceAvg}`
          : '0',
      totalTradeQuantity: data.accBaseVolume,
      uniqueMessageId: `BitgetexecutionReport${Object.entries(data)
        .map(([k, v]) => `${k}:${v}`)
        .join(',')}`,
    }))
  }

  private preparePaperOrderMsg(msg: PaperOrderMessage): ExecutionReport {
    return {
      creationTime: new Date(msg.updatedAt).getTime(),
      eventTime: new Date(msg.updatedAt).getTime(),
      eventType: 'executionReport',
      newClientOrderId: msg.externalId,
      orderId: msg._id,
      orderTime: new Date(msg.updatedAt).getTime(),
      orderStatus: msg.status,
      orderType: msg.type === 'LIMIT' ? 'LIMIT' : 'MARKET',
      originalClientOrderId: msg.externalId,
      price: `${msg.price}`,
      quantity: `${msg.amount}`,
      side: msg.side === 'BUY' ? 'BUY' : 'SELL',
      symbol: msg.symbol,
      totalQuoteTradeQuantity: `${msg.filledQuoteAmount}`,
      totalTradeQuantity: `${msg.filledAmount}`,
      uniqueMessageId: `executionReport${msg.updatedAt}${msg.symbol}${msg.status}${msg.amount}${msg.price}${msg.externalId}`,
      liquidation: msg.externalId.startsWith('liquidation_'),
    }
  }

  private async prepareHyperliquidOrder(
    data: hl.OrderStatus<hl.Order>[],
  ): Promise<(UserDataStreamEvent & { uniqueMessageId?: string })[]> {
    return await Promise.all(
      data
        .filter((o) => o.order.cloid)
        .map(async (order) => {
          const isFilled = order.status === 'filled'
          let filledSize = +order.order.origSz - +order.order.sz
          let quote = +order.order.limitPx * filledSize
          let price = `${order.order.limitPx}`
          const pricePrecision =
            price.indexOf('.') >= 0 ? price.split('.')[1].length : 0
          if (isNaN(quote) || !isFinite(quote)) {
            quote = 0
          }
          const get = hyperliquidExpirableMap.get(`${order.order.cloid}`)
          if (get) {
            if (filledSize > 0) {
              filledSize = get.reduce((a, c) => a + +c.sz, 0)
              quote = get.reduce((a, c) => a + +c.sz * +c.px, 0)
              price = `${(filledSize ? quote / filledSize : +order.order.limitPx).toFixed(pricePrecision)}`
            }
            if (isFilled) {
              hyperliquidExpirableMap.delete(`${order.order.cloid}`)
            }
          }
          if (
            isFilled &&
            (filledSize < +order.order.origSz ||
              filledSize > +order.order.origSz)
          ) {
            filledSize = +order.order.origSz
            quote = +price * filledSize
          }

          return {
            creationTime: new Date(order.statusTimestamp).getTime(),
            eventTime: new Date(order.statusTimestamp).getTime(),
            eventType: 'executionReport',
            newClientOrderId: order.order.cloid ?? '',
            orderId: order.order.oid,
            orderTime: new Date(order.statusTimestamp).getTime(),
            orderStatus: isFilled
              ? 'FILLED'
              : order.status === 'open'
                ? filledSize > 0
                  ? 'PARTIALLY_FILLED'
                  : 'NEW'
                : 'CANCELED',
            orderType: 'LIMIT',
            originalClientOrderId: order.order.cloid ?? '',
            price,
            quantity: `${order.order.origSz}`,
            side: order.order.side === 'A' ? 'BUY' : 'SELL',
            symbol: order.order.coin,
            totalQuoteTradeQuantity: `${quote}`,
            totalTradeQuantity: `${filledSize}`,
            uniqueMessageId: `executionReport${JSON.stringify(order)},fills:${JSON.stringify(get || [])}`,
            liquidation: false,
          }
        }),
    )
  }

  private prepareOkxOutboundAccountInfo(
    msg?: OKXAccountMsg,
  ): OutboundAccountPosition | undefined {
    if (!msg) {
      return
    }
    const balances = (msg?.details ?? []).map((b) => ({
      asset: b.ccy,
      free: `${+b.availBal}`,
      locked: `${+b.fixedBal + +b.frozenBal}`,
    }))
    if (!balances?.length) {
      return
    }
    return {
      balances,
      eventTime: parseInt(msg.uTime),
      eventType: 'outboundAccountPosition',
      lastAccountUpdate: 0,
      uniqueMessageId: `outboundAccountPosition${msg.uTime}${balances[0]?.asset}${balances[0]?.free}${balances[0]?.locked}`,
    }
  }

  private prepareBybitOutboundAccountInfo(
    msg: BybitOutboundAccountInfo,
    category: CategoryV5,
    all = false,
  ): OutboundAccountPosition | undefined {
    const isUnified =
      typeof msg.data[0]?.coin[0]?.collateralSwitch !== 'undefined'
    const balances = msg.data
      .filter((d) =>
        isUnified && all
          ? d.accountType === 'UNIFIED'
          : isUnified && (category === 'linear' || category === 'spot')
            ? d.accountType === 'UNIFIED'
            : isUnified && category === 'inverse'
              ? d.accountType === 'CONTRACT'
              : !isUnified && (category === 'inverse' || category === 'linear')
                ? d.accountType === 'CONTRACT'
                : !isUnified && category === 'spot'
                  ? d.accountType === 'SPOT'
                  : d.accountType === 'UNIFIED',
      )
      .flatMap((d) => d.coin)
      .map((b) => {
        const locked = `${
          parseFloat(b.locked || '0') +
          parseFloat(b.totalOrderIM || '0') +
          parseFloat(b.totalPositionIM || '0')
        }`
        return {
          asset: b.coin,
          free: `${
            parseFloat(b.free || '0') +
            parseFloat(b.walletBalance || '0') -
            +locked
          }`,
          locked,
        }
      })
    if (!balances.length) {
      return
    }
    return {
      balances,
      eventTime: parseInt(msg.creationTime),
      eventType: 'outboundAccountPosition',
      lastAccountUpdate: 0,
      uniqueMessageId: `outboundAccountPosition${msg.creationTime}${balances[0]?.asset}${balances[0]?.free}${balances[0]?.locked}`,
    }
  }

  private prepareBitgetSpotOutboundAccountInfo(
    msg: BitgetSpotBalance[],
    time: number,
    userId: string,
  ): OutboundAccountPosition | undefined {
    const balances = msg.map((m) => ({
      asset: m.coin,
      free: m.available,
      locked: `${+m.frozen + +m.locked}`,
    }))
    return {
      balances,
      eventTime: time,
      eventType: 'outboundAccountPosition',
      lastAccountUpdate: 0,
      uniqueMessageId: `outboundAccountPosition${userId}${JSON.stringify(balances)}bitget`,
    }
  }

  private prepareBitgetFuturesOutboundAccountInfo(
    msg: BitgetFuturesBalance[],
    time: number,
    userId: string,
  ): OutboundAccountPosition | undefined {
    const balances = msg.map((m) => ({
      asset: m.marginCoin,
      free: m.available,
      locked: m.frozen,
    }))
    return {
      balances,
      eventTime: time,
      eventType: 'outboundAccountPosition',
      lastAccountUpdate: 0,
      uniqueMessageId: `outboundAccountPosition${userId}${JSON.stringify(balances)}bitgetFutures`,
    }
  }

  private preparePaperOutboundAccountInfo(
    msg: PaperBalance,
  ): OutboundAccountPosition {
    return {
      balances: msg.balance.map((b) => ({
        asset: `${b.asset}`,
        free: `${b.free}`,
        locked: `${b.locked}`,
      })),
      eventTime: new Date().getTime(),
      eventType: 'outboundAccountPosition',
      lastAccountUpdate: 0,
      uniqueMessageId: `outboundAccountPosition${msg.balance[0]?.asset}${msg.balance[0]?.free}${msg.balance[0]?.locked}`,
    }
  }
}

export default UserConnector
export { UserConnector }
