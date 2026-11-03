import { STRONG_SIGNALS } from '../boundaries/index.js';
import { expiredCacheChoice } from '../breakeven/index.js';
import type { TokenTrimConfig } from '../config/defaults.js';
import { liveBreakeven, type LiveState } from '../live/index.js';

/** What the status line knows from Claude Code's own stdin JSON, normalized. */
export interface MeterInput {
  /** Tokens in context on the latest request (input + cache reads + cache writes). */
  context: number;
  window: number;
  /** Claude Code's own session cost estimate, when it sends one. */
  usd?: number;
  cache?: { warm: boolean; expiresAt: number | null };
  now: number;
}

export type Band = 'green' | 'yellow' | 'red';

export interface MeterResult {
  band: Band;
  /** Plain text without colour codes. */
  text: string;
  /** Recommended action at red, if any. */
  action?: string;
}

const COLORS: Record<Band, string> = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return `${Math.round(n)}`;
}

/**
 * Builds the meter line (plan §5.1). Bands key off absolute context against the budget and the break-even, not
 * window percentage: on a 1M window, 45% is already ~450K tokens re-read per request.
 *
 * - red: clearing pays off now at a task boundary, the context is over budget, or the cache went cold with a
 *   context big enough that clearing first is cheaper;
 * - yellow: past 60% of the budget, or clearing would pay off soon;
 * - green: otherwise.
 */
export function evaluateMeter(
  m: MeterInput,
  state: LiveState | null,
  c: TokenTrimConfig,
): MeterResult {
  const r = c.pricing;
  const ratios = { r_read: r.r_read, r_write: r.r_write, r_out: r.r_out };
  const C = m.context || state?.context || 0;
  const be = state
    ? liveBreakeven(state, C, {
        ratios,
        keynotesTokens: c.checkpoint.max_tokens,
        reReadWindow: 10,
        reReadCap: 50_000,
      })
    : null;
  const turns = be?.turns ?? null;
  const maxBe = c.advisor.max_breakeven_turns;
  const budget = c.advisor.context_budget;
  const signals = state?.lastTurnSignals ?? [];
  const atBoundary =
    c.advisor.boundary_signals === 'any'
      ? signals.length > 0
      : signals.some((s) => STRONG_SIGNALS.has(s));

  // Cold cache: the next request re-writes the whole context, so clearing first may be cheaper (plan §6).
  let coldClear = false;
  const B = state?.baseOverhead;
  if (m.cache && !m.cache.warm && C >= c.idle.min_context && B != null && be) {
    const K = c.checkpoint.max_tokens;
    const R = be.S - B - K; // the re-read estimate liveBreakeven already worked out
    coldClear = expiredCacheChoice({ C, B, K, R, baseCached: false }, ratios).clearIsCheaper;
  }

  let band: Band = 'green';
  let action: string | undefined;
  if (coldClear) {
    band = 'red';
    action = 'cache expired: /clear first is cheaper';
  } else if (turns !== null && turns <= maxBe && atBoundary) {
    band = 'red';
    // Keynotes carry the work across the clear when the checkpoint module is on.
    action = c.modules.checkpoint
      ? 'good moment: /tokentrim:checkpoint, then /clear'
      : 'good moment to /clear';
  } else if (C >= budget) {
    band = 'red';
    action = 'over budget: /compact';
  } else if (C >= 0.6 * budget || (turns !== null && turns <= 2 * maxBe)) {
    band = 'yellow';
  }

  const parts = [`${tokens(C)} ctx`, `next req ≈${tokens(C * r.r_read)}`];
  // Only once it matters (the yellow threshold); early in a session it would just be noise.
  if (turns !== null && turns <= 2 * maxBe)
    parts.push(`clear pays off in ${turns < 1 ? '<1' : Math.round(turns)} req`);
  if (m.cache) {
    if (!m.cache.warm) parts.push('cache cold');
    else if (m.cache.expiresAt) {
      const mins = Math.max(0, Math.round((m.cache.expiresAt * 1000 - m.now) / 60_000));
      parts.push(`cache ${mins}m`);
    }
  }
  if (m.usd !== undefined) parts.push(`$${m.usd.toFixed(2)}`);
  else if (state) {
    const usd = r.usd_per_mtok_input;
    parts.push(
      usd == null
        ? `${tokens(state.cost.total)} ITE`
        : `$${((state.cost.total / 1e6) * usd).toFixed(2)}`,
    );
  }
  let text = parts.join(' · ');
  if (action) text += ` → ${action}`;
  return { band, text, action };
}

export function colorize(res: MeterResult, color: boolean): string {
  if (!color) return `${res.band === 'red' ? '⚠ ' : ''}${res.text}`;
  const dot = `${COLORS[res.band]}●${RESET}`;
  if (!res.action) return `${dot} ${DIM}${res.text}${RESET}`;
  const [main, action] = res.text.split(' → ');
  return `${dot} ${main} ${COLORS[res.band]}→ ${action}${RESET}`;
}
