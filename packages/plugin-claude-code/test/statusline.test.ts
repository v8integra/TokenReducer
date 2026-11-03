import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { newLiveState, statuslineChainPath } from '@tokentrim/core';
import { meterInput } from '../src/statusline.js';

let script = '';

beforeAll(async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'tt-sl-bundle-'));
  await build({
    entryPoints: { statusline: path.resolve(__dirname, '../src/statusline-main.ts') },
    outdir: out,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    logLevel: 'silent',
  });
  script = path.join(out, 'statusline.js');
}, 60_000);

const sample = (project: string) => ({
  session_id: 'abc',
  workspace: { current_dir: project, project_dir: project },
  cost: { total_cost_usd: 1.5 },
  context_window: {
    context_window_size: 1_000_000,
    current_usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 60_000,
    },
  },
  prompt_cache: { warm: true, expires_at: Math.floor(Date.now() / 1000) + 50 * 60 },
});

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tt-sl-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  await mkdir(home);
  await mkdir(path.join(project, '.tokentrim', 'state'), { recursive: true });
  return { home, project };
}

function run(home: string, input: string, env: Record<string, string> = {}) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [script], {
    input,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NO_COLOR: '1',
      TOKENTRIM_DISABLE: '',
      ...env,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { code: r.status, out: r.stdout, ms: Date.now() - t };
}

describe('meterInput', () => {
  it('maps Claude Code status line JSON', () => {
    const m = meterInput(sample('/p'), 0);
    expect(m).toMatchObject({
      context: 62_010,
      window: 1_000_000,
      usd: 1.5,
      cache: { warm: true },
    });
  });

  it('tolerates missing fields', () => {
    expect(meterInput({}, 0)).toEqual({
      context: 0,
      window: 200_000,
      usd: undefined,
      cache: undefined,
      now: 0,
    });
  });
});

describe('statusline script', () => {
  it('prints the meter from stdin plus the session state', async () => {
    const { home, project } = await setup();
    const s = { ...newLiveState('abc'), baseOverhead: 30_000, requests: 5 };
    await writeFile(path.join(project, '.tokentrim', 'state', 'abc.json'), JSON.stringify(s));
    const r = run(home, JSON.stringify(sample(project)));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /^62K ctx · next req ≈6K · clear pays off in \d+ req · cache (49|50)m · \$1\.50\n$/,
    );
  });

  it('runs the previous status line first and puts the meter under it', async () => {
    const { home, project } = await setup();
    const chain = statuslineChainPath(home);
    await mkdir(path.dirname(chain), { recursive: true });
    const prev = `"${process.execPath.replace(/\\/g, '/')}" -e "process.stdin.on('data',()=>{});process.stdin.on('end',()=>console.log('previous line'))"`;
    await writeFile(
      chain,
      JSON.stringify({ previous: { type: 'command', command: prev }, installedAt: 'x' }),
    );
    const r = run(home, JSON.stringify(sample(project)));
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe('previous line');
    expect(lines[1]).toMatch(/^62K ctx/);
  });

  it('prints only the chained line when the meter is off or input is garbage', async () => {
    const { home, project } = await setup();
    expect(run(home, '{ nope').out).toBe('\n');
    await writeFile(path.join(project, 'tokentrim.config.json'), '{"modules":{"meter":false}}');
    expect(run(home, JSON.stringify(sample(project))).out).toBe('\n');
    expect(run(home, JSON.stringify(sample(project)), { TOKENTRIM_DISABLE: '1' }).code).toBe(0);
  });

  it('never chains to itself', async () => {
    const { home, project } = await setup();
    const chain = statuslineChainPath(home);
    await mkdir(path.dirname(chain), { recursive: true });
    await writeFile(
      chain,
      JSON.stringify({
        previous: { command: 'node "/h/.tokentrim/bin/statusline.js"' },
        installedAt: 'x',
      }),
    );
    const r = run(home, JSON.stringify(sample(project)));
    expect(r.out.trimEnd().split('\n')).toHaveLength(1);
  });
});
