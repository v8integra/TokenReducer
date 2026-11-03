import { breakeven } from '../breakeven/index.js';
import { matchNoisyCommand } from '../guards/noisy.js';
import {
  contextTokens,
  contextWindowFor,
  weightedCost,
  type PriceRatios,
  type Usage,
  type WeightedCost,
} from '../pricing/index.js';
import type { ApiRequest, Compaction, ParsedSession, ToolCall } from '../transcript/types.js';
import { pathKey } from '../util/paths.js';
import { estimateTokens } from '../util/tokens.js';
import type { PolicyResult } from '../simulate/index.js';
import { inferTargetProject } from './target.js';

export interface AnalyzeOptions {
  ratios: PriceRatios;
  cacheTtlMinutes: number;
  /** Advisor threshold: recommend clearing when it pays off within this many requests. */
  maxBreakevenTurns: number;
  /** Keynotes size carried into a fresh session (K). */
  keynotesTokens: number;
  /** Requests to look back when estimating files that would be re-read after a clear (M). */
  reReadWindow: number;
  reReadCap: number;
  largeFileLines: number;
  noisyExtra: string[];
}

export const DEFAULT_ANALYZE_OPTIONS: AnalyzeOptions = {
  ratios: { r_read: 0.1, r_write: 1.25, r_out: 5 },
  cacheTtlMinutes: 5,
  maxBreakevenTurns: 4,
  keynotesTokens: 1500,
  reReadWindow: 10,
  reReadCap: 50_000,
  largeFileLines: 800,
  noisyExtra: [],
};

export interface CategoryCost {
  category: string;
  /** Sum over requests of the tokens this category occupied in context. */
  tokensCarried: number;
  /** Input-token-equivalent cost attributed to the category. */
  cost: number;
}

export interface CurvePoint {
  i: number;
  t: number;
  context: number;
  breakevenTurns: number;
}

export interface ClearPoint {
  requestIndex: number;
  context: number;
  startContext: number;
  breakevenTurns: number;
  requestsAfter: number;
  /** Upper bound: one clear at this point, saving (C - S) cache reads on every later request in the segment. */
  saving: number;
}

export interface CacheRebuild {
  requestIndex: number;
  gapMinutes: number;
  tokensRewritten: number;
}

export interface BigToolResult {
  tool: string;
  label: string;
  tokens: number;
  requestsCarried: number;
  cost: number;
}

export interface RepeatedRead {
  path: string;
  reads: number;
  /** Reads of the same range with identical content and no compaction in between. */
  duplicateReads: number;
  duplicateTokens: number;
  duplicateCost: number;
}

export interface GuardSim {
  hits: number;
  tokens: number;
  /** Estimated cost avoided, including the cache reads the content would have caused later. */
  cost: number;
}

export interface SessionAnalysis {
  sessionId: string;
  file: string;
  title?: string;
  cwd?: string;
  target: string;
  models: string[];
  start: number;
  end: number;
  requests: number;
  sidechainRequests: number;
  humanPrompts: number;
  compactions: Compaction[];
  usage: Usage;
  sidechainUsage: Usage;
  cost: WeightedCost;
  sidechainCost: WeightedCost;
  cacheHitRatio: number;
  baseOverhead: number;
  peakContext: number;
  contextWindow: number;
  categories: CategoryCost[];
  curve: CurvePoint[];
  clearPoints: ClearPoint[];
  cache: {
    gapsOverTtl: number;
    gapsOverHour: number;
    rebuilds: CacheRebuild[];
    rebuildExcessCost: number;
  };
  biggestToolResults: BigToolResult[];
  repeatedReads: RepeatedRead[];
  toolStats: { tool: string; calls: number; resultTokens: number; cost: number }[];
  guardSim: {
    duplicateRead: GuardSim;
    largeFile: GuardSim;
    noisyCommand: GuardSim & { byPattern: Record<string, number> };
  };
  modelSwitches: number;
  malformedLines: number;
  /** Present when the caller ran the policy simulation (`analyze --simulate`). */
  simulation?: PolicyResult[];
}

const OUTPUT = 'output (generation)';
const FIXED = 'fixed overhead (system, tools, memory)';
const PROMPTS = 'user prompts';
const ASSISTANT = 'assistant text in context';
const TOOL_INPUTS = 'tool call inputs (edits, writes, commands)';
const THINKING = 'assistant thinking in context (estimated)';
const META = 'system reminders & attachments';
const OTHER = 'unattributed (estimate gap)';
const SUMMARY = 'compaction summaries';

/** Groups `mcp__server__tool` by server so dozens of browser tools read as one line. */
export function toolCategory(name: string): string {
  const m = /^mcp__(.+?)__/.exec(name);
  if (m) {
    const server = m[1]!;
    return `tool: mcp ${/^[0-9a-f-]{36}$/.test(server) ? 'connector' : server}`;
  }
  return `tool: ${name}`;
}

interface Item {
  category: string;
  tokens: number;
  addedBefore: number;
}

export function analyzeSession(
  s: ParsedSession,
  opts: AnalyzeOptions = DEFAULT_ANALYZE_OPTIONS,
): SessionAnalysis {
  const r = opts.ratios;
  const reqs = s.requests;
  const segStarts = s.compactions.map((c) => c.beforeRequest);
  const segmentEnd = (i: number) => segStarts.find((b) => b > i) ?? reqs.length;
  const segmentOf = (i: number) => segStarts.filter((b) => b <= i).length;

  // Everything that enters the context, with the first request that sees it.
  const items: Item[] = [];
  for (const p of s.prompts) {
    const category = p.kind === 'human' ? PROMPTS : p.kind === 'compact-summary' ? SUMMARY : META;
    items.push({ category, tokens: estimateTokens(p.chars), addedBefore: p.addedBefore });
  }
  for (const q of reqs) {
    const chars = q.textChars + q.toolUseChars;
    if (q.textChars > 0)
      items.push({
        category: ASSISTANT,
        tokens: estimateTokens(q.textChars),
        addedBefore: q.index + 1,
      });
    if (q.toolUseChars > 0)
      items.push({
        category: TOOL_INPUTS,
        tokens: estimateTokens(q.toolUseChars),
        addedBefore: q.index + 1,
      });
    // Transcripts store only a signature for thinking; output tokens minus visible output approximates it.
    const thinking = q.usage.output_tokens - estimateTokens(chars);
    if (thinking > 0)
      items.push({ category: THINKING, tokens: thinking, addedBefore: q.index + 1 });
  }
  const mainCalls = s.toolCalls.filter(
    (t) => !t.isSidechain && t.result && t.resultAddedBefore >= 0,
  );
  for (const t of mainCalls) {
    items.push({
      category: toolCategory(t.name),
      tokens: estimateTokens(t.result!.chars),
      addedBefore: t.resultAddedBefore,
    });
  }
  items.sort((a, b) => a.addedBefore - b.addedBefore);

  // Walk requests, tracking what is alive in context, and split each request's cost across categories.
  const alive = new Map<string, number>();
  const carried = new Map<string, number>();
  const costs = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  let itemPtr = 0;
  let baseOverhead = -1;
  let peakContext = 0;
  const contexts: number[] = [];
  for (const q of reqs) {
    if (segStarts.includes(q.index)) alive.clear();
    while (itemPtr < items.length && items[itemPtr]!.addedBefore <= q.index) {
      const it = items[itemPtr++]!;
      // Items from before a compaction never reach a request after it.
      if (segmentOf(it.addedBefore) === segmentOf(q.index)) add(alive, it.category, it.tokens);
    }
    const C = contextTokens(q.usage);
    contexts.push(C);
    if (C === 0) continue;
    peakContext = Math.max(peakContext, C);
    const est = [...alive.values()].reduce((a, b) => a + b, 0);
    if (baseOverhead < 0) baseOverhead = Math.max(0, C - est);
    const fixed = Math.min(baseOverhead, C);
    const room = C - fixed;
    const scale = est > room ? room / est : 1;
    const composition = new Map<string, number>([[FIXED, fixed]]);
    for (const [k, v] of alive) composition.set(k, v * scale);
    composition.set(OTHER, (composition.get(OTHER) ?? 0) + Math.max(0, room - est * scale));
    const w = weightedCost(q.usage, r);
    const inputSide = w.input + w.cacheRead + w.cacheWrite;
    for (const [k, v] of composition) {
      add(carried, k, v);
      add(costs, k, (inputSide * v) / C);
    }
    add(costs, OUTPUT, w.output);
  }
  if (baseOverhead < 0) baseOverhead = 0;

  const categories: CategoryCost[] = [...costs.entries()]
    .map(([category, cost]) => ({ category, cost, tokensCarried: carried.get(category) ?? 0 }))
    .sort((a, b) => b.cost - a.cost);

  // How many main requests carry something added before request `from` (until compaction or the end).
  const carriedCount = (from: number) => {
    const end = segmentEnd(from);
    let n = 0;
    for (let i = from; i < end; i++) if (contexts[i]! > 0) n++;
    return n;
  };
  const lifetimeCost = (tokens: number, from: number) => {
    const n = carriedCount(from);
    return n === 0 ? 0 : tokens * (r.r_write + r.r_read * (n - 1));
  };

  // Break-even curve and the first point per segment where clearing would have paid off.
  const recentFiles = recentFileTokens(s, opts);
  const curve: CurvePoint[] = [];
  const clearPoints: ClearPoint[] = [];
  let lastSeg = -1;
  for (const q of reqs) {
    const C = contexts[q.index]!;
    if (C === 0) continue;
    const be = breakeven(
      { C, B: baseOverhead, K: opts.keynotesTokens, R: recentFiles(q.index), baseCached: true },
      r,
    );
    curve.push({ i: q.index, t: q.timestamp, context: C, breakevenTurns: be.breakevenTurns });
    const seg = segmentOf(q.index);
    if (seg !== lastSeg && be.breakevenTurns <= opts.maxBreakevenTurns) {
      lastSeg = seg;
      const after = carriedCount(q.index + 1);
      clearPoints.push({
        requestIndex: q.index,
        context: C,
        startContext: be.S,
        breakevenTurns: be.breakevenTurns,
        requestsAfter: after,
        saving: Math.max(0, after * be.perTurnSaving - be.oneTime),
      });
    }
  }

  // Cache behaviour: idle gaps and requests that had to re-write most of the context.
  const ttlMs = opts.cacheTtlMinutes * 60_000;
  let gapsOverTtl = 0;
  let gapsOverHour = 0;
  const rebuilds: CacheRebuild[] = [];
  let rebuildExcessCost = 0;
  for (let i = 1; i < reqs.length; i++) {
    const q = reqs[i]!;
    const gap = q.timestamp - reqs[i - 1]!.timestamp;
    if (gap > ttlMs) gapsOverTtl++;
    if (gap > 3_600_000) gapsOverHour++;
    const C = contexts[i]!;
    const cw = q.usage.cache_creation_input_tokens;
    if (!segStarts.includes(i) && C >= 20_000 && cw >= 0.5 * C) {
      rebuilds.push({ requestIndex: i, gapMinutes: gap / 60_000, tokensRewritten: cw });
      rebuildExcessCost += cw * (r.r_write - r.r_read);
    }
  }

  // Tool results: biggest, per-tool totals, and what the planned guards would have caught.
  const toolStats = new Map<string, { calls: number; resultTokens: number; cost: number }>();
  const big: BigToolResult[] = [];
  const guardSim = {
    duplicateRead: { hits: 0, tokens: 0, cost: 0 },
    largeFile: { hits: 0, tokens: 0, cost: 0 },
    noisyCommand: { hits: 0, tokens: 0, cost: 0, byPattern: {} as Record<string, number> },
  };
  const reads = new Map<
    string,
    {
      path: string;
      reads: number;
      dup: number;
      dupTokens: number;
      dupCost: number;
      last?: { range: string; hash: string; seg: number };
    }
  >();
  for (const t of mainCalls) {
    const res = t.result!;
    const tokens = estimateTokens(res.chars);
    const cost = lifetimeCost(tokens, t.resultAddedBefore);
    const st = toolStats.get(t.name) ?? { calls: 0, resultTokens: 0, cost: 0 };
    st.calls++;
    st.resultTokens += tokens;
    st.cost += cost;
    toolStats.set(t.name, st);
    big.push({
      tool: t.name,
      label: labelFor(t),
      tokens,
      requestsCarried: carriedCount(t.resultAddedBefore),
      cost,
    });

    if (t.name === 'Read' && t.input.file_path && !res.isError) {
      const key = pathKey(t.input.file_path);
      const range = `${t.input.offset ?? ''}:${t.input.limit ?? ''}`;
      const seg = segmentOf(t.resultAddedBefore);
      const rec = reads.get(key) ?? {
        path: t.input.file_path,
        reads: 0,
        dup: 0,
        dupTokens: 0,
        dupCost: 0,
      };
      rec.reads++;
      if (
        rec.last &&
        rec.last.range === range &&
        rec.last.hash === res.hash &&
        rec.last.seg === seg
      ) {
        rec.dup++;
        rec.dupTokens += tokens;
        rec.dupCost += cost;
        guardSim.duplicateRead.hits++;
        guardSim.duplicateRead.tokens += tokens;
        guardSim.duplicateRead.cost += cost;
      }
      rec.last = { range, hash: res.hash, seg };
      reads.set(key, rec);
      if (
        t.input.offset === undefined &&
        t.input.limit === undefined &&
        res.lines > opts.largeFileLines
      ) {
        // A targeted read of ~200 lines would usually have done.
        const saved = tokens * (1 - 200 / res.lines);
        guardSim.largeFile.hits++;
        guardSim.largeFile.tokens += saved;
        guardSim.largeFile.cost += (cost * saved) / tokens;
      }
    }
    if (t.name === 'Bash' && t.input.command && tokens > 1000) {
      const hit = matchNoisyCommand(t.input.command, opts.noisyExtra);
      if (hit) {
        // Assume a quiet variant prints ~300 tokens.
        const saved = tokens - 300;
        guardSim.noisyCommand.hits++;
        guardSim.noisyCommand.tokens += saved;
        guardSim.noisyCommand.cost += (cost * saved) / tokens;
        guardSim.noisyCommand.byPattern[hit.id] =
          (guardSim.noisyCommand.byPattern[hit.id] ?? 0) + 1;
      }
    }
  }

  const usage = sumUsage(reqs);
  const sidechainUsage = sumUsage(s.sidechainRequests);
  const sidechainCost = weightedCost(sidechainUsage, r);
  const mainCost = weightedCost(usage, r);
  const cost = addCost(mainCost, sidechainCost);
  const totalIn =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  const models = [...new Set(reqs.map((q) => q.model).filter(realModel))];
  let modelSwitches = 0;
  let prevModel: string | undefined;
  for (const q of reqs) {
    if (!realModel(q.model)) continue;
    if (prevModel && q.model !== prevModel) modelSwitches++;
    prevModel = q.model;
  }

  return {
    sessionId: s.sessionId,
    file: s.file,
    title: s.title,
    cwd: s.cwd,
    target: inferTargetProject(s),
    models,
    start: s.firstTimestamp,
    end: s.lastTimestamp,
    requests: reqs.length,
    sidechainRequests: s.sidechainRequests.length,
    humanPrompts: s.prompts.filter((p) => p.kind === 'human').length,
    compactions: s.compactions,
    usage,
    sidechainUsage,
    cost,
    sidechainCost,
    cacheHitRatio: totalIn > 0 ? usage.cache_read_input_tokens / totalIn : 0,
    baseOverhead,
    peakContext,
    contextWindow: contextWindowFor(models[0], peakContext),
    categories,
    curve,
    clearPoints,
    cache: { gapsOverTtl, gapsOverHour, rebuilds, rebuildExcessCost },
    biggestToolResults: big.sort((a, b) => b.cost - a.cost).slice(0, 10),
    repeatedReads: [...reads.values()]
      .filter((x) => x.reads > 1)
      .map((x) => ({
        path: x.path,
        reads: x.reads,
        duplicateReads: x.dup,
        duplicateTokens: x.dupTokens,
        duplicateCost: x.dupCost,
      }))
      .sort((a, b) => b.duplicateCost - a.duplicateCost || b.reads - a.reads),
    toolStats: [...toolStats.entries()]
      .map(([tool, v]) => ({ tool, ...v }))
      .sort((a, b) => b.cost - a.cost),
    guardSim,
    modelSwitches,
    malformedLines: s.malformedLines,
  };
}

/** R in the break-even formula: tokens of distinct files read or edited in the last M requests, capped. */
export function recentFileTokens(
  s: ParsedSession,
  opts: Pick<AnalyzeOptions, 'reReadWindow' | 'reReadCap'>,
) {
  const touches: { i: number; key: string; tokens: number }[] = [];
  const lastReadTokens = new Map<string, number>();
  for (const t of s.toolCalls) {
    if (t.isSidechain || !t.input.file_path) continue;
    const key = pathKey(t.input.file_path);
    if (t.name === 'Read' && t.result && !t.result.isError) {
      const tokens = estimateTokens(t.result.chars);
      lastReadTokens.set(key, tokens);
      touches.push({ i: t.requestIndex, key, tokens });
    } else if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t.name)) {
      touches.push({
        i: t.requestIndex,
        key,
        tokens: lastReadTokens.get(key) ?? estimateTokens(t.inputChars),
      });
    }
  }
  touches.sort((a, b) => a.i - b.i);
  return (i: number): number => {
    const files = new Map<string, number>();
    for (const x of touches) {
      if (x.i > i) break;
      if (x.i >= i - opts.reReadWindow) files.set(x.key, x.tokens);
    }
    let sum = 0;
    for (const v of files.values()) sum += v;
    return Math.min(sum, opts.reReadCap);
  };
}

function labelFor(t: ToolCall): string {
  const i = t.input;
  if (i.file_path)
    return (
      i.file_path +
      (i.offset !== undefined || i.limit !== undefined
        ? ` [${i.offset ?? 0}+${i.limit ?? ''}]`
        : '')
    );
  if (i.command) {
    // A leading `cd <dir> &&` says nothing about what produced the output.
    const cmd = i.command.replace(/^\s*cd\s+("[^"]*"|\S+)\s*(&&|;)\s*/, '');
    return cmd.replace(/\s+/g, ' ').slice(0, 70);
  }
  if (i.pattern) return `pattern: ${i.pattern.slice(0, 60)}`;
  if (i.url) return i.url.slice(0, 70);
  if (i.path) return i.path;
  return '';
}

function realModel(m: string): boolean {
  return m !== 'unknown' && !m.startsWith('<');
}

export function sumUsage(reqs: ApiRequest[]): Usage {
  const u: Usage = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  for (const q of reqs) {
    u.input_tokens += q.usage.input_tokens;
    u.cache_creation_input_tokens += q.usage.cache_creation_input_tokens;
    u.cache_read_input_tokens += q.usage.cache_read_input_tokens;
    u.output_tokens += q.usage.output_tokens;
  }
  return u;
}

export function addCost(a: WeightedCost, b: WeightedCost): WeightedCost {
  return {
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    total: a.total + b.total,
  };
}
