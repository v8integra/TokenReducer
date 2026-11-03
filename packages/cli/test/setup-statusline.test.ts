import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { statuslineBinPath, statuslineChainPath } from '@tokentrim/core';
import { meterCommand, parseSetupArgs, runSetupStatusline } from '../src/setup-statusline.js';

async function env(settings?: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tt-setup-'));
  const home = path.join(root, 'home');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  const source = path.join(root, 'statusline.js');
  await writeFile(source, '// meter v1');
  const file = path.join(home, '.claude', 'settings.json');
  if (settings !== undefined)
    await writeFile(file, typeof settings === 'string' ? settings : JSON.stringify(settings));
  return { home, source, file };
}

async function setup(e: Awaited<ReturnType<typeof env>>, ...args: string[]) {
  const o = parseSetupArgs(['--settings', e.file, ...args], e.home);
  if (typeof o === 'string') throw new Error(o);
  o.source = e.source;
  const logs: string[] = [];
  const code = await runSetupStatusline(o, { log: (s) => logs.push(s), progress: () => {} });
  return { code, out: logs.join('\n') };
}

const read = async (f: string) => JSON.parse(await readFile(f, 'utf8'));
const backups = async (f: string) =>
  (await readdir(path.dirname(f))).filter((n) => n.includes('tokentrim-backup'));

describe('setup-statusline', () => {
  it('writes the meter, keeps other settings, and backs up first', async () => {
    const e = await env({ model: 'opus', permissions: { allow: ['Bash(ls)'] } });
    const r = await setup(e, '--yes');
    expect(r.code).toBe(0);
    const s = await read(e.file);
    expect(s.model).toBe('opus');
    expect(s.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(s.statusLine).toEqual({ type: 'command', command: meterCommand(e.home) });
    expect(s.statusLine.command).not.toContain('\\');
    expect(await readFile(statuslineBinPath(e.home), 'utf8')).toBe('// meter v1');
    expect(await backups(e.file)).toHaveLength(1);
  });

  it('chains an existing status line and restores it on --remove', async () => {
    const prev = { type: 'command', command: '~/.claude/mine.sh', padding: 2 };
    const e = await env({ statusLine: prev });
    expect((await setup(e, '--yes')).out).toContain('keeps running');
    expect((await read(e.file)).statusLine).toEqual({
      type: 'command',
      command: meterCommand(e.home),
      padding: 2,
    });
    expect((await read(statuslineChainPath(e.home))).previous).toEqual(prev);

    const r = await setup(e, '--remove', '--yes');
    expect(r.code).toBe(0);
    expect((await read(e.file)).statusLine).toEqual(prev);
    expect(existsSync(statuslineChainPath(e.home))).toBe(false);
  });

  it('removes the setting entirely when there was none before', async () => {
    const e = await env({});
    await setup(e, '--yes');
    await setup(e, '--remove', '--yes');
    expect(await read(e.file)).toEqual({});
  });

  it('is idempotent: a second run only refreshes the script', async () => {
    const e = await env({ statusLine: { type: 'command', command: 'mine' } });
    await setup(e, '--yes');
    await writeFile(e.source, '// meter v2');
    const r = await setup(e, '--yes');
    expect(r.out).toContain('already in your status line');
    expect(await readFile(statuslineBinPath(e.home), 'utf8')).toBe('// meter v2');
    expect((await read(statuslineChainPath(e.home))).previous.command).toBe('mine');
  });

  it('changes nothing on --dry-run or without consent', async () => {
    const e = await env({ statusLine: { type: 'command', command: 'mine' } });
    expect((await setup(e, '--dry-run')).out).toContain('Dry run: nothing changed.');
    const denied = parseSetupArgs(['--settings', e.file], e.home);
    if (typeof denied === 'string') throw new Error(denied);
    denied.source = e.source;
    denied.confirm = async () => false;
    expect(await runSetupStatusline(denied, { log: () => {}, progress: () => {} })).toBe(1);
    expect((await read(e.file)).statusLine.command).toBe('mine');
    expect(existsSync(statuslineBinPath(e.home))).toBe(false);
    expect(await backups(e.file)).toHaveLength(0);
  });

  it('creates settings.json when missing and refuses one it cannot parse', async () => {
    const fresh = await env();
    expect((await setup(fresh, '--yes')).code).toBe(0);
    expect((await read(fresh.file)).statusLine.command).toBe(meterCommand(fresh.home));

    const bad = await env('{ "statusLine": ');
    const r = await setup(bad, '--yes');
    expect(r.code).toBe(1);
    expect(r.out).toContain('left alone');
    expect(await readFile(bad.file, 'utf8')).toBe('{ "statusLine": ');
  });
});
