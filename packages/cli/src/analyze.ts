import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  analyzeSession,
  DEFAULT_ANALYZE_OPTIONS,
  listTranscripts,
  loadConfig,
  parseTranscriptFile,
  simulateSession,
  STANDARD_POLICIES,
  transcriptDirFor,
  type AnalyzeOptions,
  type SessionAnalysis,
  type SimulationOptions,
} from '@tokentrim/core';
import type { AnalyzeArgs } from './args.js';
import { aggregate } from './report/aggregate.js';
import { Redactor, tok, pct } from './report/format.js';
import { renderHtml } from './report/html.js';
import { renderMarkdown, type ReportContext } from './report/markdown.js';

/** Median size of the 16 real compaction summaries seen while building this (10–27K). */
const COMPACT_SUMMARY_TOKENS = 18_000;

export interface Io {
  log: (s: string) => void;
  progress: (s: string) => void;
}

export async function runAnalyze(args: AnalyzeArgs, io: Io): Promise<number> {
  const projectDir = path.resolve(args.project ?? process.cwd());
  const { config, warnings } = await loadConfig({ projectDir });
  for (const w of warnings) io.progress(`config warning: ${w}`);

  const dir = args.transcriptsDir
    ? path.resolve(args.transcriptsDir)
    : transcriptDirFor(projectDir);
  let files = (await listTranscripts(dir)).map((f) => f.file);
  if (args.sessions.length) {
    files = args.sessions.map((s) =>
      existsSync(s) ? path.resolve(s) : path.join(dir, `${s.replace(/\.jsonl$/, '')}.jsonl`),
    );
    const missing = files.filter((f) => !existsSync(f));
    if (missing.length) {
      io.log(`Session not found: ${missing.join(', ')}`);
      return 1;
    }
  }
  if (files.length === 0) {
    io.log(
      `No transcripts found in ${dir}.\nRun this from a project folder you have used Claude Code in, or pass --project / --transcripts.`,
    );
    return 1;
  }

  const opts: AnalyzeOptions = {
    ...DEFAULT_ANALYZE_OPTIONS,
    ratios: {
      r_read: config.pricing.r_read,
      r_write: config.pricing.r_write,
      r_out: config.pricing.r_out,
    },
    cacheTtlMinutes: config.idle.cache_ttl_minutes,
    maxBreakevenTurns: config.advisor.max_breakeven_turns,
    keynotesTokens: config.checkpoint.max_tokens,
    largeFileLines: config.guards.large_file_lines,
    noisyExtra: config.guards.noisy_patterns_extra,
  };

  const simOpts: SimulationOptions = {
    ratios: opts.ratios,
    keynotesTokens: opts.keynotesTokens,
    summaryTokens: COMPACT_SUMMARY_TOKENS,
    minContext: config.idle.min_context,
  };

  let analyses: SessionAnalysis[] = [];
  for (const [i, file] of files.entries()) {
    io.progress(`[${i + 1}/${files.length}] ${path.basename(file)}`);
    try {
      const parsed = await parseTranscriptFile(file);
      const a = analyzeSession(parsed, opts);
      if (args.simulate)
        a.simulation = simulateSession(parsed, a.baseOverhead, STANDARD_POLICIES, simOpts, opts);
      if (a.requests > 0) analyses.push(a);
    } catch (e) {
      io.progress(`  skipped: ${(e as Error).message}`);
    }
  }
  analyses = analyses
    .filter((a) => args.since === undefined || a.end >= args.since)
    .filter((a) => args.until === undefined || a.start <= args.until)
    .filter((a) => !args.target || a.target.toLowerCase() === args.target.toLowerCase())
    .sort((x, y) => y.end - x.end);
  if (args.last) analyses = analyses.slice(0, args.last);
  if (analyses.length === 0) {
    io.log('No sessions matched the filters.');
    return 1;
  }

  const now = Date.now();
  const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const outDir = path.resolve(args.out ?? path.join(projectDir, '.tokentrim', 'reports', stamp));
  await mkdir(outDir, { recursive: true });
  const ctx: Omit<ReportContext, 'scope'> = {
    generatedAt: now,
    pricing: config.pricing,
    ttlMinutes: opts.cacheTtlMinutes,
    maxBreakevenTurns: opts.maxBreakevenTurns,
    keynotesTokens: opts.keynotesTokens,
    redact: new Redactor(args.redact),
  };

  const groups = new Map<string, SessionAnalysis[]>();
  if (args.byTarget)
    for (const a of analyses) groups.set(a.target, [...(groups.get(a.target) ?? []), a]);
  else
    groups.set(
      args.target ?? path.basename(args.transcriptsDir && !args.project ? dir : projectDir),
      analyses,
    );

  const index: string[] = [
    '# TokenTrim reports',
    '',
    '| Target | Sessions | Cost (ITE) | Report |',
    '|---|---:|---:|---|',
  ];
  for (const [name, list] of [...groups].sort((x, y) => sumCost(y[1]) - sumCost(x[1]))) {
    const agg = aggregate(list, opts.cacheTtlMinutes);
    const base = args.byTarget ? safeName(name) : 'report';
    const scope = args.redact ? `${list.length} session(s)` : name;
    await writeFile(path.join(outDir, `${base}.md`), renderMarkdown(agg, { ...ctx, scope }));
    if (args.html)
      await writeFile(path.join(outDir, `${base}.html`), renderHtml(agg, { ...ctx, scope }));
    if (args.json && !args.redact)
      await writeFile(path.join(outDir, `${base}.json`), JSON.stringify(agg, null, 1));
    index.push(
      `| ${args.redact ? '—' : name} | ${list.length} | ${tok(agg.cost.total)} | [${base}.md](${base}.md) |`,
    );
    io.log(
      `${name}: ${list.length} session(s), ${tok(agg.cost.total)} ITE, cache hit ${pct(agg.cacheHitRatio, 1)}, ` +
        `clear could save ≤${pct(agg.clearSaving, agg.cost.total)}, guards ≈${pct(agg.guardSim.duplicateRead.cost + agg.guardSim.largeFile.cost + agg.guardSim.noisyCommand.cost, agg.cost.total)}`,
    );
  }
  if (args.byTarget) await writeFile(path.join(outDir, 'index.md'), index.join('\n') + '\n');
  io.log(`\nReports written to ${outDir}`);
  return 0;
}

function sumCost(list: SessionAnalysis[]): number {
  return list.reduce((n, a) => n + a.cost.total, 0);
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
}
