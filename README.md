# WebSocket Connector

<!-- Architecture Diagram Placeholder -->
```
[User Stream Worker] ←→ [Redis] ←→ [RabbitMQ] ←→ [Gainium Backend]
       ↓                   ↑
[Price Stream Worker] ←→ [Health Server]
       ↓
[Exchange WebSockets: Binance, KuCoin, Bybit, OKX, Bitget, Coinbase]
```

## 1. Project Overview

The WebSocket Connector is a critical component of the Gainium ecosystem that streams real-time account and market data between supported cryptocurrency exchanges and the Gainium backend. It acts as a reliable bridge, handling user stream events (account balances, order updates) and price stream data (candlesticks, tickers) through persistent WebSocket connections.

The connector ensures seamless integration with the Gainium trading platform by providing:
- Real-time account state synchronization
- Live market data streaming
- Fault-tolerant connection management
- Multi-exchange support with unified interfaces

## 2. Features / Supported Exchanges

### Supported Exchanges

- **Binance** (Spot, USDM Futures, COINM Futures)
- **KuCoin** (Spot, Linear Futures, Inverse Futures)
- **Bybit** (Spot, USDT Perpetual, Inverse Perpetual)
- **OKX** (Spot, Linear Futures, Inverse Futures)
- **Bitget** (Spot, USDT Futures, Coin Futures)
- **Coinbase** (Spot)

### Key Features

- **Real-time Data Streaming**: Live account balances, order execution updates, and market data
- **Multi-worker Architecture**: Separate workers for user streams and price streams
- **Auto-reconnection**: Intelligent reconnection logic with exponential backoff
- **Paper Trading Support**: Simulation mode for all supported exchanges
- **Health Monitoring**: Built-in health server for Docker deployments
- **Redis Integration**: Caching and state management
- **RabbitMQ Integration**: Message queuing for reliable data delivery

## 3. Architecture Overview

### Core Components

- **User Stream Workers**: Handle real-time account data (balances, orders, positions)
- **Price Stream Workers**: Manage market data streams (candlesticks, tickers)
- **RabbitMQ Integration**: Reliable message queuing between components
- **Redis Integration**: Caching and state persistence
- **Health Server**: HTTP endpoint for monitoring service health

### Data Flow

1. Exchange WebSocket connections stream real-time data
2. Workers process and normalize data from different exchanges
3. Processed data is published to RabbitMQ queues
4. Redis stores connection states and cached data
5. Gainium backend consumes data from RabbitMQ

## 4. Installation

### Prerequisites
- Node.js ≥ 16
- yarn or npm
- Redis server
- RabbitMQ server
- Environment variables configuration

### System Dependencies
- TypeScript compiler
- ESLint and Prettier for code quality
- Husky for pre-commit hooks

## 5. Quick Start

```bash
# Clone the repository
git clone <repository-url>
cd websocket-connector

# Install dependencies
yarn install
# or
npm install

# Copy environment configuration
cp .env.sample .env
# Edit .env with your configuration

# Build the project
yarn build
# or
npm run build

# Run the main application (user streams)
yarn main
# or
npm run main

# Run price stream worker (in separate terminal)
yarn price
# or
npm run price
```

## 6. Configuration

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|----------|
| `PAPER_WS` | Paper trading WebSocket URL | No | `http://localhost:7506` |
| `PRICEROLE` | Price worker role (`all`, `candle`, `ticker`) | No | `all` |
| `COINBASE_API_KEY` | Coinbase API key | No | - |
| `COINBASE_API_SECRET` | Coinbase API secret | No | - |
| `EXCHANGE_SERVICE_API_URL` | Exchange service URL | No | `http://localhost:7507` |
| `WATCHDOG_APP` | Watchdog service URL | No | `http://localhost:7522` |
| `REDIS_HOST` | Redis server host | Yes | `http://localhost` |
| `REDIS_PORT` | Redis server port | Yes | `6379` |
| `REDIS_PASSWORD` | Redis password | No | - |
| `RABBIT_HOST` | RabbitMQ host | Yes | `localhost` |
| `RABBIT_PORT` | RabbitMQ port | Yes | `5672` |
| `RABBIT_USER` | RabbitMQ username | Yes | `gainium` |
| `RABBIT_PASSWORD` | RabbitMQ password | Yes | - |

## 7. Usage Examples

### Creating a User Stream Connector

```javascript
import Connector from './src/userStream';

// Create connector instance
const connector = new Connector();

// Connector automatically starts and handles user streams
// for all configured exchanges
```

### Creating a Price Stream Connector

```javascript
import PriceConnector from './src/priceConnector';

// Create price connector
const priceConnector = new PriceConnector();

// Initialize price streams
priceConnector.init();

// Subscribe to candle data
priceConnector.subscribeCandle({
  symbol: 'BTCUSDT',
  exchange: 'binance',
  interval: '1m'
});
```

### Handling Events

```javascript
// User stream events
connector.on('executionReport', (data) => {
  console.log('Order update:', data);
});

connector.on('outboundAccountPosition', (data) => {
  console.log('Balance update:', data);
});

// Price stream events
priceConnector.on('candle', (candle) => {
  console.log('New candle:', candle);
});

priceConnector.on('ticker', (ticker) => {
  console.log('Ticker update:', ticker);
});
```

### Opening User Stream

```javascript
// Open user stream for specific exchange
connector.openStream({
  userId: 'user123',
  api: {
    key: 'your-api-key',
    secret: 'your-api-secret',
    passphrase: 'your-passphrase', // For OKX
    provider: 'binance',
    environment: 'live' // or 'sandbox'
  }
});
```

### Docker Deployment

```bash
# Build Docker image
docker build -t websocket-connector .

# Run user stream container
docker run -d \
  --name ws-user-stream \
  --env-file .env \
  websocket-connector yarn main

# Run price stream container
docker run -d \
  --name ws-price-stream \
  --env-file .env \
  websocket-connector yarn price
```

### Development Scripts

```bash
# Development with auto-reload
yarn dev

# Run linting
yarn lint

# Fix linting issues
yarn lint:fix

# Type checking
yarn build --noEmit

# Full initialization (reinstall dependencies)
yarn fullInit
```

## 8. API Reference

### Connector Class (UserStream)

Main class for handling user account streams from exchanges.

#### Methods
- `openStream(input: OpenStreamInput)` - Opens WebSocket connection for user data
- `closeStream(userId: string)` - Closes specific user stream
- `reconnect(userId: string)` - Reconnects specific user stream

### PriceConnector Class

Handles market data streams and candle subscriptions.

#### Methods
- `init()` - Initialize price stream workers
- `subscribeCandle(payload: SubscribeCandlePayload)` - Subscribe to candle data
- `stop()` - Stop all price streams

### Types and Events

#### User Stream Events
- `executionReport` - Order execution updates
- `outboundAccountPosition` - Account balance changes
- `balanceUpdate` - Individual balance updates

#### Price Stream Events
- `candle` - OHLCV candlestick data
- `ticker` - 24h ticker statistics

#### Key Interfaces

```typescript
interface ExecutionReport {
  eventType: 'executionReport';
  symbol: string;
  orderId: number | string;
  orderStatus: OrderStatus_LT;
  side: OrderSide_LT;
  price: string;
  quantity: string;
  // ... additional fields
}

interface Candle {
  start: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}
```

## 9. Development

### Code Quality Tools

- **Husky**: Pre-commit hooks ensure code quality
- **ESLint**: Linting with TypeScript support
- **Prettier**: Code formatting
- **TypeScript**: Type safety and modern JavaScript features

### Development Workflow

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Make your changes
4. Run linting: `yarn lint`
5. Run type checking: `yarn build --noEmit`
6. Commit your changes (Husky will run pre-commit hooks)
7. Push to your fork and submit a pull request

### Code Standards

- Follow existing code style and patterns
- Ensure all TypeScript checks pass
- Husky pre-commit hooks must pass
- Use meaningful commit messages
- Add JSDoc comments for public APIs

### Build Process

```bash
# Build TypeScript to JavaScript
yarn build

# Watch mode for development
yarn build --watch

# Clean build
rm -rf dist && yarn build
```

## 10. Troubleshooting / FAQ

### Common Issues

#### Connection Failures
**Problem**: WebSocket connections fail to establish
**Solution**: 
- Check API credentials are correct
- Verify network connectivity
- Ensure exchange API endpoints are accessible
- Check rate limits haven't been exceeded

#### Redis Connection Issues
**Problem**: Cannot connect to Redis
**Solution**:
- Verify Redis server is running
- Check `REDIS_HOST` and `REDIS_PORT` configuration
- Ensure Redis password is correct (if required)

#### RabbitMQ Connection Issues
**Problem**: Cannot connect to RabbitMQ
**Solution**:
- Verify RabbitMQ server is running
- Check `RABBIT_HOST`, `RABBIT_PORT`, `RABBIT_USER`, and `RABBIT_PASSWORD`
- Ensure RabbitMQ virtual host is accessible

#### High Memory Usage
**Problem**: Application consuming too much memory
**Solution**:
- Monitor active WebSocket connections
- Check for memory leaks in event handlers
- Restart workers periodically in production

### Frequently Asked Questions

**Q: Can I run multiple instances of the connector?**
A: Yes, but ensure each instance has unique worker IDs and doesn't conflict with Redis/RabbitMQ resources.

**Q: How do I enable paper trading mode?**
A: Use paper trading exchange enums (e.g., `paperBinance` instead of `binance`) and configure `PAPER_WS` URL.

**Q: What happens if an exchange WebSocket disconnects?**
A: The connector implements automatic reconnection with exponential backoff. Connection state is logged and monitored.

**Q: How do I add support for a new exchange?**
A: Implement the exchange-specific WebSocket client following existing patterns in the `/src` directory and update the exchange enum.

**Q: Can I filter which symbols to stream?**
A: Yes, the connector supports symbol filtering through the subscription mechanism. Configure symbols in your exchange service.

### Debugging

```bash
# Enable debug logging
DEBUG=* yarn main

# Check worker health
curl http://localhost:3000/health

# Monitor Redis keys
redis-cli monitor

# Check RabbitMQ queues
rabbitmqctl list_queues
```

## License

Private - Gainium Platform

## Acknowledgements

- Exchange API libraries: binance, bybit-api, okx-api, bitget-api, coinbase-advanced-node
- Infrastructure: Redis, RabbitMQ, Node.js
- Development tools: TypeScript, ESLint, Prettier, Husky
