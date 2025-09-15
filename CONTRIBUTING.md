# Contributing to WebSocket Connector

Thank you for your interest in contributing to the WebSocket Connector service! This document provides guidelines and instructions for contributing to this project.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Adding New Exchanges](#adding-new-exchanges)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Pull Request Process](#pull-request-process)
- [WebSocket Implementation Guidelines](#websocket-implementation-guidelines)

## Development Setup

### Prerequisites

- Node.js 16+
- npm 8+
- TypeScript 5.8+
- Redis server
- RabbitMQ server
- Git

### Initial Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd websocket-connector-sh
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Configuration**
   ```bash
   cp .env.sample .env
   # Edit .env with your configuration
   ```

4. **Build the project**
   ```bash
   npm run build
   ```

5. **Run the services**
   ```bash
   # Terminal 1: User streams
   npm run main
   
   # Terminal 2: Price streams
   npm run price
   ```

### Available Scripts

```bash
# Development
npm run build              # Build TypeScript to JavaScript
npm run main               # Run user stream connector
npm run price              # Run price stream connector

# Code Quality
npm run lint               # Run ESLint and TypeScript checks
npm run lint:fix           # Fix ESLint issues

# Maintenance
npm run fullInit           # Full initialization with KuCoin API
npm run push               # Git push to main
npm run pull               # Git pull from main
```

## Project Structure

```
websocket-connector-sh/
├── src/
│   ├── index.js                    # User stream entry point
│   ├── index.price.js              # Price stream entry point
│   ├── userStream.ts               # Main user stream connector
│   ├── priceConnector.ts           # Price stream connector
│   ├── price/                      # Price stream implementations
│   │   ├── service.ts              # Price service coordinator
│   │   ├── worker.js               # Worker thread implementation
│   │   ├── types.ts                # Price stream type definitions
│   │   ├── common.ts               # Shared price utilities
│   │   ├── binance.ts              # Binance price streams
│   │   ├── bybit.ts                # Bybit price streams
│   │   ├── kucoin.ts               # KuCoin price streams
│   │   ├── okx.ts                  # OKX price streams
│   │   ├── bitget.ts               # Bitget price streams
│   │   └── coinbase.ts             # Coinbase price streams
│   └── utils/                      # Utility modules
│       ├── binance.ts              # Binance utilities
│       ├── kucoin.ts               # KuCoin utilities
│       ├── common.ts               # Common enums and functions
│       ├── exchange.ts             # Exchange utilities
│       ├── logger.ts               # Logging utilities
│       ├── mutex.ts                # Concurrency control
│       ├── redis.ts                # Redis client
│       ├── rabbit.ts               # RabbitMQ client
│       ├── sleep.ts                # Sleep utilities
│       └── paperTradingWS.ts       # Paper trading WebSocket
├── bybit-custom/                   # Custom Bybit client
├── type.ts                         # Global type definitions
├── package.json
├── tsconfig.json
├── eslint.config.mjs
└── .prettierrc.js
```

### Key Components

- **User Stream Connector**: Handles real-time account data (balances, orders, positions)
- **Price Stream Connector**: Manages market data streams (candles, tickers)
- **Exchange Implementations**: Specific WebSocket integrations for each exchange
- **Utility Modules**: Shared functionality for logging, caching, messaging
- **Worker Threads**: Multi-threaded price stream processing

## Adding New Exchanges

### Step 1: Create Exchange Price Stream Implementation

Create a new file in `src/price/newexchange.ts`:

```typescript
import { ExchangeEnum } from '../utils/common'
import logger from '../utils/logger'
import { Candle, Ticker } from './types'

class NewExchangeConnector {
  private subscribedCandlesMap: Map<ExchangeEnum, Set<string>>
  private ws: WebSocket | null = null
  
  constructor(subscribedCandlesMap: Map<ExchangeEnum, Set<string>>) {
    this.subscribedCandlesMap = subscribedCandlesMap
  }
  
  async connect(): Promise<void> {
    try {
      this.ws = new WebSocket('wss://new-exchange-websocket-url')
      
      this.ws.onopen = () => {
        logger.info('NewExchange WebSocket connected')
        this.subscribeToStreams()
      }
      
      this.ws.onmessage = (event) => {
        this.handleMessage(JSON.parse(event.data))
      }
      
      this.ws.onclose = () => {
        logger.warn('NewExchange WebSocket disconnected')
        this.reconnect()
      }
      
      this.ws.onerror = (error) => {
        logger.error('NewExchange WebSocket error:', error)
      }
    } catch (error) {
      logger.error('NewExchange connection failed:', error)
      throw error
    }
  }
  
  private subscribeToStreams(): void {
    const symbols = this.subscribedCandlesMap.get(ExchangeEnum.newexchange)
    if (!symbols || symbols.size === 0) return
    
    // Subscribe to candlestick streams
    for (const symbol of symbols) {
      this.subscribeToCandles(symbol)
    }
  }
  
  private subscribeToCandles(symbol: string): void {
    const subscribeMessage = {
      method: 'SUBSCRIBE',
      params: [`${symbol.toLowerCase()}@kline_1m`],
      id: Date.now()
    }
    
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(subscribeMessage))
    }
  }
  
  private handleMessage(data: any): void {
    if (data.stream && data.stream.includes('@kline_')) {
      this.handleCandleMessage(data)
    }
  }
  
  private handleCandleMessage(data: any): void {
    const kline = data.data.k
    const candle: Candle = {
      start: kline.t,
      open: kline.o,
      high: kline.h,
      low: kline.l,
      close: kline.c,
      volume: kline.v
    }
    
    // Emit candle data to parent process
    if (process.send) {
      process.send({
        type: 'candle',
        exchange: ExchangeEnum.newexchange,
        symbol: kline.s,
        data: candle
      })
    }
  }
  
  private reconnect(): void {
    setTimeout(() => {
      this.connect().catch(error => {
        logger.error('NewExchange reconnection failed:', error)
      })
    }, 5000)
  }
  
  disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}

export default NewExchangeConnector
```

### Step 2: Update Price Service

Add your exchange to `src/price/service.ts`:

```typescript
import NewExchangeConnector from './newexchange'

type ConnectorType =
  | ExchangeEnum.binance
  | ExchangeEnum.bybit
  | ExchangeEnum.kucoin
  | ExchangeEnum.okx
  | ExchangeEnum.coinbase
  | ExchangeEnum.bitget
  | ExchangeEnum.newexchange // Add your exchange

const createConnector = (exchange: ConnectorType, payload: Payload) => {
  // ... existing cases
  if (exchange === ExchangeEnum.newexchange) {
    return new NewExchangeConnector(payload.subscribedCandlesMap)
  }
  // ... rest of function
}
```

### Step 3: Add User Stream Support

Add user stream handling to `src/userStream.ts`:

```typescript
// Add to the main UserStream class
private async connectNewExchange(userId: string, api: ApiCredentials): Promise<void> {
  try {
    // Initialize WebSocket connection with user credentials
    const ws = new WebSocket(`wss://new-exchange-user-stream-url`)
    
    ws.onopen = () => {
      logger.info(`NewExchange user stream opened for user ${userId}`)
      this.authenticate(ws, api)
    }
    
    ws.onmessage = (event) => {
      this.handleNewExchangeMessage(userId, JSON.parse(event.data))
    }
    
    ws.onclose = () => {
      logger.warn(`NewExchange user stream closed for user ${userId}`)
      this.scheduleReconnect(userId, api)
    }
    
    // Store connection reference
    this.connections.set(`${userId}_newexchange`, ws)
    
  } catch (error) {
    logger.error(`NewExchange connection failed for user ${userId}:`, error)
    throw error
  }
}

private handleNewExchangeMessage(userId: string, data: any): void {
  // Handle different message types
  switch (data.e) {
    case 'executionReport':
      this.handleOrderUpdate(userId, this.mapNewExchangeOrder(data))
      break
    case 'outboundAccountPosition':
      this.handleBalanceUpdate(userId, this.mapNewExchangeBalance(data))
      break
    default:
      logger.debug(`Unknown NewExchange message type: ${data.e}`)
  }
}
```

### Step 4: Update Common Utilities

Add your exchange to `src/utils/common.ts`:

```typescript
export enum ExchangeEnum {
  // ... existing exchanges
  newexchange = 'newexchange',
  paperNewexchange = 'paperNewexchange',
}

export const mapPaperToReal = (exchange: string): string => {
  const mapping: Record<string, string> = {
    // ... existing mappings
    [ExchangeEnum.paperNewexchange]: ExchangeEnum.newexchange,
  }
  return mapping[exchange] || exchange
}
```

### Step 5: Add Package Dependencies

If your exchange requires specific packages:

```bash
npm install newexchange-websocket-api
```

Update `package.json` dependencies as needed.

## Coding Standards

### TypeScript Guidelines

- **Strict Mode**: Always use TypeScript strict mode
- **Type Safety**: Prefer explicit types over `any`
- **Interface Consistency**: Use consistent interfaces for WebSocket messages
- **Error Handling**: Implement proper error handling with reconnection logic

```typescript
// ✅ Good - Proper type definitions and error handling
interface OrderUpdateMessage {
  eventType: 'executionReport'
  symbol: string
  orderId: string
  orderStatus: string
  side: string
  price: string
  quantity: string
}

async connectExchange(credentials: ApiCredentials): Promise<void> {
  try {
    const ws = new WebSocket(this.getWebSocketUrl(credentials))
    this.setupEventHandlers(ws)
  } catch (error) {
    logger.error('Connection failed:', error)
    throw error
  }
}

// ❌ Bad - No types and poor error handling
async connectExchange(credentials: any): Promise<any> {
  const ws = new WebSocket('some-url')
  // No error handling
}
```

### WebSocket Patterns

Follow established patterns for WebSocket handling:

```typescript
// Connection Management
class ExchangeConnector {
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  
  async connect(): Promise<void> {
    // Connection logic
  }
  
  private setupEventHandlers(ws: WebSocket): void {
    ws.onopen = () => this.handleOpen()
    ws.onmessage = (event) => this.handleMessage(event)
    ws.onclose = () => this.handleClose()
    ws.onerror = (error) => this.handleError(error)
  }
  
  private async handleClose(): Promise<void> {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      await this.reconnect()
    }
  }
  
  private async reconnect(): Promise<void> {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++
    
    setTimeout(() => {
      this.connect().catch(error => {
        logger.error('Reconnection failed:', error)
      })
    }, delay)
  }
}
```

### Message Handling

Standardize message processing:

```typescript
// Message Processing Pattern
private handleMessage(event: MessageEvent): void {
  try {
    const data = JSON.parse(event.data)
    
    switch (data.eventType || data.e) {
      case 'executionReport':
        this.processOrderUpdate(data)
        break
      case 'outboundAccountPosition':
        this.processBalanceUpdate(data)
        break
      default:
        logger.debug(`Unhandled message type: ${data.eventType || data.e}`)
    }
  } catch (error) {
    logger.error('Message parsing failed:', error)
  }
}

// Data Mapping
private mapToStandardFormat(exchangeData: any): StandardOrder {
  return {
    orderId: exchangeData.i || exchangeData.orderId,
    symbol: exchangeData.s || exchangeData.symbol,
    side: this.mapSide(exchangeData.S || exchangeData.side),
    price: exchangeData.p || exchangeData.price,
    quantity: exchangeData.q || exchangeData.quantity,
    status: this.mapStatus(exchangeData.X || exchangeData.status),
    timestamp: exchangeData.T || exchangeData.timestamp
  }
}
```

## Testing Guidelines

### Unit Testing

Create tests for exchange-specific logic:

```typescript
describe('NewExchangeConnector', () => {
  let connector: NewExchangeConnector
  let mockWebSocket: jest.Mocked<WebSocket>
  
  beforeEach(() => {
    mockWebSocket = createMockWebSocket()
    connector = new NewExchangeConnector(new Map())
  })
  
  it('should connect to WebSocket successfully', async () => {
    await connector.connect()
    expect(mockWebSocket.send).toHaveBeenCalled()
  })
  
  it('should handle order update messages', () => {
    const orderMessage = {
      eventType: 'executionReport',
      symbol: 'BTCUSDT',
      orderId: '12345'
    }
    
    connector.handleMessage(orderMessage)
    // Assert message was processed correctly
  })
  
  it('should reconnect on connection loss', async () => {
    const reconnectSpy = jest.spyOn(connector, 'reconnect')
    
    // Simulate connection close
    mockWebSocket.onclose?.(new CloseEvent('close'))
    
    expect(reconnectSpy).toHaveBeenCalled()
  })
})
```

### Integration Testing

Test with exchange sandbox/testnet environments:

```typescript
describe('Exchange Integration', () => {
  it('should connect to exchange testnet', async () => {
    const connector = new NewExchangeConnector(new Map(), {
      sandbox: true,
      apiKey: process.env.TESTNET_API_KEY,
      apiSecret: process.env.TESTNET_API_SECRET
    })
    
    await expect(connector.connect()).resolves.not.toThrow()
  })
})
```

### Manual Testing

Use development scripts for manual testing:

```bash
# Test specific exchange connection
DEBUG=newexchange npm run main

# Monitor WebSocket messages
DEBUG=websocket npm run price
```

## Pull Request Process

### Before Submitting

1. **Code Quality Checks**
   ```bash
   npm run lint
   npm run build
   ```

2. **Environment Testing**
   - Test with both live and paper trading modes
   - Verify reconnection logic works
   - Test with multiple symbols/markets

3. **Documentation Updates**
   - Update README.md if adding new features
   - Add JSDoc comments for public APIs
   - Include usage examples

### PR Requirements

1. **WebSocket Compliance**: Follow established WebSocket patterns
2. **Error Handling**: Implement proper error handling and reconnection
3. **Message Mapping**: Use consistent data mapping to standard formats
4. **Paper Trading**: Support both live and paper trading modes
5. **Logging**: Include appropriate logging for debugging

### PR Template

```markdown
## Description
Brief description of the exchange implementation or changes

## Exchange Details
- Exchange Name: [Exchange Name]
- WebSocket API Version: [Version]
- Supported Features: [User streams, Price streams, Paper trading]
- Market Types: [Spot, Futures, Options]

## Testing
- [ ] WebSocket connection established successfully
- [ ] Message handling works correctly
- [ ] Reconnection logic implemented
- [ ] Paper trading mode supported
- [ ] Manual testing completed
- [ ] Error handling tested

## Documentation
- [ ] JSDoc comments added
- [ ] README updated if needed
- [ ] Usage examples included
```

## WebSocket Implementation Guidelines

### Connection Management

All WebSocket implementations must follow these patterns:

1. **Automatic Reconnection**: Implement exponential backoff reconnection
2. **Connection State Tracking**: Monitor connection health
3. **Graceful Shutdown**: Clean up resources on disconnect
4. **Error Handling**: Log errors and attempt recovery

### Message Processing

1. **Type Safety**: Use TypeScript interfaces for all messages
2. **Standard Mapping**: Map exchange-specific data to common formats
3. **Event Emission**: Use consistent event names across exchanges
4. **Error Recovery**: Handle malformed messages gracefully

### Authentication

1. **Secure Credentials**: Never log API keys or secrets
2. **Token Management**: Handle authentication tokens properly
3. **Reconnection Auth**: Re-authenticate on reconnection
4. **Paper Trading**: Support paper trading authentication

### Performance Considerations

1. **Memory Management**: Clean up event listeners and connections
2. **Rate Limiting**: Respect exchange rate limits
3. **Message Queuing**: Use RabbitMQ for reliable message delivery
4. **Worker Threads**: Use worker threads for CPU-intensive processing

## Getting Help

- **Architecture Questions**: Consult with the core team
- **WebSocket Issues**: Check exchange documentation and test in sandbox
- **Connection Problems**: Verify network connectivity and credentials
- **Performance Issues**: Monitor memory usage and connection counts

## Recognition

Contributors will be acknowledged in:
- Project documentation
- Release notes for significant contributions
- Internal team recognition

Thank you for contributing to the WebSocket Connector service!