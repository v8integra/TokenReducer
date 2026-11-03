import { describe, expect, it } from 'vitest';
import {
  analyzeSession,
  DEFAULT_ANALYZE_OPTIONS,
  detectTurns,
  parseTranscriptText,
  simulateSession,
  STANDARD_POLICIES,
  type Policy,
  type SimulationOptions,
} from '../src/index.js';
import { TranscriptBuilder } from './builder.js';

const simOpts: SimulationOptions = {
  ratios: DEFAULT_ANALYZE_OPTIONS.ratios,
  keynotesTokens: 1500,
  summaryTokens: 18_000,
  minContext: 40_000,
};

function run(b: TranscriptBuilder, policies: Policy[]) {
  const s = parseTranscriptText(b.text());
  const a = analyzeSession(s, DEFAULT_ANALYZE_OPTIONS);
  return {
    a,
    results: simulateSession(s, a.baseOverhead, policies, simOpts, DEFAULT_ANALYZE_OPTIONS),
  };
}

describe('detectTurns', () => {
  it('splits on typed prompts and tags boundary signals', () => {
    const b = new TranscriptBuilder();
    b.prompt('fix the parser');
    const [t1] = b.request({ tools: [{ name: 'Bash', input: { command: 'npm test' } }] });
    b.toolResult(t1!, 'FAIL', true);
    const [t2] = b.request({ tools: [{ name: 'Bash', input: { command: 'npm test' } }] });
    b.toolResult(t2!, 'ok');
    b.request({
      tools: [
        {
          name: 'mcp__ccd_turn__update_plan',
          input: { items: [{ content: 'a', status: 'completed' }] },
        },
      ],
    });
    b.prompt('thanks! now commit it');
    const [c] = b.request({ tools: [{ name: 'Bash', input: { command: 'git commit -m x' } }] });
    b.toolResult(c!, '1 file changed');
    b.request({ tools: [{ name: 'mcp__ccd_turn__wrap_up', input: { recap: 'done' } }] });
    b.prompt('next thing');
    b.request({
      tools: [
        { name: 'TaskCreate', input: { tasks: '[{"status":"completed"},{"status":"pending"}]' } },
      ],
    });

    const turns = detectTurns(parseTranscriptText(b.text()));
    expect(turns.map((t) => [t.startRequest, t.endRequest])).toEqual([
      [0, 2],
      [3, 4],
      [5, 5],
    ]);
    expect([...turns[0]!.signals].sort()).toEqual(['tests-green', 'todos-done']);
    expect([...turns[1]!.signals].sort()).toEqual(['commit', 'turn-complete', 'wrap-up']);
    expect(turns[2]!.signals.size).toBe(0);
  });

  it('tracks TaskUpdate statuses until every task is completed', () => {
    const b = new TranscriptBuilder();
    b.prompt('go');
    b.request({
      tools: [
        { name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
        { name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } },
      ],
    });
    b.prompt('more');
    b.request({ tools: [{ name: 'TaskUpdate', input: { taskId: '2', status: 'completed' } }] });
    const turns = detectTurns(parseTranscriptText(b.text()));
    expect(turns[0]!.signals.has('todos-done')).toBe(false);
    expect(turns[1]!.signals.has('todos-done')).toBe(true);
  });

  it('does not count a failed commit', () => {
    const b = new TranscriptBuilder();
    b.prompt('commit');
    const [c] = b.request({ tools: [{ name: 'Bash', input: { command: 'git commit -m x' } }] });
    b.toolResult(c!, 'nothing to commit', true);
    expect(detectTurns(parseTranscriptText(b.text()))[0]!.signals.size).toBe(0);
  });
});

/** Ten turns of ten requests each, growing 6K per request, each ending with a commit. */
function longSession(opts: { idleBefore?: number } = {}) {
  const b = new TranscriptBuilder(undefined, 30_000);
  for (let turn = 0; turn < 10; turn++) {
    if (opts.idleBefore === turn) b.wait(90);
    b.prompt(`task ${turn}`);
    for (let i = 0; i < 9; i++) {
      const rebuild = opts.idleBefore === turn && i === 0;
      b.request({ grow: 6_000, cacheWrite: rebuild ? 999_999 : undefined });
    }
    const [c] = b.request({
      grow: 6_000,
      tools: [{ name: 'Bash', input: { command: 'git commit -m done' } }],
    });
    b.toolResult(c!, 'ok');
  }
  return b;
}

describe('simulateSession', () => {
  it('reproduces the actual cost with no policy', () => {
    const { a, results } = run(longSession(), [STANDARD_POLICIES[0]!]);
    expect(results[0]!.cost).toBeCloseTo(results[0]!.actualCost, 3);
    expect(results[0]!.actualCost).toBeCloseTo(a.cost.total, 3);
    expect(results[0]!.clears + results[0]!.compacts).toBe(0);
  });

  it('clears at boundaries once it pays off, re-arming after each clear', () => {
    const { results } = run(longSession(), [
      { name: 'b', boundary: 'strong', maxBreakevenTurns: 4 },
    ]);
    const r = results[0]!;
    expect(r.clears).toBeGreaterThan(1);
    expect(r.cost).toBeLessThan(r.actualCost);
    expect(r.avgContext).toBeLessThan(330_000);
  });

  it('never clears where the break-even is too long', () => {
    const { results } = run(longSession(), [
      { name: 'b', boundary: 'strong', maxBreakevenTurns: 0.01 },
    ]);
    expect(results[0]!.clears).toBe(0);
  });

  it('compacts at turn ends once over budget and keeps the context near the budget', () => {
    const { results } = run(longSession(), [{ name: 'c', budget: 150_000, maxBreakevenTurns: 0 }]);
    const r = results[0]!;
    expect(r.compacts).toBeGreaterThan(2);
    expect(r.avgContext).toBeLessThan(150_000);
  });

  it('clears after an idle gap that expired the cache', () => {
    const { results } = run(longSession({ idleBefore: 6 }), [
      { name: 'i', idle: true, maxBreakevenTurns: 0 },
    ]);
    expect(results[0]!.idleClears).toBe(1);
    expect(results[0]!.cost).toBeLessThan(results[0]!.actualCost);
  });
});
