/**
 * A price worker whose feed stays dead must be replaced by a fresh thread.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * A watchdog stall throws inside the worker; `service.ts` catches it and
 * rebuilds the connector in the same thread. That first-line reconnect is kept
 * for short blips, but a feed that never comes back used to rebuild forever:
 * the retry escalation meant to `process.exit(1)` could not fire, so the
 * parent's `initWorker` never got an `exit` to restart on. These tests run the
 * real `service.ts` in a real worker thread against a fake venue
 * (test/fixtures/stalledPriceWorker.ts).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { Worker } from 'worker_threads'
import {
  STALL_EXIT_THRESHOLD,
  StallCounter,
  stallOf,
} from '../src/price/stallEscalation'

const runWorker = (mode: 'dead' | 'blip', windowMs: number) =>
  new Promise<{ built: number; exitCode: number | null }>((resolve) => {
    let built = 0
    const worker = new Worker(
      path.resolve(__dirname, '../src/price/worker.js'),
      {
        workerData: {
          path: path.resolve(__dirname, 'fixtures/stalledPriceWorker.ts'),
          mode,
          data: {
            exchange: 'bitget',
            payload: {
              subscribedCandlesMap: new Map(),
              subscribedTopics: new Map(),
            },
          },
        },
        stdout: true,
        stderr: true,
      },
    )
    worker.on('message', (m) => {
      if (m?.built) {
        built = m.built
      }
    })
    const timer = setTimeout(() => {
      worker.removeAllListeners('exit')
      worker.terminate().then(() => resolve({ built, exitCode: null }))
    }, windowMs)
    worker.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ built, exitCode: code })
    })
  })

test('stallOf reads the feed out of each watchdog stall error', () => {
  assert.deepEqual(stallOf('Exchange exceed connect time 50s | bitgetUsdm'), {
    exchange: 'bitgetUsdm',
    kind: 'price',
  })
  assert.deepEqual(
    stallOf('Exchange not received new data for 97s | bitgetUsdm'),
    { exchange: 'bitgetUsdm', kind: 'price' },
  )
  assert.deepEqual(
    stallOf('Trades on exchange not received new data for 80s | krakenUsdm'),
    { exchange: 'krakenUsdm', kind: 'candle' },
  )
  assert.equal(stallOf('socket hang up'), null)
  assert.equal(stallOf(undefined), null)
})

test('StallCounter escalates only on consecutive stalls with no data between', () => {
  const c = new StallCounter(3)
  assert.equal(c.noteStall('bitgetUsdm', 'price'), false)
  assert.equal(c.noteStall('bitgetUsdm', 'price'), false)
  c.noteData('bitgetUsdm', 'price')
  assert.equal(c.noteStall('bitgetUsdm', 'price'), false)
  assert.equal(c.noteStall('bitgetUsdm', 'price'), false)
  // other feeds are counted separately, and their data resets only them
  c.noteData('bitget', 'price')
  c.noteData('bitgetUsdm', 'candle')
  assert.equal(c.noteStall('bitgetUsdm', 'candle'), false)
  assert.equal(c.noteStall('bitgetUsdm', 'price'), true)
  assert.equal(STALL_EXIT_THRESHOLD, 3)
})

test('a feed that stays dead exits the worker after the stall threshold', async () => {
  const r = await runWorker('dead', 20000)
  assert.equal(
    r.exitCode,
    1,
    `worker kept rebuilding in-thread (${r.built} connectors)`,
  )
  // the first-line reconnect still runs before escalating
  assert.equal(r.built, STALL_EXIT_THRESHOLD)
})

test('a feed that recovers between stalls keeps the in-thread reconnect', async () => {
  const r = await runWorker('blip', 12000)
  assert.equal(r.exitCode, null)
  assert.ok(r.built > STALL_EXIT_THRESHOLD, `only ${r.built} rebuilds`)
})
