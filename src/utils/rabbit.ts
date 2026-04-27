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

const sendMutex = new IdMutex(1000)

class ChannelPool {
  private channels: Channel[] = []
  private dedicatedChannels: Channel[] = []
  private currentIndex = 0
  private dedicatedIndex = 0
  private connection: Connection | null = null
  private poolSize = 5

  constructor(connection: Connection) {
    this.connection = connection
  }

  async initialize(): Promise<void> {
    logger.info(
      `${prefix} Initializing channel pool with size ${this.poolSize}`,
    )
    for (let i = 0; i < this.poolSize; i++) {
      await this.addChannel()
    }

    for (let i = 0; i < this.poolSize; i++) {
      await this.addDedicatedChannel()
    }

    logger.info(
      `${prefix} Channel pool initialized with ${this.channels.length} regular and ${this.dedicatedChannels.length} dedicated channels`,
    )
  }

  private async addChannel(): Promise<void> {
    if (!this.connection) {
      throw new Error('No connection available for channel creation')
    }

    await new Promise<void>((resolve) => {
      this.connection?.createChannel(async (err, channel) => {
        if (err || !channel) {
          logger.error(`${prefix} Failed to create channel: ${err}`)
          resolve()
          return
        }

        channel.assertExchange(rabbitExchange, 'direct', {
          durable: true,
        })

        this.channels.push(channel)
        resolve()
      })
    })
  }

  private async addDedicatedChannel(): Promise<void> {
    if (!this.connection) {
      throw new Error('No connection available for channel creation')
    }

    await new Promise<void>((resolve) => {
      this.connection?.createChannel((err, channel) => {
        if (err || !channel) {
          logger.error(`${prefix} Failed to create dedicated channel: ${err}`)
          resolve()
          return
        }

        channel.prefetch(1)

        this.dedicatedChannels.push(channel)
        resolve()
      })
    })
  }

  getChannel(): Channel | null {
    if (this.channels.length === 0) {
      return null
    }

    const channel = this.channels[this.currentIndex]
    this.currentIndex = (this.currentIndex + 1) % this.channels.length
    return channel
  }

  getDedicatedChannel(): Channel | null {
    if (this.dedicatedChannels.length === 0) {
      if (this.connection) {
        let channel: Channel | null = null
        this.connection.createChannel((err, ch) => {
          if (!err && ch) {
            channel = ch
          }
        })
        if (channel) {
          if (this.dedicatedChannels.length < this.poolSize) {
            this.dedicatedChannels.push(channel)
          }
          return channel
        }
      }
      return null
    }

    const channel = this.dedicatedChannels[this.dedicatedIndex]
    this.dedicatedIndex =
      (this.dedicatedIndex + 1) % this.dedicatedChannels.length
    return channel
  }

  close(): void {
    this.channels.forEach((channel) => {
      try {
        channel.close(() => null)
      } catch (err) {
        logger.error(`${prefix} Error closing channel: ${err}`)
      }
    })
    this.dedicatedChannels.forEach((channel) => {
      try {
        channel.close(() => null)
      } catch (err) {
        logger.error(`${prefix} Error closing dedicated channel: ${err}`)
      }
    })
    this.channels = []
    this.dedicatedChannels = []
  }
}

class Client {
  static client: Connection | null = null
  static channelPool: ChannelPool | null = null
  static channel: Channel | null = null // Keep for backward compatibility

  static async reconnect() {
    logger.info(`${prefix} Reconnect RabbitMQ`)
    if (Client.channelPool) {
      Client.channelPool.close()
      Client.channelPool = null
    }
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

          if (Client.client && !Client.channelPool) {
            Client.channelPool = new ChannelPool(Client.client)
            await Client.channelPool.initialize()

            if (!Client.channel && Client.channelPool) {
              Client.channel = Client.channelPool.getChannel()
            }
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
    channelPool: ChannelPool | null
  }> {
    if (!Client.client || !Client.channelPool) {
      await Client.connect()
    }
    return {
      client: Client.client,
      channel: Client.channel,
      channelPool: Client.channelPool,
    }
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

  @IdMute(sendMutex, (queue: string) => `rabbit-send-${queue}`)
  async send<P>(queue: string, payload: P): Promise<void> {
    try {
      const { client, channelPool } = await this.getClient()
      if (!client || !channelPool) {
        logger.error(`${prefix} No client or channelPool in send in ${queue}`)
        return
      }

      const channel = channelPool.getChannel()
      if (!channel) {
        logger.error(`${prefix} Failed to get channel for send to ${queue}`)
        return
      }
      const result = channel.publish(
        rabbitExchange,
        queue,
        Buffer.from(JSON.stringify({ payload })),
      )
      if (!result) {
        logger.error(
          `${prefix} Failed to send message to queue ${queue} in send`,
        )
        return
      }
    } catch (e) {
      logger.error(`${prefix} Error in send in ${queue}: ${e}, ${payload}`)
      return
    }
  }
}

export default Rabbit
