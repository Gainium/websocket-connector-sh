import * as hl from '@nktkas/hyperliquid'
import logger from './logger'

/**
 * Hyperliquid spot tokens use deployer-chosen names that differ from the
 * canonical ticker the rest of the platform thinks in. The dominant case is
 * **Unit** (hyperunit.xyz), which bridges spot assets under a `U`-prefixed
 * name whose `fullName` is `Unit <Asset>` (UBTC/'Unit Bitcoin',
 * UETH/'Unit Ethereum', …). We display those under the stripped ticker
 * (UBTC→BTC), derived authoritatively from Hyperliquid's own `spotMeta`
 * (fullName starts with 'Unit ' AND name starts with 'U'), never a blanket
 * strip. Guards: safe-ident + no collision with an already-listed token
 * (UPUMP→PUMP stays raw). `USDT0` (wrapped-USDT quote, not a Unit token)
 * keeps a small explicit alias to USDT.
 *
 * MUST stay identical to the connector's `buildTokenDisplayMap`
 * (exchange-connector-sh `hyperliquid/index.ts`): the pair↔wire mapping here
 * and the pair naming there have to agree, or streams for a normalized pair
 * fail to resolve. See root Danger List #5.
 */
const QUOTE_TOKEN_ALIASES: Record<string, string> = { USDT0: 'USDT' }

function buildTokenDisplayMap(
  tokens: ReadonlyArray<{ name: string; fullName?: string | null }>,
): Map<string, string> {
  const rawNames = new Set(tokens.map((t) => t.name))
  const proposals: Array<[string, string]> = []
  const proposedCount = new Map<string, number>()
  for (const t of tokens) {
    if (
      (t.fullName ?? '').startsWith('Unit ') &&
      t.name.startsWith('U') &&
      t.name.length > 1
    ) {
      const stripped = t.name.slice(1)
      if (isSafeIdent(stripped)) {
        proposals.push([t.name, stripped])
        proposedCount.set(stripped, (proposedCount.get(stripped) ?? 0) + 1)
      }
    }
  }
  const map = new Map<string, string>()
  for (const [name, display] of proposals) {
    if (rawNames.has(display)) continue
    if ((proposedCount.get(display) ?? 0) > 1) continue
    map.set(name, display)
  }
  for (const [from, to] of Object.entries(QUOTE_TOKEN_ALIASES)) {
    if (!rawNames.has(to) && !map.has(from)) map.set(from, to)
  }
  return map
}

/** Rebuilt on every spotMeta fetch. Seeded with the old static pair so a
 *  failed/late first fetch can't regress UBTC/USDT0. */
let tokenDisplayMap: Map<string, string> = new Map([
  ['UBTC', 'BTC'],
  ['USDT0', 'USDT'],
])
const aliasToken = (name: string): string => tokenDisplayMap.get(name) ?? name

/**
 * HIP-3 builder dexes let third-party deployers register arbitrary
 * asset names. Names propagate into pair strings (Redis keys, file
 * paths, URLs); names with '/', '..', spaces, control chars or
 * non-ASCII have been observed in the wild causing path-traversal-
 * shaped pairs (e.g. 'tndex:A B:C/../../../../../中'). Strict
 * allowlist + explicit '..' rejection.
 */
const SAFE_IDENT = /^[A-Za-z0-9_.]{1,32}$/
const isSafeIdent = (s: string): boolean =>
  SAFE_IDENT.test(s) && !s.includes('..')

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

  /** display pair → wire code. A display name shared by a spot and a perp
   *  market (e.g. 'BTC-USDC') resolves to the PERP code here (futures is
   *  processed last and overwrites). Use `spotPairToCode` when the caller
   *  knows it wants the spot market. */
  private nameToCode: Map<string, string> = new Map()
  /** display pair → SPOT wire code only (never overwritten by perps). Lets a
   *  spot candle subscription pick the spot `@N` stream instead of the perp
   *  when the two share a display name. */
  private spotNameToCode: Map<string, string> = new Map()
  /** wire code → display pair */
  private codeToName: Map<string, string> = new Map()
  /** Builder-dex names with at least one listed market (HL native excluded). */
  private dexNames: Set<string> = new Set()
  private lastFetch = 0
  private fetchInterval = 20 * 60 * 1000
  /** Backoff before retrying when the cache is empty after an attempt —
   *  prevents every consumer call from re-fetching when meta() fails. */
  private failureRetryInterval = 60 * 1000
  private fetching: Promise<void> | null = null
  private client = new hl.InfoClient({
    transport: new hl.HttpTransport({
      isTestnet: process.env.HYPERLIQUIDENV === 'demo',
    }),
  })

  pairToCode(pair: string): string | undefined {
    return this.nameToCode.get(pair)
  }

  /** Spot wire code for a display pair, falling back to the general map for
   *  spot-only names (e.g. builder-dex or non-colliding spot pairs). */
  spotPairToCode(pair: string): string | undefined {
    return this.spotNameToCode.get(pair) ?? this.nameToCode.get(pair)
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
    // Use the regular interval if the cache is populated, a much shorter
    // one when it's empty so we can recover from a transient failure
    // without burning rate-limit budget. We do NOT bypass the guard just
    // because the cache is empty — bypassing causes every caller to
    // re-fetch on every request.
    const sinceLast = Date.now() - this.lastFetch
    const interval =
      this.nameToCode.size > 0 ? this.fetchInterval : this.failureRetryInterval
    if (!force && this.lastFetch && sinceLast < interval) {
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
      const newSpotName = new Map<string, string>()
      const newCode = new Map<string, string>()

      // Spot
      const spot = await this.client.spotMeta()
      const spotTokens = spot.tokens
      tokenDisplayMap = buildTokenDisplayMap(spotTokens)
      spot.universe.forEach((u) => {
        const base = spotTokens.find((t) => t.index === u.tokens[0])
        const quote = spotTokens.find((t) => t.index === u.tokens[1])
        if (!base?.name || !quote) return
        const display = `${aliasToken(base.name)}-${aliasToken(quote.name)}`
        // Register the raw Unit pair as a backward-compat alias so a stream
        // requested under the pre-normalization pair (e.g. 'UETH-USDC' from a
        // bot created before this change) still resolves to the same wire
        // code. The Redis channel (codeToName) uses the normalized form.
        const rawPair = `${base.name}-${quote.name}`
        newName.set(display, u.name)
        if (rawPair !== display) newName.set(rawPair, u.name)
        // Spot-only map: keep the spot @N code even when a perp later claims
        // the same display name, so spot candle subscriptions stay on spot.
        newSpotName.set(display, u.name)
        if (rawPair !== display) newSpotName.set(rawPair, u.name)
        newCode.set(u.name, display)
      })

      // Futures: HL native + builder dexes via perpDexs(). Builder-dex pairs
      // are always prefixed `provider:BASE-QUOTE`; HL native stays unprefixed.
      // Hyperliquid testnet exposes thousands of (mostly empty) builder
      // dexes, so on demo we skip the perpDexs() fan-out and only fetch
      // HL native meta — otherwise the refresh never completes.
      const isDemo = process.env.HYPERLIQUIDENV === 'demo'
      const perpDexs: RawPerpDex[] = isDemo
        ? [null]
        : ((await this.client.perpDexs()) as RawPerpDex[])
      const newDexNames = new Set<string>()
      for (let i = 0; i < perpDexs.length; i++) {
        const dex = perpDexs[i]
        if (dex && !isSafeIdent(dex.name)) {
          logger.warn(
            `Hyperliquid skipping dex with unsafe name: ${JSON.stringify(dex.name)}`,
          )
          continue
        }
        // Per-dex try/catch — one bad dex must not poison the entire
        // futures map (and leave consumers iterating only HL native).
        try {
          const meta = (await (dex
            ? this.client.meta({ dex: dex.name })
            : this.client.meta())) as unknown as RawPerpsMeta
          if (!meta.universe || meta.universe.length === 0) continue
          const collateralIdx = meta.collateralToken ?? 0
          const quoteToken = spotTokens.find((t) => t.index === collateralIdx)
          const quoteAsset = quoteToken?.name
            ? aliasToken(quoteToken.name)
            : 'USDC'
          if (!isSafeIdent(quoteAsset)) {
            logger.warn(
              `Hyperliquid skipping ${dex?.name ?? 'native'}: unsafe quote ${JSON.stringify(quoteAsset)}`,
            )
            continue
          }
          if (dex) newDexNames.add(dex.name)
          meta.universe.forEach((u) => {
            const code = u.name
            // Use slice so an asset name with extra colons isn't truncated
            // (and ends up colliding with another asset's prefix).
            const baseRaw =
              dex && u.name.startsWith(`${dex.name}:`)
                ? u.name.slice(dex.name.length + 1)
                : u.name
            const baseName = aliasToken(baseRaw)
            if (!isSafeIdent(baseName)) {
              logger.warn(
                `Hyperliquid skipping unsafe asset: ${JSON.stringify(u.name)} (dex=${dex?.name ?? 'native'})`,
              )
              return
            }
            const basePair = `${baseName}-${quoteAsset}`
            const pair = dex ? `${dex.name}:${basePair}` : basePair
            // HL native spot (e.g. UBTC/USDC → 'BTC-USDC') and HL native
            // perp ('BTC-USDC') share a display pair. We process spot
            // first, then futures, so this overwrite makes the futures
            // wire code win on pairToCode lookups. codeToName keeps both
            // since wire codes are unique ('@142' vs 'BTC').
            newName.set(pair, code)
            newCode.set(code, pair)
          })
        } catch (e) {
          logger.error(
            `Hyperliquid meta failed for ${dex?.name ?? 'native'}: ${(e as Error)?.message ?? e}`,
          )
        }
      }

      if (newName.size > 0) {
        this.nameToCode = newName
        this.spotNameToCode = newSpotName
        this.codeToName = newCode
        this.dexNames = newDexNames
        logger.info(
          `Loaded ${this.nameToCode.size} Hyperliquid symbol mappings`,
        )
      }
    } catch (e) {
      logger.error(
        `Failed to refresh Hyperliquid symbol map (keeping ${this.nameToCode.size} existing): ${e}`,
      )
    } finally {
      // Mark "attempted" so the next refresh waits the failureRetryInterval
      // when the cache is still empty, rather than re-fetching immediately.
      this.lastFetch = Date.now()
    }
  }
}

export default HyperliquidSymbolMap
