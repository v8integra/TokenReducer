import { toUsd, type PricingConfig } from '@tokentrim/core';
import type { Aggregate } from './aggregate.js';
import { cell, day, pct, Redactor, sparkline, tok, turns } from './format.js';

export interface ReportContext {
  scope: string;
  generatedAt: number;
  pricing: PricingConfig;
  ttlMinutes: number;
  maxBreakevenTurns: number;
  keynotesTokens: number;
  redact: Redactor;
}

export function renderMarkdown(a: Aggregate, ctx: ReportContext): string {
  const { redact: rd, pricing: p } = ctx;
  const total = a.cost.total;
  const usd = (ite: number) => {
    const d = toUsd(ite, p);
    return d == null ? '' : ` (≈ $${d.toFixed(2)})`;
  };
  const guardTotal =
    a.guardSim.duplicateRead.cost + a.guardSim.largeFile.cost + a.guardSim.noisyCommand.cost;
  const L: string[] = [];
  const line = (s = '') => L.push(s);
  const table = (head: string[], rows: (string | number)[][]) => {
    line(`| ${head.join(' | ')} |`);
    line(`|${head.map((h, i) => (i === 0 ? '---' : '---:')).join('|')}|`);
    for (const r of rows) line(`| ${r.map((c) => cell(String(c))).join(' | ')} |`);
    line();
  };

  line(`# TokenTrim analysis — ${cell(ctx.scope)}`);
  line();
  line(
    `${a.sessions.length} session(s), ${day(a.start)} → ${day(a.end)}. Generated ${new Date(ctx.generatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
  );
  line();
  line(
    `Costs are in **input-token equivalents (ITE)**: one uncached input token = 1, cache read = ${p.r_read}, cache write = ${p.r_write}, output = ${p.r_out}. They work for any model; set \`pricing.usd_per_mtok_input\` to also see dollars.`,
  );
  line();

  line('## Headline');
  line();
  table(
    ['Metric', 'Value'],
    [
      ['Total cost', `${tok(total)} ITE${usd(total)}`],
      [
        '…of which subagents',
        `${tok(a.sidechainCost.total)} ITE (${pct(a.sidechainCost.total, total)})`,
      ],
      ['API requests (main chain)', a.requests.toLocaleString('en-US')],
      ['Prompts you typed', a.humanPrompts.toLocaleString('en-US')],
      ['Cost per prompt', `${tok(a.humanPrompts ? total / a.humanPrompts : 0)} ITE`],
      ['Cache hit ratio (input side)', pct(a.cacheHitRatio, 1)],
      ['Compactions', a.compactions],
      [
        'Upper-bound saving from one well-timed clear per segment',
        `${tok(a.clearSaving)} ITE (${pct(a.clearSaving, total)})`,
      ],
      [
        'What the planned guards would have saved',
        `${tok(guardTotal)} ITE (${pct(guardTotal, total)})`,
      ],
    ],
  );

  line('## Where the cost comes from');
  line();
  line('By billing component:');
  line();
  table(
    ['Component', 'Tokens', 'Cost (ITE)', 'Share'],
    [
      [
        'Uncached input',
        tok(a.usage.input_tokens + a.sidechainUsage.input_tokens),
        tok(a.cost.input),
        pct(a.cost.input, total),
      ],
      [
        'Cache writes',
        tok(a.usage.cache_creation_input_tokens + a.sidechainUsage.cache_creation_input_tokens),
        tok(a.cost.cacheWrite),
        pct(a.cost.cacheWrite, total),
      ],
      [
        'Cache reads',
        tok(a.usage.cache_read_input_tokens + a.sidechainUsage.cache_read_input_tokens),
        tok(a.cost.cacheRead),
        pct(a.cost.cacheRead, total),
      ],
      [
        'Output',
        tok(a.usage.output_tokens + a.sidechainUsage.output_tokens),
        tok(a.cost.output),
        pct(a.cost.output, total),
      ],
    ],
  );
  line(
    'By what is sitting in context (main chain). Each request\'s input cost is split across the content it re-sent; item sizes are estimated from characters and reconciled to the real usage, with the remainder shown as "unattributed".',
  );
  line();
  table(
    ['Category', 'Cost (ITE)', 'Share', 'Avg tokens in context'],
    a.categories.map((c) => [
      c.category,
      tok(c.cost),
      pct(c.cost, total),
      c.category.startsWith('output') ? '—' : tok(a.requests ? c.tokensCarried / a.requests : 0),
    ]),
  );

  line('## Sessions');
  line();
  table(
    [
      'Session',
      'Target',
      'Dates',
      'Requests',
      'Peak context',
      'Cost (ITE)',
      'Cache hit',
      'Compactions',
      'Context over time',
    ],
    [...a.sessions]
      .sort((x, y) => y.cost.total - x.cost.total)
      .map((s) => [
        rd.title(s.title, s.sessionId),
        rd.on ? '—' : s.target,
        `${day(s.start)} → ${day(s.end)}`,
        s.requests,
        `${tok(s.peakContext)} / ${tok(s.contextWindow)}`,
        tok(s.cost.total),
        pct(s.cacheHitRatio, 1),
        s.compactions.length,
        '`' +
          sparkline(
            s.curve.map((c) => c.context),
            32,
            s.contextWindow,
          ) +
          '`',
      ]),
  );

  line('## Clear vs. continue');
  line();
  line(
    `Each request re-sends the whole context. Clearing costs a one-time rebuild (keynotes ≈ ${tok(ctx.keynotesTokens)} plus recently used files) and saves cache reads on every later request. The table lists, per session segment (between compactions), the **first** request where clearing would have paid for itself within ${ctx.maxBreakevenTurns} requests, and what one clear there would have saved by the end of that segment. It is an upper bound: it ignores whether that moment was a good task boundary.`,
  );
  line();
  const points = a.sessions.flatMap((s) => s.clearPoints.map((c) => ({ s, c })));
  if (points.length === 0) line('No point in these sessions reached the break-even threshold.');
  else
    table(
      [
        'Session',
        'At request',
        'Context',
        'Fresh start',
        'Pays off in',
        'Requests after',
        'Saving (ITE)',
      ],
      points
        .sort((x, y) => y.c.saving - x.c.saving)
        .slice(0, 20)
        .map(({ s, c }) => [
          rd.title(s.title, s.sessionId),
          `#${c.requestIndex} of ${s.requests}`,
          tok(c.context),
          tok(c.startContext),
          `${turns(c.breakevenTurns)} req`,
          c.requestsAfter,
          tok(c.saving),
        ]),
    );
  line();

  line('## Prompt cache');
  line();
  table(
    ['Metric', 'Value'],
    [
      [`Idle gaps over ${ctx.ttlMinutes} min between requests`, a.gapsOverTtl],
      ['Idle gaps over 60 min', a.gapsOverHour],
      ['Requests that re-wrote ≥ 50% of a ≥ 20K context', a.rebuilds],
      [
        `…of those after a gap under ${ctx.ttlMinutes} min (cache broken by something else)`,
        a.rebuildsShortGap,
      ],
      [
        'Extra cost of those rebuilds vs. cache reads',
        `${tok(a.rebuildExcessCost)} ITE (${pct(a.rebuildExcessCost, total)})`,
      ],
      ['Model switches mid-session', a.modelSwitches],
    ],
  );
  if (a.gapsOverTtl > 0 && a.rebuilds - a.rebuildsShortGap < a.gapsOverTtl / 2)
    line(
      `Most gaps over ${ctx.ttlMinutes} min did not cause a rebuild, so these sessions likely used a longer (1 hour) cache TTL. Set \`idle.cache_ttl_minutes\` to match.\n`,
    );

  line('## Biggest tool results');
  line();
  line(
    'Ranked by lifetime cost: the cache write when the result arrived plus a cache read on every later request that carried it.',
  );
  line();
  table(
    ['Tool', 'What', 'Tokens', 'Carried for', 'Lifetime cost (ITE)'],
    a.biggest.map((b) => [
      b.tool,
      rd.label(b.tool, b.label),
      tok(b.tokens),
      `${b.requestsCarried} req`,
      tok(b.cost),
    ]),
  );

  line('## Files read more than once');
  line();
  line(
    '"Duplicate" means the same range came back with identical content, in the same segment, so the earlier copy was still in context.',
  );
  line();
  if (a.repeatedReads.length === 0) line('None.\n');
  else
    table(
      ['File', 'Reads', 'Duplicates', 'Duplicate tokens', 'Duplicate cost (ITE)'],
      a.repeatedReads.map((r) => [
        rd.path(r.path),
        r.reads,
        r.duplicateReads,
        tok(r.duplicateTokens),
        tok(r.duplicateCost),
      ]),
    );

  line('## Tools by lifetime cost');
  line();
  table(
    ['Tool', 'Calls', 'Result tokens', 'Lifetime cost (ITE)', 'Share'],
    a.toolStats
      .slice(0, 15)
      .map((t) => [t.tool, t.calls, tok(t.resultTokens), tok(t.cost), pct(t.cost, total)]),
  );

  line('## What the planned guards would have caught');
  line();
  line(
    'Simulated on these transcripts with the default thresholds. Guards are not active yet (Phase 3).',
  );
  line();
  const g = a.guardSim;
  table(
    ['Guard', 'Hits', 'Tokens avoided', 'Cost avoided (ITE)', 'Share'],
    [
      [
        'Duplicate read',
        g.duplicateRead.hits,
        tok(g.duplicateRead.tokens),
        tok(g.duplicateRead.cost),
        pct(g.duplicateRead.cost, total),
      ],
      [
        'Large file read without a range',
        g.largeFile.hits,
        tok(g.largeFile.tokens),
        tok(g.largeFile.cost),
        pct(g.largeFile.cost, total),
      ],
      [
        'Noisy command',
        g.noisyCommand.hits,
        tok(g.noisyCommand.tokens),
        tok(g.noisyCommand.cost),
        pct(g.noisyCommand.cost, total),
      ],
    ],
  );
  const patterns = Object.entries(g.byPattern);
  if (patterns.length)
    line(`Noisy commands by pattern: ${patterns.map(([k, v]) => `${k} ×${v}`).join(', ')}.\n`);

  if (a.simulation.length) renderSimulation(a, line, table);

  line('## Notes');
  line();
  line(`- Malformed transcript lines skipped: ${a.malformedLines}.`);
  line(
    '- Token sizes of individual items are estimates (≈3.7 characters per token); request totals come straight from the recorded usage.',
  );
  line(
    '- File contents never appear in this report. ' +
      (rd.on
        ? 'Paths and commands are hashed (--redact).'
        : 'Use --redact to hash paths and commands.'),
  );
  line();
  return L.join('\n');
}

function renderSimulation(
  a: Aggregate,
  line: (s?: string) => void,
  table: (head: string[], rows: (string | number)[][]) => void,
): void {
  line('## Policy simulation');
  line();
  line(
    'Each session replayed under a context policy: the same work, but the context restarts small after a clear or compaction and grows the same way afterwards. Actions only happen between turns. Optimistic about lost context (only recent files are assumed re-read); pessimistic about compaction (simulated ones are charged, avoided real ones are not credited).',
  );
  line();
  const actual = a.simulation[0]?.actualCost ?? 0;
  table(
    [
      'Policy',
      'Cost (ITE)',
      'Saving',
      'Clears',
      'Compacts',
      'Idle clears',
      'Actions per 100 prompts',
      'Avg context',
    ],
    a.simulation.map((r) => [
      r.policy,
      tok(r.cost),
      pct(actual - r.cost, actual),
      r.clears,
      r.compacts,
      r.idleClears,
      a.humanPrompts
        ? ((100 * (r.clears + r.compacts + r.idleClears)) / a.humanPrompts).toFixed(0)
        : '—',
      tok(r.avgContext),
    ]),
  );
}
