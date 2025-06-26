import { isMainThread, threadId } from 'worker_threads'

import amqplib, {
  type Connection,
  type Channel,
  type Replies,
} from 'amqplib/callback_api'

import logger from '../utils/logger'
import { IdMute, IdMutex } from '../utils/mutex'

const rabbitExchange = 'gainium'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const prefix = `${isMainThread ? 'Main thread' : `Worker ${threadId}`} |`

const mutex = new IdMutex()

const retryTimeout = 30 * 1000

class Client {
  static client: Connection | null = null
  static channel: Channel | null = null

  static async reconnect() {
    logger.info(`${prefix} Reconnect RabbitMQ`)
    Client.client = null
    Client.channel = null
    Client.connect()
  }

  @IdMute(mutex, () => 'rabbitconnect')
  static async connect() {
    logger.info(`${prefix} Connect RabbitMQ`)
    if (Client.client) {
      logger.info(`${prefix} RabbitMQ already connected`)
      return
    }
    await new Promise((resolve) => {
      amqplib.connect(
        `amqp://${process.env.RABBIT_USER}:${process.env.RABBIT_PASSWORD}@${
          process.env.RABBIT_HOST ?? 'localhost'
        }`,
        async (err, conn) => {
          conn?.on('error', async (_err) => {
            logger.error(`${prefix} RabbitMQ Client Error: ${_err}`)
            await sleep(retryTimeout)
            await Client.reconnect()
          })
          conn?.on('close', async (_err) => {
            logger.error(`${prefix} RabbitMQ Client Closed: ${_err}`)
            await sleep(retryTimeout)
            await Client.reconnect()
          })
          if (err) {
            logger.error(`${prefix} RabbitMQ Client Connection Error: ${err}`)
            await sleep(retryTimeout)
            Client.connect()
            resolve([])
          }
          Client.client = Client.client ?? conn ?? null
          if (!Client.channel) {
            await new Promise((resolve2) => {
              Client.client?.createChannel(async (_, channel) => {
                channel?.assertExchange(rabbitExchange, 'direct', {
                  durable: true,
                })
                Client.channel = Client.channel ?? channel ?? null
                resolve2([])
              })
            })
          }

          resolve([])
        },
      )
    })
  }

  @IdMute(mutex, () => 'rabbitgetclient')
  static async getClient(): Promise<{
    client: Connection | null
    channel: Channel | null
  }> {
    if (!Client.client || !Client.channel) {
      await Client.connect()
    }
    return { client: Client.client, channel: Client.channel }
  }
}

class Rabbit {
  public client: Connection | null = null
  public channel: Channel | null = null

  private async getClient() {
    return await Client.getClient()
  }

  async listenWithCallback<P>(
    queue: string,
    callback: (data: P) => Promise<void> | void,
    maxSize?: number,
    count = 0,
  ): Promise<string | null> {
    try {
      logger.info(`${prefix} Listen with callback for ${queue}`)
      const { client, channel } = await this.getClient()
      if (!client || !channel) {
        logger.error(
          `${prefix} No client or channel in listenWithCallback for ${queue}`,
        )
        throw new Error('No client or channel')
      }
      client.on('close', () =>
        this.listenWithCallback.bind(this)(queue, callback, maxSize),
      )
      const q = await new Promise<Replies.AssertQueue>((resolve) => {
        channel.assertQueue(queue, undefined, (_, q) => {
          resolve(q)
        })
      })
      await new Promise((resolve) =>
        channel.bindQueue(q.queue, rabbitExchange, queue, undefined, resolve),
      )
      if (typeof maxSize === 'number') {
        channel.prefetch(maxSize)
      }
      const consume = await new Promise<Replies.Consume>((resolve) => {
        channel.consume(
          queue,
          async (msg) => {
            if (!msg) {
              return
            }
            const request = JSON.parse(msg.content.toString())
            const payload = request.payload as P

            try {
              await callback(payload)
              channel.ack(msg)
            } catch (e) {
              logger.error(
                `${prefix} Error in listenWithCallback for ${queue}: ${e}`,
              )
            }
          },
          undefined,
          (_, ok) => {
            resolve(ok)
          },
        )
      })

      return consume.consumerTag
    } catch (e) {
      logger.error(
        `${prefix} Error in listenWithCallback for ${queue}: ${e} ${count}`,
      )
      if (count < 5) {
        logger.info(`${prefix} Retry listenWithCallback for ${queue}`)
        await sleep(retryTimeout)
        return this.listenWithCallback(queue, callback, maxSize, count + 1)
      }
      return null
    }
  }
}

export default Rabbit
