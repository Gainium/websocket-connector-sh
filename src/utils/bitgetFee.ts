/**
 * A Bitget `feeDetail[].fee` as the cost the platform books.
 *
 * Bitget states a charge as a NEGATIVE number (money leaving the account),
 * while every consumer of an `ExecutionReport` reads `feePaid` and
 * `feeBreakdown` as a cost and ignores anything `<= 0` as "not observed" —
 * the same "magnitude, not sign" rule exchange-connector's REST normalizer
 * applies to the same order. So a negative value loses its sign here, keeping
 * the venue's own digits. Anything else is forwarded exactly as reported.
 */
export function bitgetFeeCost(fee: string): string
export function bitgetFeeCost(fee: string | undefined): string | undefined
export function bitgetFeeCost(fee: string | undefined): string | undefined {
  if (fee === undefined || !(Number(fee) < 0)) {
    return fee
  }
  return fee.trim().replace(/^-/, '')
}
