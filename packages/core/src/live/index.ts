import { analyzeSession, DEFAULT_ANALYZE_OPTIONS } from '../accounting/analyze.js';
import {
  detectTurns,
  newBoundaryCarry,
  type BoundaryCarry,
  type BoundarySignal,
} from '../boundaries/index.js';
import { breakeven } from '../breakeven/index.js';
import { newFacts, updateFacts, type Facts } from '../keynotes/index.js';
import { contextTokens, type PriceRatios, type Usage } from '../pricing/index.js';
import { TranscriptParser } from '../transcript/parse.js';
import { pathKey } from '../util/paths.js';
import { estimateTokens } from '../util/tokens.js';

/**
 * Per-session metrics the hooks keep up to date. The Stop hook feeds only the transcript lines written since
 * the last update, so the cost stays flat however long the session gets. Everything is plain JSON so it can
 * be stored in `.tokentrim/state/<session>.json` and read by the status line.
 */
export interface LiveState {
  version: 1;
  sessionId: string;
  /** How the session started (SessionStart `source`). */
  source?: string;
  /** Transcript this state was built from, so commands outside hooks can refresh it. */
  transcriptPath?: string;
  /** Bytes of the transcript already consumed. Owned by the I/O layer. */
  offset: number;
  requests: number;
  lastMessageId?: string;
  model?: string;
  baseOverhead: number | null;
  /** Context of the latest request. */
  context: number;
  lastRequestAt: number;
  compactions: number;
  cost: { input: number; cacheWrite: number; cacheRead: number; output: number; total: number };
  inputSideTokens: number;
  cacheReadTokens: number;
  /** Files read or edited recently, for R in the break-even formula. */
  touches: { i: number; key: string; tokens: number }[];
  carry: BoundaryCarry;
  lastTurnSignals: BoundarySignal[];
  breakeven: { S: number; oneTime: number; turns: number | null } | null;
  /** Keynotes Facts, kept current by every update. Absent in state files from before Phase 2e. */
  facts?: Facts;
  updatedAt: number;
}

export interface LiveOptions {
  ratios: PriceRatios;
  keynotesTokens: number;
  reReadWindow: number;
  reReadCap: number;
}

export const DEFAULT_LIVE_OPTIONS: LiveOptions = {
  ratios: DEFAULT_ANALYZE_OPTIONS.ratios,
  keynotesTokens: DEFAULT_ANALYZE_OPTIONS.keynotesTokens,
  reReadWindow: DEFAULT_ANALYZE_OPTIONS.reReadWindow,
  reReadCap: DEFAULT_ANALYZE_OPTIONS.reReadCap,
};

/** Remembered read sizes are capped so the state file stays small in very long sessions. */
const MAX_TOUCHES = 200;

export function newLiveState(sessionId: string, source?: string): LiveState {
  return {
    version: 1,
    sessionId,
    source,
    offset: 0,
    requests: 0,
    baseOverhead: null,
    context: 0,
    lastRequestAt: 0,
    compactions: 0,
    cost: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 },
    inputSideTokens: 0,
    cacheReadTokens: 0,
    touches: [],
    carry: newBoundaryCarry(),
    lastTurnSignals: [],
    breakeven: null,
    facts: newFacts(),
    updatedAt: 0,
  };
}

/** Applies newly written transcript lines (complete lines only) to the state. Returns the same object. */
export function updateLive(
  state: LiveState,
  newLines: string,
  opts: LiveOptions = DEFAULT_LIVE_OPTIONS,
  now = Date.now(),
): LiveState {
  const p = new TranscriptParser('live.jsonl', state.sessionId);
  for (const line of newLines.split('\n')) p.addLine(line);
  const delta = p.finish();
  const r = opts.ratios;

  if (state.baseOverhead === null && state.requests === 0 && delta.requests.length > 0) {
    state.baseOverhead = analyzeSession(delta).baseOverhead;
  }

  // Map each request in this chunk to its index in the whole session. A message split across two chunks keeps
  // the index it got the first time and isn't counted again.
  const globalIndex: number[] = [];
  for (const q of delta.requests) {
    if (q.id === state.lastMessageId) {
      globalIndex.push(state.requests - 1);
      continue;
    }
    globalIndex.push(state.requests);
    state.requests++;
    state.lastMessageId = q.id;
    addUsage(state, q.usage, r);
    const C = contextTokens(q.usage);
    if (C > 0) state.context = C;
    if (q.timestamp) state.lastRequestAt = q.timestamp;
    if (q.model && !q.model.startsWith('<') && q.model !== 'unknown') state.model = q.model;
  }

  // Whatever was read before the last compaction is gone from context.
  let cut = -1;
  if (delta.compactions.length > 0) {
    state.compactions += delta.compactions.length;
    const last = delta.compactions.at(-1)!;
    cut =
      last.beforeRequest < globalIndex.length ? globalIndex[last.beforeRequest]! : state.requests;
  }

  const lastReads = new Map(state.touches.map((t) => [t.key, t.tokens]));
  for (const t of delta.toolCalls) {
    if (t.isSidechain || !t.input.file_path || t.requestIndex < 0) continue;
    const i = globalIndex[t.requestIndex] ?? state.requests - 1;
    const key = pathKey(t.input.file_path);
    if (t.name === 'Read' && t.result && !t.result.isError) {
      const tokens = estimateTokens(t.result.chars);
      lastReads.set(key, tokens);
      state.touches.push({ i, key, tokens });
    } else if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t.name)) {
      state.touches.push({ i, key, tokens: lastReads.get(key) ?? estimateTokens(t.inputChars) });
    }
  }
  const windowStart = Math.max(cut, state.requests - 1 - opts.reReadWindow);
  state.touches = state.touches.filter((t) => t.i >= windowStart).slice(-MAX_TOUCHES);

  updateFacts((state.facts ??= newFacts()), delta);

  const turns = detectTurns(delta, state.carry);
  if (delta.requests.length > 0) state.lastTurnSignals = [...(turns.at(-1)?.signals ?? [])];

  state.breakeven = liveBreakeven(state, state.context, opts);
  state.updatedAt = now;
  return state;
}

/**
 * Break-even for clearing now, at context `C` (the status line passes a fresher C than the last Stop saw).
 * Null until the session's base overhead is known.
 */
export function liveBreakeven(
  state: LiveState,
  C: number,
  opts: LiveOptions = DEFAULT_LIVE_OPTIONS,
): LiveState['breakeven'] {
  if (state.baseOverhead === null || C <= 0) return null;
  const files = new Map<string, number>();
  for (const t of state.touches) files.set(t.key, t.tokens);
  let R = 0;
  for (const v of files.values()) R += v;
  const be = breakeven(
    {
      C,
      B: state.baseOverhead,
      K: opts.keynotesTokens,
      R: Math.min(R, opts.reReadCap),
      baseCached: true,
    },
    opts.ratios,
  );
  return {
    S: be.S,
    oneTime: be.oneTime,
    turns: Number.isFinite(be.breakevenTurns) ? be.breakevenTurns : null,
  };
}

function addUsage(state: LiveState, u: Usage, r: PriceRatios): void {
  const cw = u.cache_creation_input_tokens * r.r_write;
  const cr = u.cache_read_input_tokens * r.r_read;
  const out = u.output_tokens * r.r_out;
  state.cost.input += u.input_tokens;
  state.cost.cacheWrite += cw;
  state.cost.cacheRead += cr;
  state.cost.output += out;
  state.cost.total += u.input_tokens + cw + cr + out;
  state.inputSideTokens += contextTokens(u);
  state.cacheReadTokens += u.cache_read_input_tokens;
}

/** Validates a state object read from disk. Anything unexpected means "start over", never a crash. */
export function isLiveState(v: unknown): v is LiveState {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.version === 1 &&
    typeof o.sessionId === 'string' &&
    typeof o.offset === 'number' &&
    typeof o.requests === 'number' &&
    Array.isArray(o.touches) &&
    typeof o.cost === 'object' &&
    o.cost !== null &&
    typeof o.carry === 'object' &&
    o.carry !== null
  );
}
