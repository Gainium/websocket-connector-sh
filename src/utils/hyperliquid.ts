import * as hl from '@nktkas/hyperliquid'

import logger from './logger'
import { IdMute, IdMutex } from 'src/utils/mutex'

const mutex = new IdMutex()

class HyperliquidAssets {
  static HyperliquidAssetsInstance: HyperliquidAssets
  static getInstance() {
    if (!HyperliquidAssets.HyperliquidAssetsInstance) {
      HyperliquidAssets.HyperliquidAssetsInstance = new HyperliquidAssets()
    }
    return HyperliquidAssets.HyperliquidAssetsInstance
  }

  private assets: Map<string, number> = new Map()
  private pairs: Map<number, string> = new Map()
  private lastUpdate = 0
  private updateInterval = 20 * 60000
  private client: hl.InfoClient = new hl.InfoClient({
    transport: new hl.HttpTransport({
      isTestnet: process.env.HYPERLIQUIDENV === 'demo',
    }),
  })

  @IdMute(mutex, () => 'getCoinByPair')
  public async getCoinByPair(pair: string) {
    if (
      this.assets.size === 0 ||
      this.lastUpdate + this.updateInterval < Date.now()
    ) {
      await this.updateAssets()
    }
    return `${10000 + (this.assets.get(pair) ?? 0)}` || pair.split('-')[0]
  }

  @IdMute(mutex, () => 'getCoinByPair')
  public async getPairByCoin(coin: string) {
    if (
      this.assets.size === 0 ||
      this.lastUpdate + this.updateInterval < Date.now()
    ) {
      await this.updateAssets()
    }
    return this.pairs.get(+coin.replace('@', '')) ?? coin
  }

  private async updateAssets() {
    try {
      const assets = await this.client.spotMeta()
      const { tokens, universe } = assets
      universe.forEach((u) => {
        const base = tokens.find((tk) => tk.index === u.tokens[0])
        const quote = tokens.find((tk) => tk.index === u.tokens[1])
        if (base && quote) {
          this.assets.set(`${base.name}-${quote.name}`, u.tokens[0])
        }
      })
      const futures = await this.client.meta()
      futures.universe.forEach((u, i) => {
        this.assets.set(`${u.name}-USD`, i)
      })
    } catch (e) {
      logger.error(
        `Error updating Hyperliquid assets: ${(e as Error)?.message}`,
      )
      return
    }
  }
}

export default HyperliquidAssets.getInstance()
