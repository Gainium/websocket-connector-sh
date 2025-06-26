import * as http from 'http'
import logger from './logger'

const DEFAULT_HEALTH_PORT = 3000

interface HealthResponse {
  status: string
  uptime: number
  timestamp: number
  service?: string
}

export class HealthServer {
  private server: http.Server | null = null

  start(port: number = DEFAULT_HEALTH_PORT): void {
    try {
      this.server = http.createServer(this.handleRequest.bind(this))

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.info(
            `Health server port ${port} is in use - ignoring for standalone deployment`,
          )
          return
        }
        logger.error(`Health server error: ${err.message}`)
      })

      this.server.listen(port, () => {
        logger.info(`Health server listening on port ${port}`)
      })
    } catch (error) {
      logger.error(`Failed to start health server: ${error}`)
    }
  }

  stop(): void {
    if (this.server) {
      this.server.close(() => {
        logger.info('Health server stopped')
      })
      this.server = null
    }
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (req.url === '/health' && req.method === 'GET') {
      const healthResponse: HealthResponse = {
        status: 'ok',
        uptime: process.uptime(),
        timestamp: Date.now(),
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(healthResponse))
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not Found' }))
    }
  }
}

export default HealthServer
