import type { PriceRatios } from '../pricing/index.js';

export interface BreakevenInput {
  /** Current context tokens. */
  C: number;
  /** Base overhead tokens (system + tools + memory files). */
  B: number;
  /** Keynotes tokens carried into the new session. */
  K: number;
  /** Tokens of files likely to be re-read after clearing. */
  R: number;
  /** Whether the base overhead is still cached (another session with the same prefix is warm). */
  baseCached: boolean;
}

export interface BreakevenResult {
  /** Starting context of the fresh session: B + K + R. */
  S: number;
  /** One-time cost of clearing, in input-token equivalents. */
  oneTime: number;
  /** Saving on every later request from carrying S instead of C. */
  perTurnSaving: number;
  /** Requests until clearing pays off. Infinity when clearing never pays off. */
  breakevenTurns: number;
}

/** Clear-vs-continue break-even (plan §6). The per-turn growth term cancels out, so it isn't an input. */
export function breakeven(i: BreakevenInput, r: PriceRatios): BreakevenResult {
  const S = i.B + i.K + i.R;
  const oneTime = r.r_out * i.K + r.r_write * (i.K + i.R + (i.baseCached ? 0 : i.B));
  const perTurnSaving = r.r_read * (i.C - S);
  const breakevenTurns = perTurnSaving > 0 ? oneTime / perTurnSaving : Infinity;
  return { S, oneTime, perTurnSaving, breakevenTurns };
}

export interface ExpiredCacheResult {
  /** Cost of the next request if the user continues: the whole context is re-written. */
  continueCost: number;
  /** One-time cost of clearing instead. */
  clearCost: number;
  clearIsCheaper: boolean;
}

/** After an idle gap longer than the cache TTL, the next request re-writes the whole context. */
export function expiredCacheChoice(i: BreakevenInput, r: PriceRatios): ExpiredCacheResult {
  const continueCost = r.r_write * i.C;
  const clearCost = breakeven({ ...i, baseCached: false }, r).oneTime;
  return { continueCost, clearCost, clearIsCheaper: continueCost > clearCost };
}
