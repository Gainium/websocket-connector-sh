/**
 * Worker-thread entry for test/priceWorkerStallExit.test.ts.
 *
 * Runs the REAL `src/price/service.ts` (its uncaughtException handler and
 * in-thread rebuild) and the REAL `CommonConnector` watchdog, with the Bitget
 * connector swapped for a fake venue whose behaviour `workerData.mode` picks:
 *   - `dead`: never delivers a tick, so every connector stalls on connect;
 *   - `blip`: every other connector delivers one tick, then goes quiet.
 * Timeouts are shrunk from 50s to ~150ms so a stall ladder takes under a
 * second. Each connector construction is reported to the parent, which is
 * how the test counts in-thread rebuilds.
 */
import Module from 'module'
import { parentPort, workerData } from 'worker_threads'
import CommonConnector from '../../src/price/common'
import { ExchangeEnum } from '../../src/utils/common'

let built = 0

class FakeVenueConnector extends CommonConnector {
  private n: number
  constructor() {
    super()
    this.n = ++built
    if (this.watchdog) {
      clearInterval(this.watchdog)
    }
    this.connectTime = 150
    this.timeout = 150
    this.watchdog = setInterval(
      (this as any).watchdogFn,
      Math.floor(workerData.tickMs ?? 100),
    )
    parentPort?.postMessage({ built: this.n })
  }

  init() {
    this.mainData[ExchangeEnum.bitgetUsdm] = { ...this.base }
    if (workerData.mode === 'blip' && this.n % 2 === 0) {
      setTimeout(() => {
        this.cbWs(
          [
            {
              eventType: '24hrMiniTicker',
              eventTime: Date.now(),
              curDayClose: '1',
              open: '1',
              high: '1',
              low: '1',
              volume: '1',
              volumeQuote: '1',
              symbol: 'BTCUSDT',
              bestBid: '1',
              bestAsk: '1',
              bestAskQnt: '1',
              bestBidQnt: '1',
            } as any,
          ],
          ExchangeEnum.bitgetUsdm,
        )
      }, 20)
    }
  }
}

const bitgetPath = require.resolve('../../src/price/bitget')
const stub = new Module(bitgetPath)
stub.filename = bitgetPath
stub.loaded = true
stub.exports = { __esModule: true, default: FakeVenueConnector }
require.cache[bitgetPath] = stub

// after the stub, so service.ts resolves the fake connector
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../src/price/service')
