import * as hl from '@nktkas/hyperliquid'
import logger from './logger'

/**
 * Hyperliquid spot tokens use deployer-chosen names that differ from how
 * the UI renders them. UBTC → BTC (wrapped BTC), USDT0 → USDT (wrapped
 * USDT, used by `cash` dex).
 */
const TOKEN_ALIASES: Record<string, string> = {
  UBTC: 'BTC',
  USDT0: 'USDT',
}
const aliasToken = (name: string): string => TOKEN_ALIASES[name] ?? name

type RawPerpDex = {
  name: string
  fullName?: string
  deployer?: string
  oracleUpdater?: string | null
  feeRecipient?: string | null
  deployerFeeScale?: string
} | null

type RawPerpsUniverseEntry = {
  name: string
  szDecimals: number
  maxLeverage: number
  marginTableId: number
  isDelisted?: boolean
  onlyIsolated?: boolean
  marginMode?: string
}

type RawPerpsMeta = {
  universe: RawPerpsUniverseEntry[]
  collateralToken?: number
}

/**
 * Singleton symbol mapper for Hyperliquid:
 *  - Spot pairs (display `BASE-QUOTE` ↔ wire `@N` / `PURR/USDC`).
 *  - HL native perps (display `BASE-USDC` ↔ wire `BASE`).
 *  - HIP-3 builder dex perps (display `BASE-<QUOTE>` ↔ wire `<dex>:<BASE>`,
 *    with first-uppercase-letter prefix on display when two dexes collide
 *    on a `BASE-<QUOTE>` name).
 *
 * Used by both the price-stream and user-stream microservices.
 */
class HyperliquidSymbolMap {
  private static instance: HyperliquidSymbolMap | null = null
  static getInstance(): HyperliquidSymbolMap {
    if (!HyperliquidSymbolMap.instance) {
      HyperliquidSymbolMap.instance = new HyperliquidSymbolMap()
    }
    return HyperliquidSymbolMap.instance
  }

  /** display pair → wire code */
  private nameToCode: Map<string, string> = new Map()
  /** wire code → display pair */
  private codeToName: Map<string, string> = new Map()
  /** Builder-dex names with at least one listed market (HL native excluded). */
  private dexNames: Set<string> = new Set()
  private lastFetch = 0
  private fetchInterval = 20 * 60 * 1000
  private fetching: Promise<void> | null = null
  private client = new hl.InfoClient({
    transport: new hl.HttpTransport({
      isTestnet: process.env.HYPERLIQUIDENV === 'demo',
    }),
  })

  pairToCode(pair: string): string | undefined {
    return this.nameToCode.get(pair)
  }

  codeToPair(code: string): string | undefined {
    return this.codeToName.get(code)
  }

  size(): number {
    return this.nameToCode.size
  }

  /** Builder-dex names with at least one listed market (HL native excluded). */
  getDexNames(): string[] {
    return [...this.dexNames]
  }

  /**
   * Refresh maps if cache is empty or older than fetchInterval. Concurrent
   * calls share the in-flight refresh; on failure the previous maps are
   * preserved so callers keep returning the last-known mapping.
   */
  async refresh(force = false): Promise<void> {
    if (this.fetching) return this.fetching
    if (
      !force &&
      this.lastFetch + this.fetchInterval > Date.now() &&
      this.nameToCode.size > 0
    ) {
      return
    }
    this.fetching = this._refresh().finally(() => {
      this.fetching = null
    })
    return this.fetching
  }

  private async _refresh(): Promise<void> {
    try {
      const newName = new Map<string, string>()
      const newCode = new Map<string, string>()

      // Spot
      const spot = await this.client.spotMeta()
      const spotTokens = spot.tokens
      spot.universe.forEach((u) => {
        const base = spotTokens.find((t) => t.index === u.tokens[0])
        const baseName = base?.name ? aliasToken(base.name) : undefined
        const quote = spotTokens.find((t) => t.index === u.tokens[1])
        if (!baseName || !quote) return
        const display = `${baseName}-${aliasToken(quote.name)}`
        newName.set(display, u.name)
        newCode.set(u.name, display)
      })

      // Futures: HL native + builder dexes via perpDexs(). Builder-dex pairs
      // are always prefixed `provider:BASE-QUOTE`; HL native stays unprefixed.
      const perpDexs = (await this.client.perpDexs()) as RawPerpDex[]
      const newDexNames = new Set<string>()
      for (let i = 0; i < perpDexs.length; i++) {
        const dex = perpDexs[i]
        const meta = (await (dex
          ? this.client.meta({ dex: dex.name })
          : this.client.meta())) as unknown as RawPerpsMeta
        if (!meta.universe || meta.universe.length === 0) continue
        if (dex) newDexNames.add(dex.name)
        const collateralIdx = meta.collateralToken ?? 0
        const quoteToken = spotTokens.find((t) => t.index === collateralIdx)
        const quoteAsset = quoteToken?.name
          ? aliasToken(quoteToken.name)
          : 'USDC'
        meta.universe.forEach((u) => {
          const code = u.name
          const baseRaw = dex ? (u.name.split(':')[1] ?? u.name) : u.name
          const baseName = aliasToken(baseRaw)
          const basePair = `${baseName}-${quoteAsset}`
          const pair = dex ? `${dex.name}:${basePair}` : basePair
          // HL native spot (e.g. UBTC/USDC → 'BTC-USDC') and HL native perp
          // ('BTC-USDC') share a display pair. We process spot first, then
          // futures, so this overwrite makes the futures wire code win on
          // pairToCode lookups. codeToName keeps both since wire codes are
          // unique ('@142' vs 'BTC').
          newName.set(pair, code)
          newCode.set(code, pair)
        })
      }

      if (newName.size > 0) {
        this.nameToCode = newName
        this.codeToName = newCode
        this.dexNames = newDexNames
        this.lastFetch = Date.now()
        logger.info(
          `Loaded ${this.nameToCode.size} Hyperliquid symbol mappings`,
        )
      }
    } catch (e) {
      logger.error(
        `Failed to refresh Hyperliquid symbol map (keeping ${this.nameToCode.size} existing): ${e}`,
      )
    }
  }
}

export default HyperliquidSymbolMap
