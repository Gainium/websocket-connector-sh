import axios from 'axios'
import { createHmac } from 'crypto'

/**
 * Whether a Bitget key's account is Classic or a Unified Trading Account.
 *
 * The two publish a user's orders and balances on different private sockets
 * (v2 vs v3), and neither sees the other's traffic, so the user stream has to
 * know before it subscribes. exchange-connector makes the same decision for
 * REST (`bitget/uta.ts`).
 *
 * `GET /api/v3/account/settings` answers a unified account with its
 * `accountMode`; a classic account is refused with a Bitget business error.
 * A transport failure answers nothing (`undefined`), which the caller must not
 * read as classic. The request goes through the http layer, so on a
 * multi-IP host it leaves from the same address the socket will.
 */
export type BitgetAccountMode = 'classic' | 'uta'

const PATH = '/api/v3/account/settings'

/** Bitget codes that say "try again", not "this is not a unified account". */
const TRANSIENT_CODES = new Set(['429', '40008', '40010', '40725', '45001'])

export const bitgetAccountModeFromSettings = (
  data: unknown,
): BitgetAccountMode | undefined => {
  const mode = `${(data as { accountMode?: unknown })?.accountMode ?? ''}`
    .trim()
    .toLowerCase()
  if (mode === 'unified' || mode === 'hybrid' || mode === 'upgrading') {
    return 'uta'
  }
  if (mode === 'switching') {
    return 'classic'
  }
  return undefined
}

export async function detectBitgetAccountMode(api: {
  key: string
  secret: string
  passphrase?: string
}): Promise<BitgetAccountMode | undefined> {
  const timestamp = `${Date.now()}`
  const sign = createHmac('sha256', api.secret)
    .update(`${timestamp}GET${PATH}`)
    .digest('base64')
  try {
    const res = await axios.get(`https://api.bitget.com${PATH}`, {
      timeout: 15000,
      headers: {
        'ACCESS-KEY': api.key,
        'ACCESS-SIGN': sign,
        'ACCESS-TIMESTAMP': timestamp,
        'ACCESS-PASSPHRASE': api.passphrase ?? '',
        'Content-Type': 'application/json',
        locale: 'en-US',
      },
      validateStatus: () => true,
    })
    const body = res.data as { code?: string; data?: unknown } | undefined
    if (body?.code === '00000') {
      return bitgetAccountModeFromSettings(body.data) ?? 'classic'
    }
    // Bitget answered and refused: not a unified account (or not a usable
    // key, which the classic stream will report on its own).
    return body?.code && !TRANSIENT_CODES.has(body.code) ? 'classic' : undefined
  } catch {
    return undefined
  }
}
