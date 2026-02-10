export function impliedProbabilityFromMid(bestBid?: number, bestAsk?: number): number | null {
  if (bestBid == null || bestAsk == null) return null;
  const mid = (bestBid + bestAsk) / 2;
  if (!Number.isFinite(mid) || mid <= 0 || mid >= 1) return null;
  return mid;
}

// Classic Kelly for binary bet with payout b:1 (net odds b) and win prob p.
// For prediction markets priced in probability terms, we often approximate b = (1 - q) / q
// where q is market prob. This is a simplification; we’ll refine once we confirm the instrument.
export function kellyFraction(p: number, q: number): number {
  if (p <= 0 || p >= 1) return 0;
  if (q <= 0 || q >= 1) return 0;
  const b = (1 - q) / q;
  const f = (b * p - (1 - p)) / b;
  if (!Number.isFinite(f)) return 0;
  return Math.max(0, f);
}
