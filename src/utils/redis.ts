import { createClient } from 'redis'
import logger from '../utils/logger'
import { isMainThread, threadId } from 'worker_threads'

const prefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`} |`

const getClient = () => {
  const client = createClient({
    password: process.env.REDIS_PASSWORD,
    socket: {
      port: +(process.env.REDIS_PORT ?? 6379),
      host: process.env.REDIS_HOST ?? 'localhost',
      reconnectStrategy: (retries) => {
        const wait = 3000
        logger.error(
          `${prefix} Reconnecting to Redis. Attempt ${retries}. Waiting ${wait}ms to try again.`,
        )
        if (retries > 1000) {
          logger.error(
            `${prefix} Too many attempts to reconnect. Redis connection was terminated`,
          )
          return new Error('Too many retries.')
        }
        return wait
      },
    },
  })
  client.on('error', (err) => logger.error(`Redis Client Error: ${err}`))
  client.connect()
  return client
}

class RedisClient {
  static instance: ReturnType<typeof getClient> | null

  static getInstance() {
    if (!RedisClient.instance) {
      RedisClient.instance = getClient()
    }
    return RedisClient.instance
  }

  static closeInstance() {
    if (RedisClient.instance) {
      RedisClient.instance.quit()
      RedisClient.instance = null
    }
  }
}

export default RedisClient
