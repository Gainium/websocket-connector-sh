export const convert = (data) =>
  userTransforms[data.e] ? userTransforms[data.e]?.(data) : null

export const convertFutures = (data) =>
  futurestUserTransform[data.e] ? futurestUserTransform[data.e]?.(data) : null

function ownKeys(object, enumerableOnly) {
  var keys = Object.keys(object)
  if (Object.getOwnPropertySymbols) {
    var symbols = Object.getOwnPropertySymbols(object)
    if (enumerableOnly) {
      symbols = symbols.filter(function (sym) {
        return Object.getOwnPropertyDescriptor(object, sym).enumerable
      })
    }
    keys.push.apply(keys, symbols)
  }
  return keys
}

function _defineProperty(obj, key, value) {
  if (key in obj) {
    Object.defineProperty(obj, key, {
      value: value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  } else {
    obj[key] = value
  }
  return obj
}

function _objectSpread(target) {
  for (var i = 1; i < arguments.length; i++) {
    var source = arguments[i] != null ? arguments[i] : {}
    if (i % 2) {
      ownKeys(Object(source), true).forEach(function (key) {
        _defineProperty(target, key, source[key])
      })
    } else if (Object.getOwnPropertyDescriptors) {
      Object.defineProperties(target, Object.getOwnPropertyDescriptors(source))
    } else {
      ownKeys(Object(source)).forEach(function (key) {
        Object.defineProperty(
          target,
          key,
          Object.getOwnPropertyDescriptor(source, key),
        )
      })
    }
  }
  return target
}

export const userTransforms = {
  // https://github.com/binance-exchange/binance-official-api-docs/blob/master/user-data-stream.md#balance-update
  balanceUpdate: function balanceUpdate(m) {
    return {
      asset: m.a,
      balanceDelta: m.d,
      clearTime: m.T,
      eventTime: m.E,
      eventType: 'balanceUpdate',
      uniqueMessageId: `balanceUpdate${m.E}${m.a}${m.d}`,
    }
  },
  // https://github.com/binance-exchange/binance-official-api-docs/blob/master/user-data-stream.md#account-update
  outboundAccountInfo: function outboundAccountInfo(m) {
    return {
      eventType: 'account',
      eventTime: m.E,
      makerCommissionRate: m.m,
      takerCommissionRate: m.t,
      buyerCommissionRate: m.b,
      sellerCommissionRate: m.s,
      canTrade: m.T,
      canWithdraw: m.W,
      canDeposit: m.D,
      lastAccountUpdate: m.u,
      balances: m.B.reduce(function (out, cur) {
        out[cur.a] = {
          available: cur.f,
          locked: cur.l,
        }
        return out
      }, {}),
      uniqueMessageId: `account${m.E}${m.B[0]?.cur?.a}${m.B[0]?.cur?.f}${m.B[0]?.cur?.l}`,
    }
  },
  // https://github.com/binance-exchange/binance-official-api-docs/blob/master/user-data-stream.md#account-update
  outboundAccountPosition: function outboundAccountPosition(m) {
    return {
      balances: m.B.map(function (_ref2) {
        const a = _ref2.a,
          f = _ref2.f,
          l = _ref2.l
        return {
          asset: a,
          free: f,
          locked: l,
        }
      }),
      eventTime: m.E,
      eventType: 'outboundAccountPosition',
      lastAccountUpdate: m.u,
      uniqueMessageId: `outboundAccountPosition${m.E}${m.B[0]?.a}${m.B[0]?.f}${m.B[0]?.l}`,
    }
  },
  // https://github.com/binance-exchange/binance-official-api-docs/blob/master/user-data-stream.md#order-update
  executionReport: function executionReport(m) {
    return {
      eventType: 'executionReport',
      eventTime: m.E,
      symbol: m.s,
      newClientOrderId: m.c,
      originalClientOrderId: m.C,
      side: m.S,
      orderType: m.o,
      timeInForce: m.f,
      quantity: m.q,
      price: m.p,
      executionType: m.x,
      stopPrice: m.P,
      icebergQuantity: m.F,
      orderStatus: m.X,
      orderRejectReason: m.r,
      orderId: m.i,
      orderTime: m.T,
      lastTradeQuantity: m.l,
      totalTradeQuantity: m.z,
      priceLastTrade: m.L,
      commission: m.n,
      commissionAsset: m.N,
      tradeId: m.t,
      isOrderWorking: m.w,
      isBuyerMaker: m.m,
      creationTime: m.O,
      totalQuoteTradeQuantity: m.Z,
      orderListId: m.g,
      quoteOrderQuantity: m.Q,
      lastQuoteTransacted: m.Y,
      uniqueMessageId: `executionReport${m.E}${m.s}${m.X}${m.q}${m.p}${m.S}${m.c}${m.C}`,
    }
  },
}

export const futurestUserTransform = {
  // https://binance-docs.github.io/apidocs/futures/en/#close-user-data-stream-user_stream
  listenKeyExpired: function USER_DATA_STREAM_EXPIRED(m) {
    return {
      eventTime: m.E,
      eventType: 'USER_DATA_STREAM_EXPIRED',
      uniqueMessageId: `USER_DATA_STREAM_EXPIRED${m.E}`,
    }
  },
  // https://binance-docs.github.io/apidocs/futures/en/#event-margin-call
  MARGIN_CALL: function MARGIN_CALL(m) {
    return {
      eventTime: m.E,
      crossWalletBalance: m.cw,
      eventType: 'MARGIN_CALL',
      positions: m.p.map(function (cur) {
        return {
          symbol: cur.s,
          positionSide: cur.ps,
          positionAmount: cur.pa,
          marginType: cur.mt,
          isolatedWallet: cur.iw,
          markPrice: cur.mp,
          unrealizedPnL: cur.up,
          maintenanceMarginRequired: cur.mm,
        }
      }),
      uniqueMessageId: `MARGIN_CALL${m.E}${m.cw}${m.p
        .map((cur) => cur.up)
        .join(',')}`,
    }
  },
  // https://binance-docs.github.io/apidocs/futures/en/#event-balance-and-position-update
  ACCOUNT_UPDATE: function ACCOUNT_UPDATE(m) {
    return {
      eventTime: m.E,
      transactionTime: m.T,
      eventType: 'ACCOUNT_UPDATE',
      eventReasonType: m.a.m,
      balances: m.a.B.map(function (b) {
        return {
          asset: b.a,
          walletBalance: b.wb,
          crossWalletBalance: b.cw,
          balanceChange: b.bc,
        }
      }),
      positions: m.a.P.map(function (p) {
        return {
          symbol: p.s,
          positionAmount: p.pa,
          entryPrice: p.ep,
          accumulatedRealized: p.cr,
          unrealizedPnL: p.up,
          marginType: p.mt,
          isolatedWallet: p.iw,
          positionSide: p.ps,
        }
      }),
      uniqueMessageId: `ACCOUNT_UPDATE${m.E}${m.T}${m.a.B[0]?.a}${m.a.B[0]?.wb}${m.a.B[0]?.cw}${m.a.B[0]?.bc}`,
    }
  },
  // https://binance-docs.github.io/apidocs/futures/en/#event-order-update
  ORDER_TRADE_UPDATE: function ORDER_TRADE_UPDATE(m) {
    return {
      eventType: 'ORDER_TRADE_UPDATE',
      eventTime: m.E,
      transactionTime: m.T,
      symbol: m.o.s,
      clientOrderId: m.o.c,
      side: m.o.S,
      orderType: m.o.o,
      timeInForce: m.o.f,
      quantity: m.o.q,
      price: m.o.p,
      averagePrice: m.o.ap,
      stopPrice: m.o.sp,
      executionType: m.o.x,
      orderStatus: m.o.X,
      orderId: m.o.i,
      lastTradeQuantity: m.o.l,
      totalTradeQuantity: m.o.z,
      priceLastTrade: m.o.L,
      commissionAsset: m.o.N,
      commission: m.o.n,
      orderTime: m.o.T,
      tradeId: m.o.t,
      bidsNotional: m.o.b,
      asksNotional: m.o.a,
      isMaker: m.o.m,
      isReduceOnly: m.o.R,
      workingType: m.o.wt,
      originalOrderType: m.o.ot,
      positionSide: m.o.ps,
      closePosition: m.o.cp,
      activationPrice: m.o.AP,
      callbackRate: m.o.cr,
      realizedProfit: m.o.rp,
      uniqueMessageId: `ORDER_TRADE_UPDATE${m.E}${m.T}${m.o.s}${m.o.X}${m.o.q}${m.o.c}${m.o.i}`,
      liquidation: `${m.o.c}`.startsWith('autoclose-'),
    }
  },
  // https://binance-docs.github.io/apidocs/futures/en/#event-account-configuration-update-previous-leverage-update
  ACCOUNT_CONFIG_UPDATE: function ACCOUNT_CONFIG_UPDATE(m) {
    return _objectSpread(
      {
        eventType: 'ACCOUNT_CONFIG_UPDATE',
        eventTime: m.E,
        transactionTime: m.T,
        type: m.ac ? 'ACCOUNT_CONFIG' : 'MULTI_ASSETS',
        uniqueMessageId: `ACCOUNT_CONFIG_UPDATE${m.E}${m.T}${
          m.ac ? `${m.ac.s}${m.ac.l}` : m.ai.j
        }`,
      },
      m.ac
        ? {
            symbol: m.ac.s,
            leverage: m.ac.l,
          }
        : {
            multiAssets: m.ai.j,
          },
    )
  },
}
