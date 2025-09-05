# Developer Guide - WebSocket Connector

This comprehensive guide covers the architecture, implementation details, and advanced usage of the WebSocket Connector service based on the actual codebase.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Core Concepts](#core-concepts)
- [User Stream Implementation](#user-stream-implementation)
- [Price Stream Implementation](#price-stream-implementation)
- [Exchange Integration Patterns](#exchange-integration-patterns)
- [Utility Systems](#utility-systems)
- [Advanced Features](#advanced-features)
- [Debugging and Monitoring](#debugging-and-monitoring)
- [API Reference](#api-reference)

## Architecture Overview

The WebSocket Connector is built as a multi-threaded Node.js service that manages real-time data streams from multiple cryptocurrency exchanges, providing unified interfaces for both user account data and market price data.

### Core Architecture

```
┌─────────────────────────────────────────┐
│          Client Applications            │
└─────────────┬───────────────────────────┘
              │
┌─────────────▼───────────────────────────┐
│           RabbitMQ Queues               │
│    • User Stream Events                 │
│    • Price Stream Events                │
└─────────────┬───────────────────────────┘
              │
┌─────────────▼───────────────────────────┐
│        WebSocket Connector              │
│  ┌─────────────┐ ┌─────────────────────┐│
│  │ User Stream │ │   Price Stream      ││
│  │ Connector   │ │   Connector         ││
│  └─────────────┘ └─────────────────────┘│
└─────────────┬───────────────────────────┘
              │
┌─────────────▼───────────────────────────┐
│         Exchange WebSockets             │
│  ┌─────────┐ ┌─────────┐ ┌─────────────┐│
│  │ Binance │ │ Bybit   │ │   KuCoin    ││
│  │ Bitget  │ │ OKX     │ │  Coinbase   ││
│  └─────────┘ └─────────┘ └─────────────┘│
└─────────────┬───────────────────────────┘
              │
┌─────────────▼───────────────────────────┐
│          Infrastructure                 │
│  • Redis (State & Cache)                │
│  • RabbitMQ (Message Queue)            │
│  • Worker Threads (Price Processing)   │
└─────────────────────────────────────────┘
```

### Key Components

1. **User Stream Connector** - Manages real-time account data streams
2. **Price Stream Connector** - Handles market data streams with worker threads
3. **Exchange Integrations** - Specific WebSocket implementations for each exchange
4. **Utility Layer** - Shared services for Redis, RabbitMQ, logging, and concurrency
5. **Paper Trading Support** - Simulation mode for all supported exchanges

## Core Concepts

### Dual-Mode Operation

The service operates in two distinct modes:

```typescript
// User Stream Mode - Account data
class UserStreamConnector {
  private connections = new Map<string, WebSocket>()
  private streams = new Map<string, StreamInfo>()
  
  // Handle real-time account events
  async openStream(input: OpenStreamInput): Promise<void> {
    const { userId, api } = input
    await this.connectExchange(userId, api)
  }
}

// Price Stream Mode - Market data  
class PriceConnector {
  private workers = new Map<ExchangeEnum, Worker>()
  
  // Handle market data with worker threads
  init(): void {
    this.startPriceWorkers()
  }
}
```

### Message Flow Pattern

All data follows a consistent flow through the system:

```typescript
// Standard message processing pipeline
Exchange WebSocket → Data Normalization → RabbitMQ → Client Applications
                          ↓
                    Redis (State Cache)
```

### Connection Management

Robust connection handling with automatic reconnection:

```typescript
abstract class BaseConnector {
  protected connections = new Map<string, WebSocket>()
  protected reconnectAttempts = new Map<string, number>()
  
  protected async handleDisconnect(userId: string): Promise<void> {
    const attempts = this.reconnectAttempts.get(userId) || 0
    const delay = Math.min(1000 * Math.pow(2, attempts), 30000)
    
    setTimeout(() => {
      this.reconnect(userId).catch(error => {
        logger.error(`Reconnection failed for ${userId}:`, error)
      })
    }, delay)
  }
}
```

## User Stream Implementation

### Main UserStream Class

The central user stream connector manages account data for all exchanges:

```typescript
class UserStreamConnector {
  private connections = new Map<string, WebSocket>()
  private idToApi = new Map<string, ApiCredentials>()
  private redis = new RedisClient()
  private rabbit = new RabbitClient()
  
  constructor() {
    this.initializeServices()
  }
  
  async openStream(input: OpenStreamInput): Promise<void> {
    const { userId, api } = input
    
    // Store API credentials
    this.idToApi.set(userId, api)
    
    // Connect to appropriate exchange
    switch (api.provider) {
      case ExchangeEnum.binance:
        await this.connectBinance(userId, api)
        break
      case ExchangeEnum.bybit:
        await this.connectBybit(userId, api)
        break
      case ExchangeEnum.kucoin:
        await this.connectKucoin(userId, api)
        break
      // ... other exchanges
      default:
        throw new Error(`Unsupported exchange: ${api.provider}`)
    }
  }
}
```

### Exchange-Specific Implementations

#### Binance User Stream

```typescript
private async connectBinance(userId: string, api: ApiCredentials): Promise<void> {
  try {
    const client = new WebsocketClient({
      api_key: api.key,
      api_secret: api.secret,
      beautify: true,
      wsConfig: wsLoggerOptions
    })
    
    // Handle different market types
    if (api.provider.includes('Usdm')) {
      this.setupBinanceFutures(client, userId, 'usdm')
    } else if (api.provider.includes('Coinm')) {
      this.setupBinanceFutures(client, userId, 'coinm')
    } else {
      this.setupBinanceSpot(client, userId)
    }
    
    // Store connection
    this.connections.set(`${userId}_binance`, client)
    
  } catch (error) {
    logger.error(`Binance connection failed for user ${userId}:`, error)
    throw error
  }
}

private setupBinanceSpot(client: WebsocketClient, userId: string): void {
  client.on('formattedMessage', (data) => {
    this.handleBinanceSpotMessage(userId, data)
  })
  
  client.on('open', () => {
    logger.info(`Binance spot stream opened for user ${userId}`)
    client.subscribeSpotUserDataStream()
  })
  
  client.on('error', (error) => {
    logger.error(`Binance spot error for user ${userId}:`, error)
    this.handleConnectionError(userId, error)
  })
}

private handleBinanceSpotMessage(userId: string, data: any): void {
  switch (data.eventType) {
    case 'executionReport':
      this.publishOrderUpdate(userId, convert(data, ExchangeEnum.binance))
      break
    case 'outboundAccountPosition':
      this.publishBalanceUpdate(userId, this.convertBalanceUpdate(data))
      break
    case 'balanceUpdate':
      this.publishSingleBalanceUpdate(userId, data)
      break
    default:
      logger.debug(`Unknown Binance message type: ${data.eventType}`)
  }
}
```

#### KuCoin User Stream

```typescript
private async connectKucoin(userId: string, api: ApiCredentials): Promise<void> {
  try {
    const client = new KucoinApi({
      apikey: api.key,
      apisecret: api.secret,
      apipassphrase: api.passphrase,
      environment: api.environment,
      userAgent: 'Gainium/1.0.0'
    })
    
    // Get WebSocket token
    const tokenResponse = await client.rest.user.getUserWebsocketToken()
    
    if (tokenResponse.code === '200000') {
      const { token, servers } = tokenResponse.data
      const server = servers[0]
      
      // Connect to WebSocket
      const ws = new WebSocket(`${server.endpoint}?token=${token}`)
      
      this.setupKucoinEventHandlers(ws, userId, client)
      this.connections.set(`${userId}_kucoin`, ws)
    }
    
  } catch (error) {
    logger.error(`KuCoin connection failed for user ${userId}:`, error)
    throw error
  }
}

private setupKucoinEventHandlers(ws: WebSocket, userId: string, client: KucoinApi): void {
  ws.on('open', () => {
    logger.info(`KuCoin stream opened for user ${userId}`)
    
    // Subscribe to account updates
    const subscribeMessage = {
      id: Date.now(),
      type: 'subscribe',
      topic: '/account/balance',
      privateChannel: true,
      response: true
    }
    
    ws.send(JSON.stringify(subscribeMessage))
  })
  
  ws.on('message', (data) => {
    this.handleKucoinMessage(userId, JSON.parse(data.toString()))
  })
  
  ws.on('close', () => {
    logger.warn(`KuCoin stream closed for user ${userId}`)
    this.scheduleReconnect(userId)
  })
}
```

### Paper Trading Integration

Support for paper trading across all exchanges:

```typescript
private async connectPaperTrading(userId: string, api: ApiCredentials): Promise<void> {
  const paperWsUrl = process.env.PAPER_WS || 'http://localhost:7506'
  const realExchange = mapPaperToReal(api.provider)
  
  try {
    const socket = io(paperWsUrl, {
      query: {
        userId,
        exchange: realExchange,
        apiKey: api.key
      }
    })
    
    socket.on('connect', () => {
      logger.info(`Paper trading connected for user ${userId} on ${realExchange}`)
    })
    
    socket.on('executionReport', (data) => {
      this.publishOrderUpdate(userId, data)
    })
    
    socket.on('balanceUpdate', (data) => {
      this.publishBalanceUpdate(userId, data)
    })
    
    this.connections.set(`${userId}_paper`, socket)
    
  } catch (error) {
    logger.error(`Paper trading connection failed for user ${userId}:`, error)
    throw error
  }
}
```

## Price Stream Implementation

### Multi-Worker Architecture

Price streams use worker threads for parallel processing:

```typescript
class PriceConnector {
  private workers = new Map<ExchangeEnum, Worker>()
  private subscribedCandlesMap = new Map<ExchangeEnum, Set<string>>()
  private subscribedTopics = new Map<ExchangeEnum, Set<string>>()
  
  init(): void {
    const exchanges = [
      ExchangeEnum.binance,
      ExchangeEnum.bybit,
      ExchangeEnum.kucoin,
      ExchangeEnum.okx,
      ExchangeEnum.bitget,
      ExchangeEnum.coinbase
    ]
    
    for (const exchange of exchanges) {
      this.startWorker(exchange)
    }
  }
  
  private startWorker(exchange: ExchangeEnum): void {
    const worker = new Worker(path.join(__dirname, 'price/worker.js'), {
      workerData: {
        exchange,
        subscribedCandlesMap: this.subscribedCandlesMap,
        subscribedTopics: this.subscribedTopics
      }
    })
    
    worker.on('message', (message) => {
      this.handleWorkerMessage(exchange, message)
    })
    
    worker.on('error', (error) => {
      logger.error(`Worker error for ${exchange}:`, error)
      this.restartWorker(exchange)
    })
    
    this.workers.set(exchange, worker)
  }
  
  private handleWorkerMessage(exchange: ExchangeEnum, message: any): void {
    switch (message.type) {
      case 'candle':
        this.publishCandle(exchange, message.symbol, message.data)
        break
      case 'ticker':
        this.publishTicker(exchange, message.symbol, message.data)
        break
      case 'error':
        logger.error(`Worker ${exchange} error:`, message.error)
        break
    }
  }
}
```

### Worker Thread Implementation

Each exchange runs in its own worker thread:

```javascript
// price/worker.js
const { workerData, parentPort } = require('worker_threads')
const { exchange, subscribedCandlesMap, subscribedTopics } = workerData

async function startPriceWorker() {
  try {
    const service = require('./service')
    await service.startWorker(exchange, {
      subscribedCandlesMap,
      subscribedTopics
    })
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      error: error.message
    })
  }
}

startPriceWorker()
```

### Exchange Price Stream Services

#### Binance Price Stream

```typescript
class BinanceConnector {
  private client: WebsocketClient
  private subscribedCandlesMap: Map<ExchangeEnum, Set<string>>
  
  constructor(subscribedCandlesMap: Map<ExchangeEnum, Set<string>>) {
    this.subscribedCandlesMap = subscribedCandlesMap
    this.client = new WebsocketClient({
      beautify: true,
      wsConfig: wsLoggerOptions
    })
    
    this.setupEventHandlers()
  }
  
  private setupEventHandlers(): void {
    this.client.on('formattedMessage', (data) => {
      this.handleMessage(data)
    })
    
    this.client.on('open', () => {
      logger.info('Binance price stream opened')
      this.subscribeToCandles()
    })
    
    this.client.on('error', (error) => {
      logger.error('Binance price stream error:', error)
    })
  }
  
  private subscribeToCandles(): void {
    const symbols = this.subscribedCandlesMap.get(ExchangeEnum.binance)
    if (!symbols || symbols.size === 0) return
    
    const streams = Array.from(symbols).map(symbol => `${symbol.toLowerCase()}@kline_1m`)
    
    for (const stream of streams) {
      this.client.subscribeToStream(stream)
    }
  }
  
  private handleMessage(data: any): void {
    if (data.eventType === 'kline') {
      this.handleKlineMessage(data)
    } else if (data.eventType === '24hrTicker') {
      this.handleTickerMessage(data)
    }
  }
  
  private handleKlineMessage(data: any): void {
    const candle: Candle = {
      start: data.kline.startTime,
      open: data.kline.open,
      high: data.kline.high,
      low: data.kline.low,
      close: data.kline.close,
      volume: data.kline.volume
    }
    
    if (process.send) {
      process.send({
        type: 'candle',
        exchange: ExchangeEnum.binance,
        symbol: data.symbol,
        data: candle
      })
    }
  }
}
```

### Candle Subscription Management

Dynamic subscription management for market data:

```typescript
async subscribeCandle(payload: SubscribeCandlePayload): Promise<void> {
  const { symbol, exchange, interval = '1m' } = payload
  
  // Add to subscription map
  if (!this.subscribedCandlesMap.has(exchange)) {
    this.subscribedCandlesMap.set(exchange, new Set())
  }
  
  this.subscribedCandlesMap.get(exchange)!.add(symbol)
  
  // Notify worker to subscribe
  const worker = this.workers.get(exchange)
  if (worker) {
    worker.postMessage({
      type: 'subscribe',
      symbol,
      interval
    })
  }
  
  // Store in Redis for persistence
  await this.redis.sadd(`candle_subscriptions:${exchange}`, symbol)
}
```

## Exchange Integration Patterns

### WebSocket Connection Pattern

All exchange integrations follow this pattern:

```typescript
abstract class BaseExchangeConnector {
  protected ws: WebSocket | null = null
  protected reconnectAttempts = 0
  protected maxReconnectAttempts = 5
  
  async connect(): Promise<void> {
    try {
      this.ws = await this.createWebSocketConnection()
      this.setupEventHandlers(this.ws)
    } catch (error) {
      logger.error(`${this.exchangeName} connection failed:`, error)
      await this.handleConnectionError(error)
    }
  }
  
  protected setupEventHandlers(ws: WebSocket): void {
    ws.onopen = () => this.handleOpen()
    ws.onmessage = (event) => this.handleMessage(event)
    ws.onclose = (event) => this.handleClose(event)
    ws.onerror = (error) => this.handleError(error)
  }
  
  protected async handleClose(event: CloseEvent): Promise<void> {
    logger.warn(`${this.exchangeName} connection closed:`, event.code)
    
    if (this.shouldReconnect(event)) {
      await this.scheduleReconnect()
    }
  }
  
  protected async scheduleReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`${this.exchangeName} max reconnection attempts reached`)
      return
    }
    
    const delay = this.calculateBackoffDelay()
    this.reconnectAttempts++
    
    setTimeout(() => {
      this.connect().catch(error => {
        logger.error(`${this.exchangeName} reconnection failed:`, error)
      })
    }, delay)
  }
  
  protected calculateBackoffDelay(): number {
    return Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
  }
  
  abstract handleMessage(event: MessageEvent): void
  abstract createWebSocketConnection(): Promise<WebSocket>
}
```

### Message Standardization

Consistent message mapping across exchanges:

```typescript
// Standard message interfaces
interface StandardOrder {
  eventType: 'executionReport'
  symbol: string
  orderId: string
  clientOrderId?: string
  side: 'BUY' | 'SELL'
  orderStatus: OrderStatus
  orderType: OrderType
  price: string
  quantity: string
  executedQty: string
  timestamp: number
}

interface StandardBalance {
  eventType: 'balanceUpdate'
  asset: string
  free: string
  locked: string
  timestamp: number
}

// Exchange-specific mappers
class BinanceMapper {
  static mapOrder(data: any): StandardOrder {
    return {
      eventType: 'executionReport',
      symbol: data.symbol,
      orderId: data.orderId.toString(),
      clientOrderId: data.clientOrderId,
      side: data.side,
      orderStatus: this.mapOrderStatus(data.orderStatus),
      orderType: this.mapOrderType(data.orderType),
      price: data.price,
      quantity: data.quantity,
      executedQty: data.executedQuantity,
      timestamp: data.transactionTime
    }
  }
  
  static mapOrderStatus(status: string): OrderStatus {
    const mapping = {
      'NEW': OrderStatus.NEW,
      'FILLED': OrderStatus.FILLED,
      'CANCELED': OrderStatus.CANCELED,
      'PARTIALLY_FILLED': OrderStatus.PARTIALLY_FILLED
    }
    return mapping[status] || OrderStatus.UNKNOWN
  }
}
```

## Utility Systems

### Redis Integration

Centralized state management and caching:

```typescript
class RedisClient {
  private client: Redis
  
  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3
    })
    
    this.setupEventHandlers()
  }
  
  // Connection state management
  async setUserConnectionState(userId: string, exchange: string, state: ConnectionState): Promise<void> {
    const key = `user_connection:${userId}:${exchange}`
    await this.client.hset(key, {
      state: state.status,
      lastSeen: Date.now(),
      reconnectAttempts: state.reconnectAttempts
    })
    await this.client.expire(key, 3600) // Expire in 1 hour
  }
  
  // Subscription management
  async addCandleSubscription(exchange: string, symbol: string): Promise<void> {
    await this.client.sadd(`candle_subscriptions:${exchange}`, symbol)
  }
  
  async getCandleSubscriptions(exchange: string): Promise<string[]> {
    return this.client.smembers(`candle_subscriptions:${exchange}`)
  }
  
  // Message caching
  async cacheMessage(userId: string, message: any): Promise<void> {
    const key = `user_messages:${userId}`
    await this.client.lpush(key, JSON.stringify(message))
    await this.client.ltrim(key, 0, 99) // Keep last 100 messages
    await this.client.expire(key, 86400) // Expire in 24 hours
  }
}
```

### RabbitMQ Integration

Reliable message queuing:

```typescript
class RabbitClient {
  private connection: amqp.Connection | null = null
  private channel: amqp.Channel | null = null
  
  async connect(): Promise<void> {
    try {
      this.connection = await amqp.connect({
        hostname: process.env.RABBIT_HOST || 'localhost',
        port: parseInt(process.env.RABBIT_PORT || '5672'),
        username: process.env.RABBIT_USER || 'gainium',
        password: process.env.RABBIT_PASSWORD
      })
      
      this.channel = await this.connection.createChannel()
      await this.setupQueues()
      
    } catch (error) {
      logger.error('RabbitMQ connection failed:', error)
      throw error
    }
  }
  
  private async setupQueues(): Promise<void> {
    if (!this.channel) return
    
    // User stream queues
    await this.channel.assertQueue('user_orders', { durable: true })
    await this.channel.assertQueue('user_balances', { durable: true })
    await this.channel.assertQueue('user_positions', { durable: true })
    
    // Price stream queues
    await this.channel.assertQueue('price_candles', { durable: true })
    await this.channel.assertQueue('price_tickers', { durable: true })
  }
  
  // Publish messages
  async publishOrderUpdate(userId: string, order: StandardOrder): Promise<void> {
    if (!this.channel) return
    
    const message = {
      userId,
      timestamp: Date.now(),
      data: order
    }
    
    this.channel.publish(
      '',
      'user_orders',
      Buffer.from(JSON.stringify(message)),
      { persistent: true }
    )
  }
  
  async publishCandle(exchange: string, symbol: string, candle: Candle): Promise<void> {
    if (!this.channel) return
    
    const message = {
      exchange,
      symbol,
      timestamp: Date.now(),
      data: candle
    }
    
    this.channel.publish(
      '',
      'price_candles',
      Buffer.from(JSON.stringify(message)),
      { persistent: true }
    )
  }
}
```

### Concurrency Control

Mutex-based locking for thread safety:

```typescript
export class IdMutex {
  private locks = new Map<string, Promise<void>>()
  
  async acquire(id: string): Promise<() => void> {
    // Wait for existing lock to release
    while (this.locks.has(id)) {
      await this.locks.get(id)
    }
    
    let release: () => void
    const promise = new Promise<void>(resolve => {
      release = resolve
    })
    
    this.locks.set(id, promise)
    
    return () => {
      this.locks.delete(id)
      release!()
    }
  }
  
  async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(id)
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

// Usage in WebSocket operations
const mutex = new IdMutex()

async function safeWebSocketOperation(userId: string, operation: () => Promise<void>) {
  return mutex.withLock(`ws_${userId}`, operation)
}
```

### Logging System

Structured logging with different levels:

```typescript
class Logger {
  private winston: winston.Logger
  
  constructor() {
    this.winston = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'websocket-connector.log' })
      ]
    })
  }
  
  info(message: string, meta?: any): void {
    this.winston.info(message, meta)
  }
  
  error(message: string, error?: Error | any): void {
    this.winston.error(message, { error: error?.message || error, stack: error?.stack })
  }
  
  warn(message: string, meta?: any): void {
    this.winston.warn(message, meta)
  }
  
  debug(message: string, meta?: any): void {
    this.winston.debug(message, meta)
  }
  
  // WebSocket specific logging
  logConnection(userId: string, exchange: string, status: string): void {
    this.info(`WebSocket ${status}`, {
      userId,
      exchange,
      timestamp: Date.now()
    })
  }
  
  logMessage(userId: string, exchange: string, messageType: string): void {
    this.debug(`Message received`, {
      userId,
      exchange,
      messageType,
      timestamp: Date.now()
    })
  }
}

const logger = new Logger()
export default logger
```

## Advanced Features

### Health Monitoring

Built-in health checking system:

```typescript
class HealthMonitor {
  private connections = new Map<string, ConnectionHealth>()
  
  checkHealth(): HealthStatus {
    const totalConnections = this.connections.size
    const healthyConnections = Array.from(this.connections.values())
      .filter(conn => conn.status === 'connected').length
    
    const healthPercentage = totalConnections > 0 ? 
      (healthyConnections / totalConnections) * 100 : 100
    
    return {
      status: healthPercentage >= 80 ? 'healthy' : 'degraded',
      connections: {
        total: totalConnections,
        healthy: healthyConnections,
        percentage: healthPercentage
      },
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: Date.now()
    }
  }
  
  updateConnectionHealth(userId: string, exchange: string, status: ConnectionStatus): void {
    const key = `${userId}_${exchange}`
    this.connections.set(key, {
      userId,
      exchange,
      status,
      lastUpdate: Date.now()
    })
  }
}

// HTTP health endpoint
app.get('/health', (req, res) => {
  const health = healthMonitor.checkHealth()
  res.json(health)
})
```

### Performance Monitoring

Monitor WebSocket performance and connection metrics:

```typescript
class PerformanceMonitor {
  private metrics = {
    messagesPerSecond: new Map<string, number>(),
    connectionLatency: new Map<string, number>(),
    errorCounts: new Map<string, number>()
  }
  
  recordMessage(exchange: string): void {
    const key = `${exchange}_${Math.floor(Date.now() / 1000)}`
    const current = this.metrics.messagesPerSecond.get(key) || 0
    this.metrics.messagesPerSecond.set(key, current + 1)
  }
  
  recordLatency(exchange: string, latency: number): void {
    this.metrics.connectionLatency.set(exchange, latency)
  }
  
  recordError(exchange: string): void {
    const current = this.metrics.errorCounts.get(exchange) || 0
    this.metrics.errorCounts.set(exchange, current + 1)
  }
  
  getMetrics(): PerformanceMetrics {
    return {
      messagesPerSecond: this.calculateMessageRate(),
      averageLatency: this.calculateAverageLatency(),
      errorRate: this.calculateErrorRate(),
      timestamp: Date.now()
    }
  }
}
```

### Auto-scaling Support

Support for horizontal scaling with multiple instances:

```typescript
class ClusterManager {
  private instanceId: string
  private redis: RedisClient
  
  constructor() {
    this.instanceId = process.env.INSTANCE_ID || uuid()
    this.redis = new RedisClient()
  }
  
  async registerInstance(): Promise<void> {
    const instanceInfo = {
      id: this.instanceId,
      host: os.hostname(),
      pid: process.pid,
      startTime: Date.now(),
      lastHeartbeat: Date.now()
    }
    
    await this.redis.hset('ws_instances', this.instanceId, JSON.stringify(instanceInfo))
    
    // Send heartbeat every 30 seconds
    setInterval(() => {
      this.sendHeartbeat()
    }, 30000)
  }
  
  async sendHeartbeat(): Promise<void> {
    await this.redis.hset('ws_instances', this.instanceId, JSON.stringify({
      lastHeartbeat: Date.now(),
      connections: this.getConnectionCount()
    }))
  }
  
  async getActiveInstances(): Promise<InstanceInfo[]> {
    const instances = await this.redis.hgetall('ws_instances')
    const now = Date.now()
    
    return Object.entries(instances)
      .map(([id, data]) => ({ id, ...JSON.parse(data) }))
      .filter(instance => now - instance.lastHeartbeat < 60000) // Active in last minute
  }
}
```

## Debugging and Monitoring

### Debug Logging

Enable detailed logging for troubleshooting:

```bash
# Enable debug logging
DEBUG=* npm run main

# Exchange-specific debugging
DEBUG=binance,bybit npm run main

# WebSocket message debugging  
DEBUG=websocket npm run price
```

### Connection Monitoring

Monitor WebSocket connections:

```typescript
class ConnectionMonitor {
  private connectionStats = new Map<string, ConnectionStats>()
  
  trackConnection(userId: string, exchange: string): void {
    const key = `${userId}_${exchange}`
    const stats = this.connectionStats.get(key) || {
      connectTime: Date.now(),
      messagesReceived: 0,
      lastMessage: 0,
      reconnectCount: 0
    }
    
    this.connectionStats.set(key, stats)
  }
  
  recordMessage(userId: string, exchange: string): void {
    const key = `${userId}_${exchange}`
    const stats = this.connectionStats.get(key)
    
    if (stats) {
      stats.messagesReceived++
      stats.lastMessage = Date.now()
    }
  }
  
  recordReconnect(userId: string, exchange: string): void {
    const key = `${userId}_${exchange}`
    const stats = this.connectionStats.get(key)
    
    if (stats) {
      stats.reconnectCount++
    }
  }
  
  getConnectionReport(): ConnectionReport {
    const report = {
      totalConnections: this.connectionStats.size,
      activeConnections: 0,
      averageMessageRate: 0,
      totalReconnects: 0
    }
    
    const now = Date.now()
    let totalMessages = 0
    let totalTime = 0
    
    for (const stats of this.connectionStats.values()) {
      if (now - stats.lastMessage < 300000) { // Active in last 5 minutes
        report.activeConnections++
      }
      
      totalMessages += stats.messagesReceived
      totalTime += now - stats.connectTime
      report.totalReconnects += stats.reconnectCount
    }
    
    if (report.activeConnections > 0) {
      report.averageMessageRate = totalMessages / (totalTime / 1000)
    }
    
    return report
  }
}
```

### Error Tracking

Comprehensive error monitoring:

```typescript
class ErrorTracker {
  private errors = new Map<string, ErrorInfo[]>()
  
  recordError(exchange: string, error: Error, context?: any): void {
    const key = exchange
    const errors = this.errors.get(key) || []
    
    errors.push({
      message: error.message,
      stack: error.stack,
      context,
      timestamp: Date.now()
    })
    
    // Keep only last 100 errors per exchange
    if (errors.length > 100) {
      errors.shift()
    }
    
    this.errors.set(key, errors)
    
    // Log critical errors
    if (this.isCriticalError(error)) {
      logger.error(`Critical error in ${exchange}:`, error)
      this.alertCriticalError(exchange, error)
    }
  }
  
  private isCriticalError(error: Error): boolean {
    const criticalPatterns = [
      /authentication failed/i,
      /api key invalid/i,
      /rate limit exceeded/i,
      /connection refused/i
    ]
    
    return criticalPatterns.some(pattern => pattern.test(error.message))
  }
  
  getErrorSummary(): ErrorSummary {
    const summary: ErrorSummary = {}
    
    for (const [exchange, errors] of this.errors.entries()) {
      const last24h = errors.filter(e => Date.now() - e.timestamp < 86400000)
      
      summary[exchange] = {
        total: errors.length,
        last24h: last24h.length,
        mostRecent: errors[errors.length - 1],
        commonErrors: this.getCommonErrors(errors)
      }
    }
    
    return summary
  }
}
```

## API Reference

### Core Types

#### User Stream Types

```typescript
interface OpenStreamInput {
  userId: string
  api: {
    key: string
    secret: string
    passphrase?: string // For OKX
    provider: ExchangeEnum
    environment: 'live' | 'sandbox'
  }
}

interface ExecutionReport {
  eventType: 'executionReport'
  symbol: string
  orderId: string
  clientOrderId?: string
  side: 'BUY' | 'SELL'
  orderStatus: OrderStatus
  orderType: OrderType
  price: string
  quantity: string
  executedQty: string
  timestamp: number
}

interface BalanceUpdate {
  eventType: 'balanceUpdate'
  asset: string
  free: string
  locked: string
  timestamp: number
}

enum OrderStatus {
  NEW = 'NEW',
  PARTIALLY_FILLED = 'PARTIALLY_FILLED',
  FILLED = 'FILLED',
  CANCELED = 'CANCELED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED'
}
```

#### Price Stream Types

```typescript
interface Candle {
  start: number
  open: string
  high: string
  low: string
  close: string
  volume: string
}

interface Ticker {
  eventType: string
  eventTime: number
  symbol: string
  curDayClose: string
  bestBid: string
  bestBidQnt: string
  bestAsk: string
  bestAskQnt: string
  open: string
  high: string
  low: string
  volume: string
  volumeQuote: string
}

interface SubscribeCandlePayload {
  symbol: string
  exchange: ExchangeEnum
  interval?: string
}
```

#### Exchange Enums

```typescript
enum ExchangeEnum {
  // Live trading
  binance = 'binance',
  binanceUsdm = 'binanceUsdm',
  binanceCoinm = 'binanceCoinm',
  bybit = 'bybit',
  bybitUsdm = 'bybitUsdm',
  bybitCoinm = 'bybitCoinm',
  kucoin = 'kucoin',
  kucoinLinear = 'kucoinLinear',
  kucoinInverse = 'kucoinInverse',
  okx = 'okx',
  okxLinear = 'okxLinear',
  okxInverse = 'okxInverse',
  bitget = 'bitget',
  bitgetCoinm = 'bitgetCoinm',
  coinbase = 'coinbase',
  
  // Paper trading
  paperBinance = 'paperBinance',
  paperBinanceUsdm = 'paperBinanceUsdm',
  paperBinanceCoinm = 'paperBinanceCoinm',
  paperBybit = 'paperBybit',
  paperBybitUsdm = 'paperBybitUsdm',
  paperBybitCoinm = 'paperBybitCoinm',
  paperKucoin = 'paperKucoin',
  paperKucoinLinear = 'paperKucoinLinear',
  paperKucoinInverse = 'paperKucoinInverse',
  paperOkx = 'paperOkx',
  paperOkxLinear = 'paperOkxLinear',
  paperOkxInverse = 'paperOkxInverse',
  paperBitget = 'paperBitget',
  paperBitgetCoinm = 'paperBitgetCoinm',
  paperCoinbase = 'paperCoinbase'
}
```

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|----------|
| `PAPER_WS` | Paper trading WebSocket URL | No | `http://localhost:7506` |
| `PRICEROLE` | Price worker role (`all`, `candle`, `ticker`) | No | `all` |
| `REDIS_HOST` | Redis server host | Yes | `localhost` |
| `REDIS_PORT` | Redis server port | Yes | `6379` |
| `REDIS_PASSWORD` | Redis password | No | - |
| `RABBIT_HOST` | RabbitMQ host | Yes | `localhost` |
| `RABBIT_PORT` | RabbitMQ port | Yes | `5672` |
| `RABBIT_USER` | RabbitMQ username | Yes | `gainium` |
| `RABBIT_PASSWORD` | RabbitMQ password | Yes | - |
| `EXCHANGE_SERVICE_API_URL` | Exchange service URL | No | `http://localhost:7507` |
| `WATCHDOG_APP` | Watchdog service URL | No | `http://localhost:7522` |
| `LOG_LEVEL` | Logging level | No | `info` |
| `DEBUG` | Debug namespaces | No | - |

This developer guide provides comprehensive coverage of the WebSocket Connector's architecture and implementation patterns. For specific exchange implementations, refer to the individual exchange files in the `/src/price/` directory and exchange-specific handlers in `userStream.ts`.