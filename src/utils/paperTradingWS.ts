import { Manager } from 'socket.io-client'
import { PaperOrderMessage, PaperOutboundAccountInfo } from '../userStream'
import logger from './logger'

const paper = process.env.PAPER_WS ?? 'localhost:7506'

export const connectPaper = (
  data: { key: string; secret: string },
  cbOrder: (msg: PaperOrderMessage) => void,
  cbAccount: (msg: PaperOutboundAccountInfo) => void,
) => {
  // PAPER_WS may carry any scheme (prod configs vary); only prefix ws:// on a
  // bare host:port — blindly prefixing yields ws://http://… = silently dead socket
  const url = /^(https?|wss?):\/\//.test(paper) ? paper : `ws://${paper}`
  const manager = new Manager(url, {
    transports: ['websocket', 'polling'],
  })

  const socket = manager.socket('/')

  const connect = () => {
    socket.emit(`subscribeOrder`, data)
    socket.emit(`subscribeOutboundAccountInfo`, data)
  }

  socket.on(
    'order',
    (data: {
      type: string
      error?: string
      data: PaperOrderMessage
      info?: string
    }) => {
      if (data.type === 'update') {
        cbOrder(data.data)
      }
      if (data.type === 'info') {
        logger.info(`Paper | order ${data.info}`)
      }
      if (data.type === 'error') {
        logger.error(data.error)
      }
    },
  )
  socket.on(
    'outboundAccountInfo',
    (data: {
      type: string
      error?: string
      data: PaperOutboundAccountInfo
      info?: string
    }) => {
      if (data.type === 'update') {
        cbAccount(data.data)
      }
      if (data.type === 'info') {
        logger.info(`Paper | outboundAccountInfo ${data.info}`)
      }
      if (data.type === 'error') {
        logger.error(data.error)
      }
    },
  )
  socket.on('disconnect', (reason) => logger.warn('Paper | ', reason))
  socket.on('connect', connect)
  socket.connect()
  return () => socket.disconnect()
}
