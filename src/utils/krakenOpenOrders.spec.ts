process.env.NODE_ENV = 'testing'

/**
 * Regression tests for the Kraken Futures `open_orders` fill mapping.
 *
 * Replays the order that exposed the bug (2026-08-22, XRP-USD, 16 placed): the
 * open_orders update after the first execution was `{qty: 5, filled: 11}`.
 * `qty` is the quantity still open, and the old mapping compared `filled >= qty`
 * and called it FILLED at 11 — which made the engine send a 5-lot remainder
 * that then doubled up with the original order's own fill. See
 * `krakenOpenOrders.ts` for the full account.
 *
 * Run: npx ts-node --files --project tsconfig.json src/utils/krakenOpenOrders.spec.ts
 *
 * No network / auth needed — the module is pure.
 */
import {
  krakenOpenOrderFill,
  krakenOpenOrdersRemovalIsFill,
} from './krakenOpenOrders'

let failures = 0
const check = (name: string, actual: unknown, expected: unknown) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.log(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`)
  } else {
    console.log(`pass ${name}`)
  }
}

// The regression: first execution of a 16-lot order. Old mapping: FILLED at 11.
check(
  'partial execution is PARTIALLY_FILLED with the original size restored',
  krakenOpenOrderFill({ qty: 5, filled: 11 }),
  { status: 'PARTIALLY_FILLED', total: 16, filled: 11, remaining: 5 },
)
// The same order once nothing is left open.
check(
  'nothing remaining is FILLED',
  krakenOpenOrderFill({ qty: 0, filled: 16 }),
  { status: 'FILLED', total: 16, filled: 16, remaining: 0 },
)
// Freshly placed: the snapshot/new-order update.
check('untouched order is NEW', krakenOpenOrderFill({ qty: 16, filled: 0 }), {
  status: 'NEW',
  total: 16,
  filled: 0,
  remaining: 16,
})
// The exact case the old formula got right by accident — must stay right.
check(
  'filled exactly equal to remaining is still only partial',
  krakenOpenOrderFill({ qty: 8, filled: 8 }),
  { status: 'PARTIALLY_FILLED', total: 16, filled: 8, remaining: 8 },
)
// Kraken sends numbers, but be tolerant of strings and junk.
check(
  'string fields are parsed',
  krakenOpenOrderFill({ qty: '7', filled: '18' }),
  { status: 'PARTIALLY_FILLED', total: 25, filled: 18, remaining: 7 },
)
check('missing fields are NEW with zero size', krakenOpenOrderFill({}), {
  status: 'NEW',
  total: 0,
  filled: 0,
  remaining: 0,
})
check(
  'a removal for a full fill is a fill, not a cancel',
  krakenOpenOrdersRemovalIsFill('full_fill'),
  true,
)
check(
  'a user cancel is a cancel',
  krakenOpenOrdersRemovalIsFill('cancelled_by_user'),
  false,
)
check(
  'an unknown or missing reason is treated as a cancel',
  krakenOpenOrdersRemovalIsFill(undefined),
  false,
)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
