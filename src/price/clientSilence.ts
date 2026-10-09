/**
 * Finds a single silent socket among an exchange's several.
 *
 * The watchdog in `CommonConnector` judges a feed by the newest message of the
 * whole exchange. An exchange whose markets are spread over several sockets
 * therefore stays "live" while one of them delivers nothing: the others keep
 * the timestamp fresh. This judges each socket on its own, against its peers.
 *
 * A socket is silent when, for longer than `timeout`, it delivered no market
 * data since it was created or last (re)opened, while a peer did deliver
 * within `peerWindow`. Requiring a live peer keeps a quiet market from looking
 * like a dead socket: if every socket is quiet, the exchange-wide watchdog
 * owns the case. Sockets carrying few subscriptions are skipped for the same
 * reason — a handful of thin symbols can legitimately go quiet.
 *
 * Pongs and subscribe acks are deliberately NOT data here. The failure this
 * catches is a socket that answers its heartbeat while none of its
 * subscriptions are armed; `lastFrame` only says which of the two it is.
 */

export type ClientActivity = {
  id: string
  subs: number
  /** Last market-data message, 0 if none yet. */
  lastData: number
  /** Created, opened or reopened — the start of the current silence. */
  since: number
  /** Last frame of any kind, pongs and acks included. */
  lastFrame: number
}

export type SilenceOptions = {
  timeout: number
  peerWindow: number
  minSubs: number
}

export type SilentClient = {
  id: string
  staleSeconds: number
  /** The socket still answers (pong/ack) — only its subscriptions are dead. */
  socketAlive: boolean
}

export const findSilentClients = (
  clients: ClientActivity[],
  now: number,
  { timeout, peerWindow, minSubs }: SilenceOptions,
): SilentClient[] => {
  const silent: SilentClient[] = []
  for (const c of clients) {
    if (c.subs < minSubs) {
      continue
    }
    const quietSince = Math.max(c.lastData, c.since)
    if (now - quietSince <= timeout) {
      continue
    }
    const peerLive = clients.some(
      (p) => p !== c && p.lastData > 0 && now - p.lastData <= peerWindow,
    )
    if (!peerLive) {
      continue
    }
    silent.push({
      id: c.id,
      staleSeconds: Math.floor((now - quietSince) / 1000),
      socketAlive: c.lastFrame > 0 && now - c.lastFrame <= peerWindow,
    })
  }
  return silent
}
