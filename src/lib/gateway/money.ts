// All spend is tracked in integer nano-USD (1e-9 USD) so reservations and
// settlements never accumulate floating-point drift. $130 = 1.3e11 nano, well
// inside Number.MAX_SAFE_INTEGER.
export type NanoUsd = number;

export const NANO_PER_USD = 1_000_000_000;

export function usdToNano(usd: number): NanoUsd {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new RangeError(`invalid USD amount: ${usd}`);
  }
  return Math.round(usd * NANO_PER_USD);
}

export function nanoToUsd(nano: NanoUsd): number {
  return nano / NANO_PER_USD;
}

export function formatUsd(nano: NanoUsd): string {
  return `$${nanoToUsd(nano).toFixed(6)}`;
}
