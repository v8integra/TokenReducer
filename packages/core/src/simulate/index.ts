import { recentFileTokens, type AnalyzeOptions } from '../accounting/analyze.js';
import { detectTurns, STRONG_SIGNALS, type Turn } from '../boundaries/index.js';
import { breakeven } from '../breakeven/index.js';
import { contextTokens, type PriceRatios } from '../pricing/index.js';
import type { ParsedSession } from '../transcript/types.js';

/**
 * Replays a recorded session under a context policy and estimates what it would have cost.
 *
 * Model: the session does exactly the same work. After a clear or compaction the context restarts small and
 * then grows by the same per-request amounts as the real session did. Each request's cache writes are capped
 * at the simulated context (so idle rebuilds of a small context are cheap) and the rest is cache reads.
 * Actions only happen at turn ends, because that is when a user can type /clear or /compact.
 *
 * Optimistic: it ignores extra work Claude may need after losing context beyond re-reading recent files (R).
 * Pessimistic: it charges for every simulated compaction but never credits real compactions it avoided
 * (their requests aren't in the transcript).
 */
export interface Policy {
  name: string;
  /** Clear at task boundaries: 'strong' signals only, or any turn the assistant closed out. */
  boundary?: 'strong' | 'any';
  /** Clear at a boundary only when it pays off within this many requests. */
  maxBreakevenTurns: number;
  /** Compact at a turn end once the context passes this many tokens. */
  budget?: number;
  /** Clear instead of continuing after an idle gap that expired the cache, when that's cheaper. */
  idle?: boolean;
}

export const STANDARD_POLICIES: Policy[] = [
  { name: 'actual (no policy)', maxBreakevenTurns: 0 },
  { name: 'clear at strong boundaries', boundary: 'strong', maxBreakevenTurns: 4 },
  { name: 'clear at any closed-out turn', boundary: 'any', maxBreakevenTurns: 4 },
  { name: 'idle: clear when cache expired', idle: true, maxBreakevenTurns: 0 },
  { name: 'budget 150K (compact)', budget: 150_000, maxBreakevenTurns: 0 },
  { name: 'budget 200K (compact)', budget: 200_000, maxBreakevenTurns: 0 },
  { name: 'budget 300K (compact)', budget: 300_000, maxBreakevenTurns: 0 },
  { name: 'budget 400K (compact)', budget: 400_000, maxBreakevenTurns: 0 },
  {
    name: 'combined: strong + idle + 200K',
    boundary: 'strong',
    idle: true,
    budget: 200_000,
    maxBreakevenTurns: 4,
  },
  {
    name: 'combined: any + idle + 200K',
    boundary: 'any',
    idle: true,
    budget: 200_000,
    maxBreakevenTurns: 4,
  },
];

export interface SimulationOptions {
  ratios: PriceRatios;
  keynotesTokens: number;
  /** Tokens a compaction summary takes (median of the real ones when known). */
  summaryTokens: number;
  /** Don't bother acting below this context size. */
  minContext: number;
}

export interface PolicyResult {
  policy: string;
  /** Simulated total cost of the main chain (input side + output + one-time costs), in ITE. */
  cost: number;
  /** Actual main-chain cost, for comparison. */
  actualCost: number;
  clears: number;
  compacts: number;
  idleClears: number;
  /** Mean simulated context per request. */
  avgContext: number;
  turns: number;
}

export function simulateSession(
  s: ParsedSession,
  baseOverhead: number,
  policies: Policy[],
  opts: SimulationOptions,
  analyzeOpts: Pick<AnalyzeOptions, 'reReadWindow' | 'reReadCap'>,
): PolicyResult[] {
  const turns = detectTurns(s);
  const recent = recentFileTokens(s, analyzeOpts);
  return policies.map((p) => runPolicy(s, turns, baseOverhead, recent, p, opts));
}

function runPolicy(
  s: ParsedSession,
  turns: Turn[],
  B: number,
  recent: (i: number) => number,
  p: Policy,
  o: SimulationOptions,
): PolicyResult {
  const r = o.ratios;
  const reqs = s.requests;
  const compactStarts = new Set(s.compactions.map((c) => c.beforeRequest));
  const turnEnds = new Map<number, Turn>();
  for (const t of turns) turnEnds.set(t.endRequest, t);

  const res: PolicyResult = {
    policy: p.name,
    cost: 0,
    actualCost: 0,
    clears: 0,
    compacts: 0,
    idleClears: 0,
    avgContext: 0,
    turns: turns.length,
  };
  let sim = 0; // simulated context of the previous request
  let prevActual = 0;
  let counted = 0;
  let ctxSum = 0;
  for (let i = 0; i < reqs.length; i++) {
    const q = reqs[i]!;
    const u = q.usage;
    const C = contextTokens(u);
    const outputCost = u.output_tokens * r.r_out;
    res.actualCost +=
      u.input_tokens +
      u.cache_creation_input_tokens * r.r_write +
      u.cache_read_input_tokens * r.r_read +
      outputCost;
    if (C === 0) {
      res.cost += outputCost;
      continue;
    }
    if (counted === 0) sim = C;
    else if (compactStarts.has(i)) sim = Math.min(sim, C);
    else sim = sim + (C - prevActual);
    sim = Math.min(C, Math.max(sim, Math.min(B, C)));
    prevActual = C;

    const cw = Math.min(u.cache_creation_input_tokens, sim);
    const cr = Math.max(0, sim - cw - u.input_tokens);
    res.cost += u.input_tokens + cw * r.r_write + cr * r.r_read + outputCost;
    ctxSum += sim;
    counted++;

    // Actions at the end of a turn, before the user's next prompt.
    const turn = turnEnds.get(i);
    const next = reqs[i + 1];
    if (!turn || !next || sim < o.minContext) continue;
    const R = recent(i);
    const be = breakeven({ C: sim, B, K: o.keynotesTokens, R, baseCached: true }, r);
    const signalled =
      p.boundary === 'any'
        ? turn.signals.size > 0
        : p.boundary === 'strong' && [...turn.signals].some((x) => STRONG_SIGNALS.has(x));
    if (signalled && be.breakevenTurns <= p.maxBreakevenTurns) {
      res.cost += be.oneTime;
      res.clears++;
      sim = be.S;
      continue;
    }
    if (p.budget !== undefined && sim > p.budget) {
      // The compaction call reads the whole context and writes a summary; recent files get re-read after it.
      res.cost += sim * r.r_read + o.summaryTokens * (r.r_out + r.r_write) + R * r.r_write;
      res.compacts++;
      sim = B + o.summaryTokens + R;
      continue;
    }
    if (p.idle) {
      const nu = next.usage;
      const nextC = contextTokens(nu);
      const rebuilt = nextC >= 20_000 && nu.cache_creation_input_tokens >= 0.5 * nextC;
      // The next request re-writes everything either way; clearing makes that rewrite S instead of the full context.
      if (rebuilt && r.r_write * (sim - be.S) > r.r_out * o.keynotesTokens) {
        res.cost += r.r_out * o.keynotesTokens;
        res.idleClears++;
        sim = be.S;
      }
    }
  }
  res.avgContext = counted ? ctxSum / counted : 0;
  return res;
}
