/**
 * Builds synthetic transcripts in the same shape Claude Code writes them (split assistant entries sharing a
 * message id, tool results as user entries, compact boundaries, attachments), for deterministic tests.
 */
export class TranscriptBuilder {
  private lines: string[] = [];
  private t = Date.parse('2026-10-01T10:00:00Z');
  private n = 0;
  private context: number;

  constructor(
    private cwd = 'C:\\Users\\dev\\Projects\\LocalAI',
    startContext = 30_000,
  ) {
    this.context = startContext;
    this.push({ type: 'custom-title', customTitle: 'Synthetic session', sessionId: 'synthetic' });
  }

  private push(o: Record<string, unknown>): void {
    this.lines.push(JSON.stringify(o));
  }

  private stamp(): string {
    return new Date(this.t).toISOString();
  }

  /** Advances the clock (minutes). */
  wait(minutes: number): this {
    this.t += minutes * 60_000;
    return this;
  }

  prompt(text: string): this {
    this.t += 1000;
    this.push({
      type: 'user',
      message: { role: 'user', content: text },
      timestamp: this.stamp(),
      cwd: this.cwd,
      sessionId: 'synthetic',
    });
    return this;
  }

  attachment(type: string, chars: number): this {
    this.push({
      type: 'attachment',
      attachment: { type, content: 'a'.repeat(chars) },
      timestamp: this.stamp(),
    });
    return this;
  }

  /**
   * One API request. `grow` is how much the context grew since the previous request; `cacheWrite` defaults to
   * that growth (the normal warm-cache case).
   */
  request(
    opts: {
      grow?: number;
      text?: string;
      tools?: { name: string; input: Record<string, unknown> }[];
      output?: number;
      cacheWrite?: number;
      model?: string;
      sidechain?: boolean;
    } = {},
  ): string[] {
    this.t += 2000;
    this.context += opts.grow ?? 0;
    const id = `msg_${++this.n}`;
    const cw = opts.cacheWrite ?? opts.grow ?? 0;
    const usage = {
      input_tokens: 3,
      cache_creation_input_tokens: cw,
      cache_read_input_tokens: this.context - cw - 3,
      output_tokens: opts.output ?? 200,
    };
    const base = {
      type: 'assistant',
      timestamp: this.stamp(),
      isSidechain: opts.sidechain ?? false,
      cwd: this.cwd,
    };
    const msg = (content: unknown[]) => ({
      ...base,
      message: { id, model: opts.model ?? 'claude-opus-5-5', role: 'assistant', content, usage },
    });
    // Claude Code writes each content block as its own line, all sharing the message id and usage.
    this.push(msg([{ type: 'thinking', thinking: '', signature: 'sig' }]));
    if (opts.text) this.push(msg([{ type: 'text', text: opts.text }]));
    const ids: string[] = [];
    for (const tool of opts.tools ?? []) {
      const tid = `toolu_${this.n}_${ids.length}`;
      ids.push(tid);
      this.push(msg([{ type: 'tool_use', id: tid, name: tool.name, input: tool.input }]));
    }
    return ids;
  }

  toolResult(toolUseId: string, content: string, isError = false): this {
    this.t += 500;
    this.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
      },
      timestamp: this.stamp(),
    });
    return this;
  }

  compact(preTokens: number, postTokens: number): this {
    this.push({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: this.stamp(),
      compactMetadata: { trigger: 'auto', preTokens, postTokens },
    });
    this.push({
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: 's'.repeat(8000) },
      timestamp: this.stamp(),
    });
    this.context = postTokens;
    return this;
  }

  /** Sets the next request's context directly (e.g. right after compaction). */
  setContext(c: number): this {
    this.context = c;
    return this;
  }

  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  text(): string {
    return this.lines.join('\n') + '\n';
  }
}

export function lines(n: number, width = 40): string {
  return Array.from(
    { length: n },
    (_, i) => `${String(i + 1).padStart(6)}\t${'x'.repeat(width)}`,
  ).join('\n');
}
