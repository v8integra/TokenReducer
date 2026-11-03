import {
  addCost,
  type BigToolResult,
  type CategoryCost,
  type GuardSim,
  type RepeatedRead,
  type SessionAnalysis,
  type Usage,
  type WeightedCost,
} from '@tokentrim/core';

export interface Aggregate {
  sessions: SessionAnalysis[];
  start: number;
  end: number;
  usage: Usage;
  sidechainUsage: Usage;
  cost: WeightedCost;
  sidechainCost: WeightedCost;
  requests: number;
  sidechainRequests: number;
  humanPrompts: number;
  compactions: number;
  cacheHitRatio: number;
  categories: CategoryCost[];
  biggest: (BigToolResult & { sessionId: string })[];
  repeatedReads: (RepeatedRead & { sessionId: string })[];
  toolStats: { tool: string; calls: number; resultTokens: number; cost: number }[];
  guardSim: {
    duplicateRead: GuardSim;
    largeFile: GuardSim;
    noisyCommand: GuardSim;
    byPattern: Record<string, number>;
  };
  clearSaving: number;
  clearPoints: number;
  rebuilds: number;
  rebuildsShortGap: number;
  rebuildExcessCost: number;
  gapsOverTtl: number;
  gapsOverHour: number;
  modelSwitches: number;
  malformedLines: number;
}

const ZERO_COST: WeightedCost = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 };

export function aggregate(sessions: SessionAnalysis[], ttlMinutes: number): Aggregate {
  const usage = zeroUsage();
  const sidechainUsage = zeroUsage();
  let cost = ZERO_COST;
  let sidechainCost = ZERO_COST;
  const cats = new Map<string, CategoryCost>();
  const tools = new Map<
    string,
    { tool: string; calls: number; resultTokens: number; cost: number }
  >();
  const g = {
    duplicateRead: zeroSim(),
    largeFile: zeroSim(),
    noisyCommand: zeroSim(),
    byPattern: {} as Record<string, number>,
  };
  const a: Aggregate = {
    sessions,
    start: Math.min(...sessions.map((s) => s.start)),
    end: Math.max(...sessions.map((s) => s.end)),
    usage,
    sidechainUsage,
    cost,
    sidechainCost,
    requests: 0,
    sidechainRequests: 0,
    humanPrompts: 0,
    compactions: 0,
    cacheHitRatio: 0,
    categories: [],
    biggest: [],
    repeatedReads: [],
    toolStats: [],
    guardSim: g,
    clearSaving: 0,
    clearPoints: 0,
    rebuilds: 0,
    rebuildsShortGap: 0,
    rebuildExcessCost: 0,
    gapsOverTtl: 0,
    gapsOverHour: 0,
    modelSwitches: 0,
    malformedLines: 0,
  };
  for (const s of sessions) {
    addUsage(usage, s.usage);
    addUsage(sidechainUsage, s.sidechainUsage);
    cost = addCost(cost, s.cost);
    sidechainCost = addCost(sidechainCost, s.sidechainCost);
    a.requests += s.requests;
    a.sidechainRequests += s.sidechainRequests;
    a.humanPrompts += s.humanPrompts;
    a.compactions += s.compactions.length;
    for (const c of s.categories) {
      const x = cats.get(c.category) ?? { category: c.category, cost: 0, tokensCarried: 0 };
      x.cost += c.cost;
      x.tokensCarried += c.tokensCarried;
      cats.set(c.category, x);
    }
    for (const t of s.toolStats) {
      const x = tools.get(t.tool) ?? { tool: t.tool, calls: 0, resultTokens: 0, cost: 0 };
      x.calls += t.calls;
      x.resultTokens += t.resultTokens;
      x.cost += t.cost;
      tools.set(t.tool, x);
    }
    a.biggest.push(...s.biggestToolResults.map((b) => ({ ...b, sessionId: s.sessionId })));
    a.repeatedReads.push(...s.repeatedReads.map((r) => ({ ...r, sessionId: s.sessionId })));
    addSim(g.duplicateRead, s.guardSim.duplicateRead);
    addSim(g.largeFile, s.guardSim.largeFile);
    addSim(g.noisyCommand, s.guardSim.noisyCommand);
    for (const [k, v] of Object.entries(s.guardSim.noisyCommand.byPattern))
      g.byPattern[k] = (g.byPattern[k] ?? 0) + v;
    a.clearSaving += s.clearPoints.reduce((n, p) => n + p.saving, 0);
    a.clearPoints += s.clearPoints.length;
    a.rebuilds += s.cache.rebuilds.length;
    a.rebuildsShortGap += s.cache.rebuilds.filter((r) => r.gapMinutes <= ttlMinutes).length;
    a.rebuildExcessCost += s.cache.rebuildExcessCost;
    a.gapsOverTtl += s.cache.gapsOverTtl;
    a.gapsOverHour += s.cache.gapsOverHour;
    a.modelSwitches += s.modelSwitches;
    a.malformedLines += s.malformedLines;
  }
  const totalIn =
    usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  a.cost = cost;
  a.sidechainCost = sidechainCost;
  a.cacheHitRatio = totalIn > 0 ? usage.cache_read_input_tokens / totalIn : 0;
  a.categories = [...cats.values()].sort((x, y) => y.cost - x.cost);
  a.toolStats = [...tools.values()].sort((x, y) => y.cost - x.cost);
  a.biggest = a.biggest.sort((x, y) => y.cost - x.cost).slice(0, 10);
  a.repeatedReads = a.repeatedReads
    .sort((x, y) => y.duplicateCost - x.duplicateCost || y.reads - x.reads)
    .slice(0, 15);
  return a;
}

function zeroUsage(): Usage {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
}

function addUsage(a: Usage, b: Usage): void {
  a.input_tokens += b.input_tokens;
  a.cache_creation_input_tokens += b.cache_creation_input_tokens;
  a.cache_read_input_tokens += b.cache_read_input_tokens;
  a.output_tokens += b.output_tokens;
}

function zeroSim(): GuardSim {
  return { hits: 0, tokens: 0, cost: 0 };
}

function addSim(a: GuardSim, b: GuardSim): void {
  a.hits += b.hits;
  a.tokens += b.tokens;
  a.cost += b.cost;
}
