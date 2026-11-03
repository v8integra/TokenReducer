import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeSession,
  DEFAULT_ANALYZE_OPTIONS,
  defaultConfig,
  parseTranscriptText,
} from '@tokentrim/core';
import { lines, TranscriptBuilder } from '../../core/test/builder.js';
import { runAnalyze } from '../src/analyze.js';
import { ArgError, parseAnalyzeArgs } from '../src/args.js';
import { aggregate } from '../src/report/aggregate.js';
import { Redactor, sparkline, tok } from '../src/report/format.js';
import { mdToHtml, renderHtml } from '../src/report/html.js';
import { renderMarkdown, type ReportContext } from '../src/report/markdown.js';

function sampleSession(cwd = 'C:\\Users\\dev\\Projects\\LocalAI') {
  const b = new TranscriptBuilder(cwd, 30_000);
  b.prompt('add a parser');
  for (let i = 0; i < 3; i++) {
    const [id] = b.request({
      grow: 2_000,
      text: 'reading',
      tools: [
        {
          name: 'Read',
          input: { file_path: 'C:\\Users\\dev\\Projects\\FluxChunk\\src\\parser.ts' },
        },
      ],
    });
    b.toolResult(id!, lines(900));
  }
  const [cmd] = b.request({
    grow: 2_000,
    tools: [
      { name: 'Bash', input: { command: 'cd /c/Users/dev/Projects/FluxChunk && npm install' } },
    ],
  });
  b.toolResult(cmd!, 'added 1 package\n'.repeat(800));
  for (let i = 0; i < 40; i++) b.request({ grow: 5_000, text: 'step' });
  b.compact(250_000, 30_000);
  b.setContext(30_000);
  for (let i = 0; i < 5; i++) b.request({ grow: 1_000 });
  return b;
}

const ctx = (redact = false): ReportContext => ({
  scope: 'golden',
  generatedAt: Date.parse('2026-11-01T12:00:00Z'),
  pricing: defaultConfig().pricing,
  ttlMinutes: 5,
  maxBreakevenTurns: 4,
  keynotesTokens: 1500,
  redact: new Redactor(redact),
});

describe('args', () => {
  it('parses every option', () => {
    const a = parseAnalyzeArgs([
      '--project',
      'p',
      '--session',
      'a',
      '--session',
      'b',
      '--last',
      '3',
      '--since',
      '2026-10-01',
      '--target',
      'X',
      '--html',
      '--json',
      '--redact',
      '--by-target',
    ]);
    expect(a).toMatchObject({
      project: 'p',
      sessions: ['a', 'b'],
      last: 3,
      target: 'X',
      html: true,
      json: true,
      redact: true,
      byTarget: true,
    });
    expect(a.since).toBe(Date.parse('2026-10-01T00:00:00'));
  });

  it('rejects bad input', () => {
    expect(() => parseAnalyzeArgs(['--last', '0'])).toThrow(ArgError);
    expect(() => parseAnalyzeArgs(['--since', 'yesterday'])).toThrow(ArgError);
    expect(() => parseAnalyzeArgs(['--project'])).toThrow(ArgError);
    expect(() => parseAnalyzeArgs(['--wat'])).toThrow(ArgError);
  });
});

describe('report', () => {
  const analysis = analyzeSession(
    parseTranscriptText(sampleSession().text(), 'C:\\t\\golden.jsonl'),
    DEFAULT_ANALYZE_OPTIONS,
  );

  it('renders a stable Markdown report (golden)', () => {
    expect(renderMarkdown(aggregate([analysis], 5), ctx())).toMatchSnapshot();
  });

  it('redacts paths, commands and titles', () => {
    const md = renderMarkdown(aggregate([analysis], 5), ctx(true));
    expect(md).not.toContain('parser.ts');
    expect(md).not.toContain('npm install');
    expect(md).not.toContain('Synthetic session');
    expect(md).toMatch(/file#[0-9a-f]{10}\.ts/);
  });

  it('renders self-contained HTML with one panel per session', () => {
    const html = renderHtml(aggregate([analysis], 5), ctx());
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/);
    expect(html.match(/class="panel"/g)).toHaveLength(1);
    expect(html).toContain('prefers-color-scheme:dark');
  });

  it('converts tables, lists and inline code, escaping HTML', () => {
    const html = mdToHtml('## T\n\n| a | b |\n|---|---:|\n| `x` | 1 \\| 2 |\n\n- **bold** <b>\n');
    expect(html).toContain('<h3>T</h3>');
    expect(html).toContain('<td><code>x</code></td><td class="num">1 | 2</td>');
    expect(html).toContain('<li><strong>bold</strong> &#60;b&#62;</li>');
  });

  it('formats numbers compactly', () => {
    expect([tok(950), tok(12_345), tok(2_500_000), tok(3.4e9), tok(Infinity)]).toEqual([
      '950',
      '12.3K',
      '2.5M',
      '3.40B',
      '∞',
    ]);
    expect(sparkline([0, 50, 100], 3, 100)).toBe('▁▅█');
  });
});

describe('runAnalyze', () => {
  it('reads a transcript folder, groups by target and writes reports', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tt-cli-'));
    const out = path.join(dir, 'out');
    await writeFile(path.join(dir, 's1.jsonl'), sampleSession().text());
    await writeFile(path.join(dir, 's2.jsonl'), '{ corrupt\n');
    const logs: string[] = [];
    const code = await runAnalyze(
      {
        ...parseAnalyzeArgs([
          '--transcripts',
          dir,
          '--out',
          out,
          '--html',
          '--json',
          '--by-target',
        ]),
        project: dir,
      },
      { log: (s) => logs.push(s), progress: () => {} },
    );
    expect(code).toBe(0);
    expect((await readdir(out)).sort()).toEqual([
      'FluxChunk.html',
      'FluxChunk.json',
      'FluxChunk.md',
      'index.md',
    ]);
    expect(await readFile(path.join(out, 'index.md'), 'utf8')).toContain('| FluxChunk | 1 |');
    expect(logs[0]).toMatch(/^FluxChunk: 1 session/);
  });

  it('explains when nothing is found', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tt-empty-'));
    const logs: string[] = [];
    const code = await runAnalyze(
      { ...parseAnalyzeArgs(['--transcripts', dir]), project: dir },
      { log: (s) => logs.push(s), progress: () => {} },
    );
    expect(code).toBe(1);
    expect(logs[0]).toContain('No transcripts found');
  });
});
