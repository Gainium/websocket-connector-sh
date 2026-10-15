import logger from './logger'

/**
 * Keep re-detecting the host's public IPv4 pool after start-up.
 *
 * IP rotation snapshots `networkInterfaces()` once at boot. After a host
 * reboot the process manager can start us before the network has brought
 * up the secondary addresses, so that snapshot holds one IP (or none) and
 * rotation would stay off for the whole life of the process — every
 * connection then leaves from the primary address, which users have not
 * whitelisted on IP-restricted API keys.
 *
 * This polls `detect()` every `intervalMs` until it returns more than one
 * IP, hands that list to `onFound` and stops. It gives up after
 * `windowMs` (a genuinely single-IP host simply never finds more). The
 * timer is unref'd so it never keeps a process alive.
 */
export function watchForLateIps(
  label: string,
  detect: () => string[],
  onFound: (ips: string[]) => void,
  opts: { intervalMs?: number; windowMs?: number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 10_000
  const windowMs = opts.windowMs ?? 10 * 60_000
  const startedAt = Date.now()
  const timer = setInterval(() => {
    let ips: string[] = []
    try {
      ips = detect()
    } catch (e) {
      logger.info(`${label}: late IP re-detect failed: ${e}`)
    }
    if (ips.length > 1) {
      clearInterval(timer)
      logger.info(
        `${label}: ${ips.length} public IPv4 appeared after start-up [${ips.join(
          ',',
        )}]; enabling rotation`,
      )
      onFound(ips)
      return
    }
    if (Date.now() - startedAt >= windowMs) {
      clearInterval(timer)
      logger.info(
        `${label}: still ${ips.length} public IPv4 after ${Math.round(
          windowMs / 1000,
        )}s; rotation stays off`,
      )
    }
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
