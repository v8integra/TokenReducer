import { describe, expect, it } from 'vitest';
import {
  analyzeSession,
  DEFAULT_ANALYZE_OPTIONS,
  inferTargetProject,
  parseTranscriptText,
  toolCategory,
  weightedCost,
} from '../src/index.js';
import { lines, TranscriptBuilder } from './builder.js';

function analyze(b: TranscriptBuilder) {
  return analyzeSession(parseTranscriptText(b.text(), 'synthetic.jsonl'), DEFAULT_ANALYZE_OPTIONS);
}

describe('analyzeSession', () => {
  it('attributes exactly the recorded cost across categories', () => {
    const b = new TranscriptBuilder();
    b.prompt('build it');
    const [r] = b.request({
      grow: 0,
      text: 'reading',
      tools: [{ name: 'Read', input: { file_path: 'C:\\x.ts' } }],
    });
    b.toolResult(r!, lines(200));
    for (let i = 0; i < 5; i++) b.request({ grow: 3_000, text: 'working on it' });
    const a = analyze(b);
    const sum = a.categories.reduce((n, c) => n + c.cost, 0);
    expect(sum).toBeCloseTo(a.cost.total, 3);
    expect(a.categories.find((c) => c.category === 'tool: Read')!.cost).toBeGreaterThan(0);
    expect(a.baseOverhead).toBeGreaterThan(25_000);
    expect(a.requests).toBe(6);
    expect(a.humanPrompts).toBe(1);
  });

  it('computes cost and cache hit ratio from usage', () => {
    const b = new TranscriptBuilder(undefined, 10_000);
    b.request({ grow: 0, cacheWrite: 10_000, output: 100 });
    b.request({ grow: 0, cacheWrite: 0, output: 100 });
    const a = analyze(b);
    const expected = weightedCost(a.usage, DEFAULT_ANALYZE_OPTIONS.ratios);
    expect(a.cost.total).toBeCloseTo(expected.total);
    expect(a.cacheHitRatio).toBeCloseTo((10_000 - 3 - 3) / 20_000 / 1, 2);
  });

  it('flags duplicate reads only for unchanged content of the same range', () => {
    const b = new TranscriptBuilder();
    const read = (input: Record<string, unknown>, body: string) => {
      const [id] = b.request({ grow: 500, tools: [{ name: 'Read', input }] });
      b.toolResult(id!, body);
    };
    read({ file_path: 'C:\\p\\a.ts' }, lines(50));
    read({ file_path: 'c:/p/A.ts' }, lines(50)); // same file, same content → duplicate
    read({ file_path: 'C:\\p\\a.ts', offset: 1, limit: 10 }, lines(10)); // different range
    read({ file_path: 'C:\\p\\a.ts' }, lines(51)); // content changed
    b.request({ grow: 500 });
    const a = analyze(b);
    expect(a.guardSim.duplicateRead.hits).toBe(1);
    expect(a.repeatedReads[0]).toMatchObject({ reads: 4, duplicateReads: 1 });
  });

  it('does not count a re-read after compaction as a duplicate', () => {
    const b = new TranscriptBuilder();
    const [r1] = b.request({
      grow: 500,
      tools: [{ name: 'Read', input: { file_path: 'C:\\a.ts' } }],
    });
    b.toolResult(r1!, lines(50));
    b.request({ grow: 500 });
    b.compact(200_000, 30_000);
    const [r2] = b.request({
      grow: 0,
      tools: [{ name: 'Read', input: { file_path: 'C:\\a.ts' } }],
    });
    b.toolResult(r2!, lines(50));
    b.request({ grow: 500 });
    expect(analyze(b).guardSim.duplicateRead.hits).toBe(0);
  });

  it('simulates the large-file and noisy-command guards', () => {
    const b = new TranscriptBuilder();
    const [big] = b.request({
      grow: 100,
      tools: [{ name: 'Read', input: { file_path: 'C:\\big.ts' } }],
    });
    b.toolResult(big!, lines(1200));
    const [ranged] = b.request({
      grow: 100,
      tools: [{ name: 'Read', input: { file_path: 'C:\\big.ts', offset: 1, limit: 1200 } }],
    });
    b.toolResult(ranged!, lines(1200));
    const [noisy] = b.request({
      grow: 100,
      tools: [{ name: 'Bash', input: { command: 'npm install' } }],
    });
    b.toolResult(noisy!, 'added package\n'.repeat(1000));
    const [quiet] = b.request({
      grow: 100,
      tools: [{ name: 'Bash', input: { command: 'npm install' } }],
    });
    b.toolResult(quiet!, 'up to date');
    b.request({ grow: 100 });
    const a = analyze(b);
    expect(a.guardSim.largeFile.hits).toBe(1);
    expect(a.guardSim.noisyCommand.hits).toBe(1);
    expect(a.guardSim.noisyCommand.byPattern).toEqual({ 'install-verbose': 1 });
  });

  it('marks the first break-even point once per segment and estimates its saving', () => {
    const b = new TranscriptBuilder(undefined, 30_000);
    for (let i = 0; i < 60; i++) b.request({ grow: 4_000 });
    b.compact(270_000, 30_000);
    b.setContext(30_000);
    for (let i = 0; i < 10; i++) b.request({ grow: 1_000 });
    const a = analyze(b);
    expect(a.clearPoints).toHaveLength(1);
    const p = a.clearPoints[0]!;
    expect(p.breakevenTurns).toBeLessThanOrEqual(4);
    expect(p.requestIndex).toBeGreaterThan(0);
    expect(p.requestIndex).toBeLessThan(60);
    expect(p.requestsAfter).toBe(60 - p.requestIndex - 1);
    expect(p.saving).toBeGreaterThan(0);
    expect(a.curve).toHaveLength(70);
  });

  it('detects cache rebuilds and separates idle ones from mid-session breaks', () => {
    const b = new TranscriptBuilder(undefined, 50_000);
    b.request({ grow: 0, cacheWrite: 50_000 });
    b.wait(10);
    b.request({ grow: 1_000, cacheWrite: 51_000 }); // after idle gap
    b.request({ grow: 1_000, cacheWrite: 52_000 }); // no gap: something broke the cache
    b.request({ grow: 1_000 });
    const a = analyze(b);
    expect(a.cache.gapsOverTtl).toBe(1);
    expect(a.cache.rebuilds.map((r) => Math.round(r.gapMinutes))).toEqual([10, 0]);
    expect(a.cache.rebuildExcessCost).toBeCloseTo((51_000 + 52_000) * (1.25 - 0.1));
  });

  it('counts model switches and infers a 1M window from observed context', () => {
    const b = new TranscriptBuilder(undefined, 250_000);
    b.request({ model: 'claude-opus-5-5' });
    b.request({ model: 'claude-sonnet-5-5' });
    const a = analyze(b);
    expect(a.modelSwitches).toBe(1);
    expect(a.contextWindow).toBe(1_000_000);
  });

  it('groups MCP tools by server', () => {
    expect(toolCategory('mcp__Claude_Browser__navigate')).toBe('tool: mcp Claude_Browser');
    expect(toolCategory('mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__batch')).toBe(
      'tool: mcp connector',
    );
    expect(toolCategory('Bash')).toBe('tool: Bash');
  });
});

describe('inferTargetProject', () => {
  it('picks the sibling project most tool calls worked in', () => {
    const b = new TranscriptBuilder('C:\\Users\\dev\\Projects\\LocalAI');
    b.prompt('go');
    for (let i = 0; i < 4; i++)
      b.request({
        tools: [
          {
            name: 'Read',
            input: { file_path: `C:\\Users\\dev\\Projects\\FluxChunk\\src\\f${i}.ts` },
          },
        ],
      });
    b.request({
      tools: [
        { name: 'Bash', input: { command: 'cd /c/Users/dev/Projects/FluxChunk && npm test' } },
      ],
    });
    b.request({
      tools: [{ name: 'Read', input: { file_path: 'C:\\Users\\dev\\Projects\\Other\\x.md' } }],
    });
    expect(inferTargetProject(parseTranscriptText(b.text()))).toBe('FluxChunk');
  });

  it('falls back to the cwd name with too little evidence', () => {
    const b = new TranscriptBuilder('/home/dev/code/app');
    b.prompt('go');
    b.request({ tools: [{ name: 'Read', input: { file_path: '/home/dev/code/lib/x.ts' } }] });
    expect(inferTargetProject(parseTranscriptText(b.text()))).toBe('app');
  });
});
