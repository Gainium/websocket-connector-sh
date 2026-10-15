/**
 * IP rotation must pick up secondary IPs that appear after start-up.
 *
 * Run: `npm test` (node:test via ts-node/register, transpile-only).
 *
 * After a host reboot the process manager can start the stream services
 * before the network has brought up the secondary addresses. The one-time
 * `networkInterfaces()` snapshot then holds one IP (or none) and rotation
 * stayed off for the life of the process: every connection left from the
 * primary address (rejected by IP-restricted API keys), and the HL worker
 * was capped at 10 users.
 */

import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { watchForLateIps } from '../src/utils/lateIpDetection'

const iface = (address: string) => ({
  address,
  netmask: '255.255.255.255',
  family: 'IPv4' as const,
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: `${address}/32`,
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('watchForLateIps reports the pool once more than one IP appears', async () => {
  let ips = ['203.0.113.1']
  const found: string[][] = []
  const stop = watchForLateIps(
    't',
    () => ips,
    (x) => found.push(x),
    {
      intervalMs: 5,
      windowMs: 60_000,
    },
  )
  try {
    await sleep(30)
    assert.equal(found.length, 0)
    ips = ['203.0.113.1', '203.0.113.2', '203.0.113.3']
    await sleep(30)
    assert.deepEqual(found, [ips])
    // Stops after the first hit.
    await sleep(30)
    assert.equal(found.length, 1)
  } finally {
    stop()
  }
})

test('watchForLateIps gives up after the window on a single-IP host', async () => {
  let calls = 0
  const found: string[][] = []
  const stop = watchForLateIps(
    't',
    () => {
      calls++
      return ['203.0.113.1']
    },
    (x) => found.push(x),
    { intervalMs: 5, windowMs: 25 },
  )
  try {
    await sleep(60)
    const after = calls
    await sleep(30)
    assert.equal(found.length, 0)
    assert.ok(after > 0)
    assert.equal(calls, after, 'kept polling after the window closed')
  } finally {
    stop()
  }
})

test('HL rotation raises the cap when the pool appears after boot', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let ifs: ReturnType<typeof os.networkInterfaces> = {}
  mock.method(os, 'networkInterfaces', () => ifs)
  const originalWs = (globalThis as any).WebSocket
  try {
    // Fresh module state: installHyperliquidIpRotation is once-per-process.
    const modPath = require.resolve('../src/utils/hyperliquidIpRotation')
    delete require.cache[modPath]
    const hl: typeof import('../src/utils/hyperliquidIpRotation') =
      await import(modPath)

    const late: { ips: string[]; cap: number }[] = []
    const boot = hl.installHyperliquidIpRotation((ips, cap) =>
      late.push({ ips, cap }),
    )
    assert.equal(boot.cap, 10)
    assert.deepEqual(boot.ips, [])
    assert.equal((globalThis as any).WebSocket, originalWs)

    ifs = {
      eth0: ['203.0.113.1', '203.0.113.2', '203.0.113.3'].map(iface),
    }
    mock.timers.tick(10_000)

    assert.equal(late.length, 1)
    assert.equal(late[0].cap, 30)
    assert.deepEqual(hl.hyperliquidIpStatus().ips, [
      '203.0.113.1',
      '203.0.113.2',
      '203.0.113.3',
    ])
    assert.notEqual((globalThis as any).WebSocket, originalWs)
  } finally {
    ;(globalThis as any).WebSocket = originalWs
    mock.restoreAll()
    mock.timers.reset()
  }
})
