/**
 * Cost is expressed in "input-token equivalents" (ITE) using price ratios, so every number works for any
 * model. Absolute dollars are only shown when the user configures a per-Mtok input price.
 */
export interface PriceRatios {
  /** Cache read cost relative to uncached input. */
  r_read: number;
  /** Cache write cost relative to uncached input. */
  r_write: number;
  /** Output cost relative to uncached input. */
  r_out: number;
}

export interface PricingConfig extends PriceRatios {
  usd_per_mtok_input: number | null;
}

export const DEFAULT_RATIOS: PriceRatios = { r_read: 0.1, r_write: 1.25, r_out: 5.0 };

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'unknown';

export function modelFamily(model: string | undefined): ModelFamily {
  const m = (model ?? '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  return 'unknown';
}

/** Per-family overrides. All current families share the same ratios; kept as a map so one can diverge. */
const FAMILY_RATIOS: Partial<Record<ModelFamily, Partial<PriceRatios>>> = {};

export function ratiosFor(
  model: string | undefined,
  base: PriceRatios = DEFAULT_RATIOS,
): PriceRatios {
  return { ...base, ...FAMILY_RATIOS[modelFamily(model)] };
}

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export interface WeightedCost {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  total: number;
}

export function weightedCost(u: Usage, r: PriceRatios): WeightedCost {
  const input = u.input_tokens;
  const cacheWrite = u.cache_creation_input_tokens * r.r_write;
  const cacheRead = u.cache_read_input_tokens * r.r_read;
  const output = u.output_tokens * r.r_out;
  return { input, cacheWrite, cacheRead, output, total: input + cacheWrite + cacheRead + output };
}

/** Total tokens the model saw as input on this request (the context size). */
export function contextTokens(u: Usage): number {
  return u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
}

export function toUsd(ite: number, p: PricingConfig): number | null {
  return p.usd_per_mtok_input == null ? null : (ite / 1_000_000) * p.usd_per_mtok_input;
}

/** Context window by model. Session data, when available, should win over this map. */
export function contextWindowFor(model: string | undefined, observedMaxContext = 0): number {
  const m = (model ?? '').toLowerCase();
  if (m.includes('[1m]')) return 1_000_000;
  // A session that already exceeded 200K must be running with a larger window.
  if (observedMaxContext > 200_000) return 1_000_000;
  return 200_000;
}
