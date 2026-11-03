import { describe, expect, it } from 'vitest';
import {
  buildKeynotes,
  CHARS_PER_TOKEN,
  extractSummary,
  newFacts,
  parseTranscriptText,
  renderFacts,
  SUMMARY_END,
  SUMMARY_START,
  updateFacts,
} from '../src/index.js';
import { TranscriptBuilder } from './builder.js';

const P = 'C:\\Users\\dev\\Projects\\App';

function work() {
  const b = new TranscriptBuilder(P);
  b.prompt('add the parser');
  const [w] = b.request({
    tools: [{ name: 'Write', input: { file_path: `${P}\\src\\parser.ts`, content: 'x' } }],
  });
  b.toolResult(w!, 'ok');
  for (let i = 0; i < 2; i++) {
    const [e] = b.request({
      tools: [{ name: 'Edit', input: { file_path: `${P}\\src\\index.ts` } }],
    });
    b.toolResult(e!, 'ok');
  }
  const [t1] = b.request({ tools: [{ name: 'Bash', input: { command: `cd ${P} && npm test` } }] });
  b.toolResult(t1!, 'FAIL src/parser.test.ts\n  expected 2 got 3', true);
  const [ls] = b.request({ tools: [{ name: 'Bash', input: { command: 'ls -la' } }] });
  b.toolResult(ls!, 'files');
  const [b1] = b.request({ tools: [{ name: 'Bash', input: { command: 'npm run build' } }] });
  b.toolResult(b1!, 'error TS2304: Cannot find name', true);
  const [b2] = b.request({ tools: [{ name: 'Bash', input: { command: 'npm run build' } }] });
  b.toolResult(b2!, 'built');
  b.request({
    tools: [
      {
        name: 'mcp__ccd_turn__update_plan',
        input: {
          items: [
            { content: 'Write parser', status: 'completed' },
            { content: 'Fix test', status: 'in_progress' },
          ],
        },
      },
    ],
  });
  b.prompt('also handle empty input');
  return b;
}

describe('updateFacts', () => {
  const f = updateFacts(newFacts(), parseTranscriptText(work().text()));

  it('records changed files, notable commands, open errors, to-dos and requests', () => {
    expect(f.files[`${P}\\src\\parser.ts`]).toMatchObject({ writes: 1, edits: 0 });
    expect(f.files[`${P}\\src\\index.ts`]).toMatchObject({ writes: 0, edits: 2 });
    expect(f.commands).toEqual([
      { cmd: 'npm test', ok: false },
      { cmd: 'npm run build', ok: true },
    ]);
    // The build failure was fixed by the later build; the test failure is still open.
    expect(f.errors.map((e) => e.what)).toEqual(['npm test']);
    expect(f.errors[0]!.preview).toContain('expected 2 got 3');
    expect(f.todos?.map((t) => t.status)).toEqual(['completed', 'in_progress']);
    expect(f.requests).toEqual(['add the parser', 'also handle empty input']);
  });

  it('renders paths relative to the project, unfinished to-dos first', () => {
    const md = renderFacts(f, P);
    expect(md).toContain('src/parser.ts (written)');
    expect(md).toContain('src/index.ts (2 edits)');
    expect(md).toContain('✗ `npm test` · ✓ `npm run build`');
    expect(md).toContain('- To-dos: [~] Fix test · [x] Write parser');
    expect(md).not.toContain('ls -la');
  });
});

describe('buildKeynotes', () => {
  const meta = {
    sessionId: 'abcdef123456',
    updatedAt: Date.parse('2026-11-03T10:00:00Z'),
    projectDir: P,
  };
  const tokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

  it('round-trips the Summary and treats the placeholder as empty', () => {
    const f = updateFacts(newFacts(), parseTranscriptText(work().text()));
    const text = buildKeynotes(f, '- Decided to use a hand-written lexer', meta, 1500);
    expect(extractSummary(text)).toBe('- Decided to use a hand-written lexer');
    expect(extractSummary(buildKeynotes(f, '', meta, 1500))).toBe('');
    expect(text).toContain(SUMMARY_START);
    expect(text).toContain(SUMMARY_END);
  });

  it('shrinks Facts first to fit the cap', () => {
    const f = newFacts();
    for (let i = 0; i < 40; i++)
      f.files[`${P}\\src\\module-with-a-long-name-${i}.ts`] = { edits: 1, writes: 0, last: i };
    f.todos = Array.from({ length: 20 }, (_, i) => ({
      content: `a fairly long to-do item number ${i} `.repeat(3),
      status: 'pending',
    }));
    const text = buildKeynotes(f, 'keep me', meta, 400);
    expect(tokens(text)).toBeLessThanOrEqual(400);
    expect(extractSummary(text)).toBe('keep me');
  });

  it('trims an oversized Summary as a last resort, keeping the markers', () => {
    const text = buildKeynotes(newFacts(), 'word '.repeat(5000), meta, 500);
    expect(tokens(text)).toBeLessThanOrEqual(500);
    expect(text).toContain('trimmed to fit');
    expect(text.trimEnd().endsWith(SUMMARY_END)).toBe(true);
  });
});
