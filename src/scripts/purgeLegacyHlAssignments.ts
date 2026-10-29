/**
 * One-off cleanup: delete every legacy `userStream:assignment:*` key.
 *
 * Older balancers stored the full open-stream message under that prefix. The
 * current balancer keeps `userStream:hlAssign:<uuid>` → worker id instead and
 * never reads the old prefix, so the old keys only need to go. Run it once the
 * new balancer is deployed (an older balancer would write them again).
 *
 * Keys are found with SCAN and removed with UNLINK. Values are never fetched,
 * so nothing secret can reach the output: it prints counts only.
 *
 * Usage (from the service checkout, after build):
 *   node -r dotenv/config dist/core/src/scripts/purgeLegacyHlAssignments.js           # dry run
 *   node -r dotenv/config dist/core/src/scripts/purgeLegacyHlAssignments.js --apply   # delete
 */
import { createClient } from 'redis'

export const LEGACY_ASSIGN_MATCH = 'userStream:assignment:*'

/** The two commands this script is allowed to issue. */
export type KeyOnlyClient = {
  scan(
    cursor: string,
    opts: { MATCH: string; COUNT: number },
  ): Promise<{ cursor: string | number; keys: string[] }>
  unlink(keys: string[]): Promise<number>
}

export async function purgeLegacyHlAssignments(
  client: KeyOnlyClient,
  { apply }: { apply: boolean },
): Promise<{ matched: number; deleted: number }> {
  let cursor = '0'
  let matched = 0
  let deleted = 0
  do {
    const reply = await client.scan(cursor, {
      MATCH: LEGACY_ASSIGN_MATCH,
      COUNT: 500,
    })
    cursor = `${reply.cursor}`
    matched += reply.keys.length
    if (apply && reply.keys.length) deleted += await client.unlink(reply.keys)
  } while (cursor !== '0')
  return { matched, deleted }
}

if (require.main === module) {
  const apply = process.argv.includes('--apply')
  const client = createClient({
    password: process.env.REDIS_PASSWORD,
    socket: {
      port: +(process.env.REDIS_PORT ?? 6379),
      host: process.env.REDIS_HOST ?? 'localhost',
    },
  })
  client
    .connect()
    .then(() =>
      purgeLegacyHlAssignments(
        {
          scan: (c, o) => client.scan(c, o),
          unlink: (k) => client.unlink(k),
        },
        { apply },
      ),
    )
    .then(({ matched, deleted }) => {
      console.log(
        `${LEGACY_ASSIGN_MATCH}: matched=${matched} deleted=${deleted}${apply ? '' : ' (dry run; pass --apply to delete)'}`,
      )
      return client.quit()
    })
    .catch((e: Error) => {
      // The message only: a client error object can carry connection options.
      console.error(`purge failed: ${e?.message ?? e}`)
      process.exitCode = 1
      return client.quit().catch(() => undefined)
    })
}
