export const skipReason = [
  'WebSocket was closed before the connection was established',
  '(wallet,order)',
  '(wallet)',
  '(order)',
  'Ping error',
  'failed to subscribe',
  'Kucoin WS Error',
  'Redis Client Error',
  'write EPIPE',
].map((r) => r.toLowerCase())

export const rabbitUsersStreamKey = 'usersStreamAction'
export const serviceLogRedis = 'serviceLog'

export type PositionSide_LT = 'BOTH' | 'SHORT' | 'LONG'

export type OrderStatusType = 'CANCELED' | 'FILLED' | 'NEW' | 'PARTIALLY_FILLED'

export type OrderTypeT = 'LIMIT' | 'MARKET'

export type OrderSideType = 'BUY' | 'SELL'

export type CommonOrder = {
  /**futures */
  positionSide?: PositionSide_LT
  reduceOnly?: boolean
  closePosition?: boolean
  timeInForce?: string
  cumQuote?: string
  cumBase?: string
  cumQty?: string
  avgPrice?: string
  /**spot */
  symbol: string
  orderId: string | number
  clientOrderId: string
  transactTime?: number
  updateTime: number
  price: string
  origQty: string
  executedQty: string
  cummulativeQuoteQty?: string
  status: OrderStatusType
  type: OrderTypeT
  side: OrderSideType
  fills?: {
    price: string
    qty: string
    commission: string
    commissionAsset: string
    tradeId: string
  }[]
}
