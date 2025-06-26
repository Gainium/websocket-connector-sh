import Connector from './src/priceConnector'
import logger from './src/utils/logger'
import sleep from './src/utils/sleep'
import { skipReason } from './type'
import HealthServer from './src/utils/healthServer'

// Start health server for Docker health checks
const healthServer = new HealthServer()
healthServer.start()

let retry = 0

const retryCount = 4

let retryStart = 0

const retryTimeout = 60 * 1000

const getStream = () => {
  const str = new Connector()
  str.init()
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
    stream.stop()
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
    console.log(err)
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
    stream.stop()
    stream = getStream()
  })
