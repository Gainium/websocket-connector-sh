/**
 * A venue's signed fee as the cost the platform books.
 *
 * Bitget (`feeDetail[].fee`) and OKX (order-level `fee`) state a charge as a
 * NEGATIVE number (money leaving the account), while every consumer of an
 * `ExecutionReport` reads `feePaid` and `feeBreakdown` as a cost and ignores
 * anything `<= 0` as "not observed" — the same "magnitude, not sign" rule
 * exchange-connector's REST normalizer applies to the same order. So a
 * negative value loses its sign here, keeping the venue's own digits.
 * Anything else is forwarded exactly as reported.
 */
export function chargeCost(fee: string): string
export function chargeCost(fee: string | undefined): string | undefined
export function chargeCost(fee: string | undefined): string | undefined {
  if (fee === undefined || !(Number(fee) < 0)) {
    return fee
  }
  return fee.trim().replace(/^-/, '')
}
