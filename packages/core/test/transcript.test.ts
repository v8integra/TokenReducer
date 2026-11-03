import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listTranscripts, parseTranscriptFile, parseTranscriptText } from '../src/index.js';
import { lines, TranscriptBuilder } from './builder.js';

describe('transcript parser', () => {
  it('merges split assistant entries into one request per message id', () => {
    const b = new TranscriptBuilder();
    b.prompt('hello');
    b.request({
      grow: 1000,
      text: 'hi',
      tools: [
        { name: 'Read', input: { file_path: 'C:\\a.ts' } },
        { name: 'Bash', input: { command: 'ls' } },
      ],
    });
    const s = parseTranscriptText(b.text());
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]!.toolUseIds).toHaveLength(2);
    expect(s.requests[0]!.usage.cache_creation_input_tokens).toBe(1000);
    expect(s.toolCalls.map((t) => t.name)).toEqual(['Read', 'Bash']);
    expect(s.title).toBe('Synthetic session');
    expect(s.cwd).toBe('C:\\Users\\dev\\Projects\\LocalAI');
  });

  it('links tool results and records size, lines and hash', () => {
    const b = new TranscriptBuilder();
    const [id] = b.request({
      tools: [{ name: 'Read', input: { file_path: 'C:\\a.ts', offset: 10, limit: 5 } }],
    });
    b.toolResult(id!, lines(5));
    b.request({ grow: 100 });
    const s = parseTranscriptText(b.text());
    const call = s.toolCalls[0]!;
    expect(call.input).toEqual({ file_path: 'C:\\a.ts', offset: 10, limit: 5 });
    expect(call.result?.lines).toBe(5);
    expect(call.result?.chars).toBe(lines(5).length);
    expect(call.resultAddedBefore).toBe(1);
  });

  it('skips blank and malformed lines without losing the rest', () => {
    const b = new TranscriptBuilder();
    b.request({ grow: 10 });
    b.raw('').raw('{"broken": ').raw('[1,2]');
    b.request({ grow: 10 });
    const s = parseTranscriptText(b.text());
    expect(s.requests).toHaveLength(2);
    expect(s.malformedLines).toBe(2);
  });

  it('classifies prompts, meta entries, compaction summaries and attachments', () => {
    const b = new TranscriptBuilder();
    b.prompt('please fix the bug');
    b.prompt('<command-name>/clear</command-name>');
    b.attachment('skill_listing', 500);
    b.attachment('prompt_snapshot', 50_000);
    b.request({ grow: 10 });
    b.compact(150_000, 20_000);
    const s = parseTranscriptText(b.text());
    expect(s.prompts.map((p) => p.kind)).toEqual(['human', 'meta', 'meta', 'compact-summary']);
    expect(s.compactions).toEqual([
      expect.objectContaining({
        trigger: 'auto',
        preTokens: 150_000,
        postTokens: 20_000,
        beforeRequest: 1,
      }),
    ]);
  });

  it('keeps sidechain requests out of the main chain', () => {
    const b = new TranscriptBuilder();
    b.request({ grow: 10 });
    b.request({ grow: 10, sidechain: true });
    const s = parseTranscriptText(b.text());
    expect(s.requests).toHaveLength(1);
    expect(s.sidechainRequests).toHaveLength(1);
  });

  it('reads files from disk, including subagent transcripts, and lists sessions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tt-tr-'));
    const main = new TranscriptBuilder();
    main.request({ grow: 10 });
    await writeFile(path.join(dir, 'abc.jsonl'), main.text());
    await mkdir(path.join(dir, 'abc', 'subagents'), { recursive: true });
    const sub = new TranscriptBuilder();
    sub.request({ grow: 10, output: 999 });
    await writeFile(path.join(dir, 'abc', 'subagents', 'agent-1.jsonl'), sub.text());
    await writeFile(path.join(dir, 'notes.txt'), 'x');

    const s = await parseTranscriptFile(path.join(dir, 'abc.jsonl'));
    expect(s.requests).toHaveLength(1);
    expect(s.sidechainRequests).toHaveLength(1);
    expect(s.sidechainRequests[0]!.usage.output_tokens).toBe(999);
    expect((await listTranscripts(dir)).map((f) => f.sessionId)).toEqual(['abc']);
    expect(await listTranscripts(path.join(dir, 'missing'))).toEqual([]);
  });
});
