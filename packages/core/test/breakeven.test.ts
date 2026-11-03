import { describe, expect, it } from 'vitest';
import { breakeven, DEFAULT_RATIOS, expiredCacheChoice } from '../src/index.js';

// Plan §6: B=25K, K=2K, R=15K.
const base = { B: 25_000, K: 2_000, R: 15_000 };

describe('breakeven', () => {
  it.each([
    [60_000, 17.4, 34.7],
    [100_000, 5.4, 10.8],
    [150_000, 2.9, 5.8],
  ])('C=%i pays off in ~%f (cached) / ~%f (not cached) requests', (C, cached, notCached) => {
    expect(breakeven({ ...base, C, baseCached: true }, DEFAULT_RATIOS).breakevenTurns).toBeCloseTo(
      cached,
      1,
    );
    expect(breakeven({ ...base, C, baseCached: false }, DEFAULT_RATIOS).breakevenTurns).toBeCloseTo(
      notCached,
      1,
    );
  });

  it('never pays off when the fresh start is not smaller than the current context', () => {
    const r = breakeven({ ...base, C: 40_000, baseCached: true }, DEFAULT_RATIOS);
    expect(r.S).toBe(42_000);
    expect(r.perTurnSaving).toBeLessThan(0);
    expect(r.breakevenTurns).toBe(Infinity);
  });

  it('recommends clearing after the cache expired at 100K', () => {
    const r = expiredCacheChoice({ ...base, C: 100_000, baseCached: true }, DEFAULT_RATIOS);
    expect(r.continueCost).toBe(125_000);
    expect(r.clearCost).toBe(62_500);
    expect(r.clearIsCheaper).toBe(true);
  });

  it('keeps going when the expired context is small', () => {
    const r = expiredCacheChoice({ ...base, C: 45_000, baseCached: true }, DEFAULT_RATIOS);
    expect(r.clearIsCheaper).toBe(false);
  });
});
