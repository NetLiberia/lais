/** Ownership-type interests whose shares must add up to the whole parcel. */
export const OWNERSHIP_TYPES = ['ownership', 'co_ownership', 'customary_tenure'] as const;

export interface Share {
  num: number;
  den: number;
}

/** Exact rational sum, so 1/3 + 1/3 + 1/3 is exactly whole. */
export function sharesSumToWhole(shares: readonly Share[]): boolean {
  let n = 0n;
  let d = 1n;
  for (const s of shares) {
    n = n * BigInt(s.den) + BigInt(s.num) * d;
    d = d * BigInt(s.den);
  }
  return shares.length > 0 && n === d;
}
