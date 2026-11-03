import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { lines, TranscriptBuilder } from '../../core/test/builder.js';

// Contract tests run the real bundle the way Claude Code does: JSON on stdin, exit code and stdout checked.
let hookJs = '';
let cliJs = '';

beforeAll(async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'tt-bundle-'));
  await build({
    entryPoints: {
      hook: path.resolve(__dirname, '../src/hook-main.ts'),
      tokentrim: path.resolve(__dirname, '../../cli/src/main.ts'),
    },
    outdir: out,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    logLevel: 'silent',
  });
  hookJs = path.join(out, 'hook.js');
  cliJs = path.join(out, 'tokentrim.js');
}, 60_000);

interface Env {
  home: string;
  project: string;
  transcript: string;
}

async function env(): Promise<Env> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tt-hook-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  await mkdir(home);
  await mkdir(project);
  return { home, project, transcript: path.join(root, 'session.jsonl') };
}

function run(e: Env, event: string, input: unknown, extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [hookJs, event], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: {
      ...process.env,
      HOME: e.home,
      USERPROFILE: e.home,
      CLAUDE_PROJECT_DIR: e.project,
      TOKENTRIM_DISABLE: '',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const stateOf = async (e: Env, id: string) =>
  JSON.parse(await readFile(path.join(e.project, '.tokentrim', 'state', `${id}.json`), 'utf8'));

function transcript() {
  const b = new TranscriptBuilder(undefined, 30_000);
  b.prompt('go');
  for (let i = 0; i < 3; i++) {
    const [id] = b.request({
      grow: 5_000,
      tools: [{ name: 'Read', input: { file_path: `C:\\p\\${i}.ts` } }],
    });
    b.toolResult(id!, lines(50));
  }
  return b;
}

describe('stop hook', () => {
  it('writes live metrics, then picks up only new lines on the next stop', async () => {
    const e = await env();
    const b = transcript();
    await writeFile(e.transcript, b.text());
    const input = {
      session_id: 'abc',
      transcript_path: e.transcript,
      cwd: e.project,
      hook_event_name: 'Stop',
    };
    const r1 = run(e, 'stop', input);
    expect(r1).toMatchObject({ code: 0, stdout: '' });
    const s1 = await stateOf(e, 'abc');
    expect(s1.requests).toBe(3);
    expect(s1.context).toBe(45_000);

    const before = b.text().length;
    b.prompt('more');
    b.request({ grow: 1_000 });
    // Leave a half-written line at the end: it must wait for the next stop.
    await appendFile(e.transcript, b.text().slice(before) + '{"type":"assist');
    expect(run(e, 'stop', input).code).toBe(0);
    const s2 = await stateOf(e, 'abc');
    expect(s2.requests).toBe(4);
    expect(s2.context).toBe(46_000);
    expect(s2.offset).toBe(Buffer.byteLength(b.text()));
  });

  it('records the session source on SessionStart', async () => {
    const e = await env();
    expect(
      run(e, 'session-start', { session_id: 'abc', source: 'clear', cwd: e.project }).code,
    ).toBe(0);
    expect((await stateOf(e, 'abc')).source).toBe('clear');
  });
});

describe('fail-open', () => {
  it.each([
    ['invalid JSON on stdin', 'stop', '{ nope'],
    ['a JSON array', 'stop', '[1]'],
    [
      'a missing transcript',
      'stop',
      { session_id: 'abc', transcript_path: 'Z:/does/not/exist.jsonl' },
    ],
    ['no session id', 'stop', { transcript_path: 'x' }],
    ['an unknown event', 'pre-everything', { session_id: 'abc' }],
  ])('exits 0 with no output on %s', async (_name, event, input) => {
    const e = await env();
    const r = run(e, event, input);
    expect(r).toMatchObject({ code: 0, stdout: '' });
  });

  it('logs errors to ~/.tokentrim/logs', async () => {
    const e = await env();
    run(e, 'stop', '{ nope');
    const log = await readFile(path.join(e.home, '.tokentrim', 'logs', 'hooks.log'), 'utf8');
    expect(log).toContain('stop');
  });

  it('starts over from a corrupt state file', async () => {
    const e = await env();
    await writeFile(e.transcript, transcript().text());
    await mkdir(path.join(e.project, '.tokentrim', 'state'), { recursive: true });
    await writeFile(
      path.join(e.project, '.tokentrim', 'state', 'abc.json'),
      '{"version":1,"garbage"',
    );
    const r = run(e, 'stop', { session_id: 'abc', transcript_path: e.transcript });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect((await stateOf(e, 'abc')).requests).toBe(3);
  });

  it('survives an unreadable project config and uses defaults', async () => {
    const e = await env();
    await writeFile(e.transcript, transcript().text());
    await writeFile(path.join(e.project, 'tokentrim.config.json'), '{ broken');
    expect(run(e, 'stop', { session_id: 'abc', transcript_path: e.transcript }).code).toBe(0);
    expect((await stateOf(e, 'abc')).requests).toBe(3);
  });

  it('does nothing when disabled by env or when every metrics module is off', async () => {
    const e = await env();
    await writeFile(e.transcript, transcript().text());
    const input = { session_id: 'abc', transcript_path: e.transcript };
    run(e, 'stop', input, { TOKENTRIM_DISABLE: '1' });
    await writeFile(
      path.join(e.project, 'tokentrim.config.json'),
      JSON.stringify({ modules: { meter: false, checkpoint: false, advisor: false } }),
    );
    run(e, 'stop', input);
    await expect(readdir(path.join(e.project, '.tokentrim'))).rejects.toThrow();
  });
});

describe('tokentrim config (used by the /tokentrim:tokentrim skill)', () => {
  const cli = (e: Env, ...args: string[]) =>
    spawnSync(process.execPath, [cliJs, 'config', ...args, '--project', e.project], {
      encoding: 'utf8',
    });

  it('shows status, toggles a module, and rejects unknown modules', async () => {
    const e = await env();
    expect(cli(e).stdout).toMatch(/guards\s+on/);
    const off = cli(e, 'off', 'guards');
    expect(off.status).toBe(0);
    expect(off.stdout).toMatch(/guards\s+off/);
    expect(
      JSON.parse(await readFile(path.join(e.project, 'tokentrim.config.json'), 'utf8')),
    ).toEqual({
      modules: { guards: false },
    });
    expect(cli(e, 'on', 'warp').status).toBe(2);
  });
});

describe('keynotes across /clear and compaction', () => {
  function work() {
    const b = new TranscriptBuilder(undefined, 30_000);
    b.prompt('build the parser');
    const [w] = b.request({
      grow: 2_000,
      tools: [{ name: 'Write', input: { file_path: 'C:/x/parser.ts', content: 'x' } }],
    });
    b.toolResult(w!, 'ok');
    b.request({
      grow: 1_000,
      tools: [
        {
          name: 'mcp__ccd_turn__update_plan',
          input: { items: [{ content: 'Add parser tests', status: 'pending' }] },
        },
      ],
    });
    return b;
  }
  const kn = (e: Env, id: string) => path.join(e.project, '.tokentrim', 'keynotes', `${id}.md`);

  it('keeps Facts current, preserves the Summary, and restores both after /clear', async () => {
    const e = await env();
    const b = work();
    await writeFile(e.transcript, b.text());
    const a = { session_id: 'aaa', transcript_path: e.transcript, cwd: e.project };
    run(e, 'stop', a);
    let text = await readFile(kn(e, 'aaa'), 'utf8');
    expect(text).toContain('parser.ts (written)');
    expect(text).toContain('[ ] Add parser tests');

    // What /tokentrim:checkpoint has Claude do: edit only the Summary.
    text = text.replace(/_Not written yet[^\n]*/, '- Chose a recursive-descent parser');
    await writeFile(kn(e, 'aaa'), text);
    await appendFile(e.transcript, '');
    run(e, 'stop', a);
    expect(await readFile(kn(e, 'aaa'), 'utf8')).toContain('recursive-descent');

    // /clear: SessionEnd for the old session, then SessionStart for the new one.
    expect(run(e, 'session-end', { ...a, reason: 'clear' }).stdout).toBe('');
    const start = run(e, 'session-start', { session_id: 'bbb', source: 'clear', cwd: e.project });
    expect(start.code).toBe(0);
    const out = JSON.parse(start.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/^TokenTrim keynotes from the session before \/clear/);
    expect(ctx).toContain('parser.ts (written)');
    expect(ctx).toContain('recursive-descent');
    expect(ctx.length / 3.7).toBeLessThan(1500);
    // The Summary carries into the new session's own keynotes.
    expect(await readFile(kn(e, 'bbb'), 'utf8')).toContain('recursive-descent');

    // Injected once: a second clear start without a new SessionEnd gets nothing.
    expect(
      run(e, 'session-start', { session_id: 'ccc', source: 'clear', cwd: e.project }).stdout,
    ).toBe('');
  });

  it('re-injects a session’s own keynotes after compaction, but not on resume', async () => {
    const e = await env();
    await writeFile(e.transcript, work().text());
    const a = { session_id: 'aaa', transcript_path: e.transcript, cwd: e.project };
    run(e, 'pre-compact', { ...a, trigger: 'auto' });
    const c = run(e, 'session-start', { ...a, source: 'compact' });
    expect(JSON.parse(c.stdout).hookSpecificOutput.additionalContext).toMatch(/before compaction/);
    expect(run(e, 'session-start', { ...a, source: 'resume' }).stdout).toBe('');
    expect(run(e, 'session-start', { ...a, source: 'startup' }).stdout).toBe('');
  });

  it('injects on startup only with inject_on_startup', async () => {
    const e = await env();
    await writeFile(e.transcript, work().text());
    run(e, 'stop', { session_id: 'aaa', transcript_path: e.transcript, cwd: e.project });
    await writeFile(
      path.join(e.project, 'tokentrim.config.json'),
      JSON.stringify({ checkpoint: { inject_on_startup: true } }),
    );
    const r = run(e, 'session-start', { session_id: 'new', source: 'startup', cwd: e.project });
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(
      /last session in this project/,
    );
  });

  it('does nothing with the checkpoint module off, and ignores non-clear session ends', async () => {
    const e = await env();
    await writeFile(e.transcript, work().text());
    const a = { session_id: 'aaa', transcript_path: e.transcript, cwd: e.project };
    run(e, 'session-end', { ...a, reason: 'other' });
    expect(
      run(e, 'session-start', { session_id: 'bbb', source: 'clear', cwd: e.project }).stdout,
    ).toBe('');
    await writeFile(
      path.join(e.project, 'tokentrim.config.json'),
      '{"modules":{"checkpoint":false}}',
    );
    run(e, 'stop', a);
    await expect(readFile(kn(e, 'aaa'), 'utf8')).rejects.toThrow();
  });

  it('keynotes refresh (the checkpoint skill) prints the file to edit', async () => {
    const e = await env();
    await writeFile(e.transcript, work().text());
    run(e, 'stop', { session_id: 'aaa', transcript_path: e.transcript, cwd: e.project });
    const r = spawnSync(
      process.execPath,
      [cliJs, 'keynotes', 'refresh', '--session', 'aaa', '--project', e.project],
      {
        encoding: 'utf8',
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(kn(e, 'aaa'));
    expect(r.stdout).toMatch(/Size: ~\d+ tokens \(cap 1500\)/);
  });
});
