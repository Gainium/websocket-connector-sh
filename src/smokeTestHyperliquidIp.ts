/**
 * Standalone HL WebSocket probe.
 *
 * Run on the multi-IP host:
 *   npx ts-node core/src/smokeTestHyperliquidIp.ts <localIp> [user]
 *
 * Examples:
 *   npx ts-node core/src/smokeTestHyperliquidIp.ts 62.84.191.108
 *   npx ts-node core/src/smokeTestHyperliquidIp.ts 62.84.191.108 0x65c627cB6d5901d907601EAd1eFef3e614802edb
 *
 * What it does:
 *   1. Opens a raw `ws.WebSocket` to wss://api.hyperliquid.xyz/ws bound
 *      to the given local IP (NOT via the monkey-patched globalThis).
 *   2. Logs every WS lifecycle event with elapsed-ms timestamps.
 *   3. If a user address is provided, sends a `subscribe orderUpdates`
 *      message after open and logs whatever HL sends back (subscription
 *      confirmation, error, etc.) or notes the absence.
 *   4. Closes after 45s.
 *
 * Read the elapsed timestamps to tell which layer fails:
 *   - No "open" event       → IP can't reach HL or asymmetric routing
 *   - Open then silent close → HL is closing the connection (rate /
 *                              geo / fingerprint), check reason
 *   - Open + subscribe sent, no ack → subscription ack lost / ignored
 */

import WebSocket from 'ws'

const localIp = process.argv[2]
const user = process.argv[3]

if (!localIp) {
  console.error(
    'Usage: ts-node core/src/smokeTestHyperliquidIp.ts <localIp> [user]',
  )
  process.exit(1)
}

const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws'

const t0 = Date.now()
const ts = () => `+${(Date.now() - t0).toString().padStart(5, ' ')}ms`

console.log(`${ts()} connecting to ${HL_WS_URL} from localAddress=${localIp}`)

const ws = new WebSocket(HL_WS_URL, undefined, { localAddress: localIp })

ws.on('open', () => {
  console.log(`${ts()} open`)
  if (user) {
    const sub = {
      method: 'subscribe',
      subscription: { type: 'orderUpdates', user },
    }
    console.log(`${ts()} sending subscribe: ${JSON.stringify(sub)}`)
    ws.send(JSON.stringify(sub))
  } else {
    console.log(`${ts()} no user supplied — skipping subscribe`)
  }
})

ws.on('message', (data) => {
  const s = data.toString()
  console.log(`${ts()} message: ${s.length > 400 ? s.slice(0, 400) + '…' : s}`)
})

ws.on('error', (err) => {
  console.log(`${ts()} error: ${err.message}`)
})

ws.on('close', (code, reason) => {
  console.log(`${ts()} close code=${code} reason="${reason.toString()}"`)
  process.exit(0)
})

setTimeout(() => {
  console.log(`${ts()} 45s elapsed, closing`)
  ws.close()
}, 45_000)
