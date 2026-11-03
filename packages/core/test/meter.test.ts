import { describe, expect, it } from 'vitest';
import {
  colorize,
  defaultConfig,
  evaluateMeter,
  newLiveState,
  type LiveState,
  type MeterInput,
} from '../src/index.js';

const now = Date.parse('2026-11-03T12:00:00Z');

function state(over: Partial<LiveState> = {}): LiveState {
  return {
    ...newLiveState('s'),
    baseOverhead: 30_000,
    requests: 50,
    cost: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 2_500_000 },
    ...over,
  };
}

const input = (context: number, extra: Partial<MeterInput> = {}): MeterInput => ({
  context,
  window: 1_000_000,
  now,
  ...extra,
});

describe('evaluateMeter', () => {
  const c = defaultConfig();

  it('is green for a small context and shows next-request cost and session cost', () => {
    const r = evaluateMeter(input(40_000), state(), c);
    expect(r.band).toBe('green');
    expect(r.text).toBe('40K ctx · next req ≈4K · 2.5M ITE');
  });

  it('shows the break-even once clearing would pay off at all', () => {
    const r = evaluateMeter(input(90_000), state(), c);
    expect(r.text).toContain('clear pays off in');
  });

  it('turns yellow past 60% of the budget', () => {
    expect(evaluateMeter(input(130_000), state(), c).band).toBe('yellow');
  });

  it('turns red over budget and suggests /compact', () => {
    const r = evaluateMeter(input(210_000), state(), c);
    expect(r.band).toBe('red');
    expect(r.action).toBe('over budget: /compact');
  });

  it('suggests /clear at a strong task boundary when it pays off soon', () => {
    const r = evaluateMeter(input(150_000), state({ lastTurnSignals: ['commit'] }), c);
    expect(r.band).toBe('red');
    expect(r.action).toBe('good moment: /tokentrim:checkpoint, then /clear');
  });

  it('ignores weak signals unless boundary_signals is "any"', () => {
    const s = state({ lastTurnSignals: ['turn-complete'] });
    expect(evaluateMeter(input(150_000), s, c).action).toBeUndefined();
    const any = { ...c, advisor: { ...c.advisor, boundary_signals: 'any' as const } };
    expect(evaluateMeter(input(150_000), s, any).action).toContain('/clear');
  });

  it('says clearing first is cheaper when the cache went cold on a big context', () => {
    const r = evaluateMeter(
      input(150_000, { cache: { warm: false, expiresAt: null } }),
      state(),
      c,
    );
    expect(r.band).toBe('red');
    expect(r.action).toContain('cache expired');
    expect(r.text).toContain('cache cold');
  });

  it('shows minutes of warm cache left and Claude Code dollars when given', () => {
    const r = evaluateMeter(
      input(50_000, { usd: 3.456, cache: { warm: true, expiresAt: now / 1000 + 37 * 60 } }),
      state(),
      c,
    );
    expect(r.text).toBe('50K ctx · next req ≈5K · clear pays off in 5 req · cache 37m · $3.46');
  });

  it('works before the first Stop has written any state', () => {
    const r = evaluateMeter(input(25_000), null, c);
    expect(r).toEqual({ band: 'green', text: '25K ctx · next req ≈3K', action: undefined });
  });

  it('colours the dot, or marks red with ⚠ when colour is off', () => {
    const red = evaluateMeter(input(210_000), state(), c);
    expect(colorize(red, false)).toMatch(/^⚠ 210K ctx/);
    expect(colorize(red, true)).toContain('\x1b[31m●');
  });
});
