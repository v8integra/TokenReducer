import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeSession,
  isLiveState,
  newLiveState,
  parseTranscriptText,
  setModule,
  updateLive,
} from '../src/index.js';
import { lines, TranscriptBuilder } from './builder.js';

function session() {
  const b = new TranscriptBuilder(undefined, 30_000);
  b.prompt('build the parser');
  for (let i = 0; i < 6; i++) {
    const [id] = b.request({
      grow: 4_000,
      text: 'step',
      tools: [{ name: 'Read', input: { file_path: `C:\\p\\f${i}.ts` } }],
    });
    b.toolResult(id!, lines(100));
  }
  b.prompt('thanks, commit it');
  const [c] = b.request({
    grow: 2_000,
    tools: [{ name: 'Bash', input: { command: 'git commit -m parser' } }],
  });
  b.toolResult(c!, 'ok');
  return b;
}

describe('updateLive', () => {
  it('matches the full analyzer when fed in chunks, including a message split across chunks', () => {
    const text = session().text();
    const all = text.split('\n').filter(Boolean);
    const full = analyzeSession(parseTranscriptText(text));
    // Cut inside the first request's split entries and again mid-session.
    const cuts = [all.findIndex((l) => l.includes('"type":"text"')), Math.floor(all.length / 2)];
    const state = newLiveState('s1');
    let from = 0;
    for (const cut of [...cuts, all.length]) {
      updateLive(state, all.slice(from, cut).join('\n') + '\n');
      from = cut;
    }
    expect(state.requests).toBe(full.requests);
    expect(state.cost.total).toBeCloseTo(full.cost.total, 3);
    expect(state.context).toBe(full.peakContext);
    expect(state.baseOverhead).toBe(full.baseOverhead);
    expect(state.lastTurnSignals.sort()).toEqual(['commit', 'wrap-up']);
    expect(state.breakeven?.S).toBeGreaterThan(state.baseOverhead!);
    expect(isLiveState(JSON.parse(JSON.stringify(state)))).toBe(true);
  });

  it('carries test state between chunks so red → green is seen', () => {
    const b = new TranscriptBuilder();
    b.prompt('fix');
    const [r] = b.request({ grow: 10, tools: [{ name: 'Bash', input: { command: 'npm test' } }] });
    b.toolResult(r!, 'FAIL', true);
    const first = b.text();
    b.prompt('try again');
    const [g] = b.request({ grow: 10, tools: [{ name: 'Bash', input: { command: 'npm test' } }] });
    b.toolResult(g!, 'ok');
    const second = b.text().slice(first.length);
    const state = newLiveState('s2');
    updateLive(state, first);
    expect(state.lastTurnSignals).toEqual([]);
    updateLive(state, second);
    expect(state.lastTurnSignals).toEqual(['tests-green']);
  });

  it('forgets recently read files after a compaction', () => {
    const b = session();
    b.compact(300_000, 20_000);
    b.setContext(40_000);
    b.request({ grow: 0 });
    const state = updateLive(newLiveState('s3'), b.text());
    expect(state.compactions).toBe(1);
    expect(state.touches).toEqual([]);
  });

  it('rejects state that does not look like ours', () => {
    expect(isLiveState(null)).toBe(false);
    expect(isLiveState({ version: 2 })).toBe(false);
    expect(isLiveState({ ...newLiveState('x'), touches: 'nope' })).toBe(false);
  });
});

describe('setModule', () => {
  it('creates the project config, then keeps other keys when toggling', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tt-set-'));
    const file = await setModule(dir, 'guards', false);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ modules: { guards: false } });
    await writeFile(file, JSON.stringify({ idle: { min_context: 1 }, modules: { guards: false } }));
    await setModule(dir, 'meter', false);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      idle: { min_context: 1 },
      modules: { guards: false, meter: false },
    });
  });

  it('never overwrites a config it cannot parse', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tt-bad-'));
    await writeFile(path.join(dir, 'tokentrim.config.json'), '{ broken');
    await expect(setModule(dir, 'meter', false)).rejects.toThrow(/left alone/);
    expect(await readFile(path.join(dir, 'tokentrim.config.json'), 'utf8')).toBe('{ broken');
  });
});
