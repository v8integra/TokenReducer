import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Usage } from '../pricing/index.js';
import { contentHash } from '../util/hash.js';
import { CHARS_PER_TOKEN } from '../util/tokens.js';
import type {
  ApiRequest,
  ParsedSession,
  ToolCall,
  ToolInputSummary,
  ToolResult,
  UserPrompt,
} from './types.js';

/** Images have no text; count them at a typical vision-token cost. */
const IMAGE_CHARS = 1600 * CHARS_PER_TOKEN;
const PREVIEW_CHARS = 160;

type Json = Record<string, unknown>;

/**
 * Incremental parser: feed lines in file order, then call finish(). Keeps only sizes, hashes and the few
 * input fields the analyzer needs, never full contents, so 100 MB transcripts stay cheap.
 */
export class TranscriptParser {
  private s: ParsedSession;
  private byMessageId = new Map<string, ApiRequest>();
  private toolCallsById = new Map<string, ToolCall>();

  constructor(file: string, sessionId = path.basename(file, '.jsonl')) {
    this.s = {
      sessionId,
      file,
      firstTimestamp: Infinity,
      lastTimestamp: -Infinity,
      requests: [],
      sidechainRequests: [],
      toolCalls: [],
      prompts: [],
      compactions: [],
      malformedLines: 0,
      totalLines: 0,
    };
  }

  addLine(line: string): void {
    this.s.totalLines++;
    if (!line.trim()) return;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      this.s.malformedLines++;
      return;
    }
    if (!isObj(o)) {
      this.s.malformedLines++;
      return;
    }
    try {
      this.addEntry(o);
    } catch {
      // An entry with an unexpected shape must not poison the rest of the session.
      this.s.malformedLines++;
    }
  }

  private addEntry(o: Json): void {
    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      this.s.firstTimestamp = Math.min(this.s.firstTimestamp, ts);
      this.s.lastTimestamp = Math.max(this.s.lastTimestamp, ts);
    }
    if (typeof o.cwd === 'string' && !this.s.cwd) this.s.cwd = o.cwd;
    if (typeof o.version === 'string') this.s.version = o.version;
    if (typeof o.gitBranch === 'string' && o.gitBranch && o.gitBranch !== 'HEAD')
      this.s.gitBranch = o.gitBranch;

    switch (o.type) {
      case 'custom-title':
        if (typeof o.customTitle === 'string') this.s.title = o.customTitle;
        break;
      case 'ai-title':
        if (typeof o.aiTitle === 'string' && !this.s.title) this.s.title = o.aiTitle;
        break;
      case 'assistant':
        this.addAssistant(o, ts);
        break;
      case 'user':
        this.addUser(o, ts);
        break;
      case 'system':
        if (o.subtype === 'compact_boundary') this.addCompaction(o, ts);
        break;
      case 'attachment':
        // Reminders, skill listings, edited-file notices and the like, injected into context as meta content.
        // Snapshot/record attachments are client bookkeeping and never reach the model.
        if (
          isObj(o.attachment) &&
          o.isSidechain !== true &&
          !/snapshot|record/.test(String(o.attachment.type))
        ) {
          const chars = JSON.stringify(o.attachment).length;
          this.s.prompts.push({
            timestamp: ts,
            chars,
            preview: '',
            kind: 'meta',
            addedBefore: this.s.requests.length,
          });
        }
        break;
    }
  }

  private addCompaction(o: Json, ts: number): void {
    const meta = isObj(o.compactMetadata) ? o.compactMetadata : {};
    this.s.compactions.push({
      timestamp: ts,
      trigger: typeof meta.trigger === 'string' ? meta.trigger : 'unknown',
      preTokens: typeof meta.preTokens === 'number' ? meta.preTokens : null,
      postTokens: typeof meta.postTokens === 'number' ? meta.postTokens : null,
      beforeRequest: this.s.requests.length,
    });
  }

  private addAssistant(o: Json, ts: number): void {
    const m = o.message;
    if (!isObj(m)) return;
    const id = typeof m.id === 'string' ? m.id : `noid-${this.s.totalLines}`;
    const sidechain = o.isSidechain === true;
    let req = this.byMessageId.get(id);
    if (!req) {
      const list = sidechain ? this.s.sidechainRequests : this.s.requests;
      req = {
        id,
        index: list.length,
        timestamp: ts,
        model: typeof m.model === 'string' ? m.model : 'unknown',
        usage: emptyUsage(),
        isSidechain: sidechain,
        textChars: 0,
        thinkingChars: 0,
        toolUseChars: 0,
        toolUseIds: [],
      };
      list.push(req);
      this.byMessageId.set(id, req);
    }
    // Every split entry repeats the usage block; keep the largest output count seen.
    if (isObj(m.usage)) {
      const u = m.usage;
      req.usage = {
        input_tokens: num(u.input_tokens),
        cache_creation_input_tokens: num(u.cache_creation_input_tokens),
        cache_read_input_tokens: num(u.cache_read_input_tokens),
        output_tokens: Math.max(req.usage.output_tokens, num(u.output_tokens)),
      };
    }
    const content = Array.isArray(m.content) ? m.content : [];
    for (const c of content) {
      if (!isObj(c)) continue;
      if (c.type === 'text' && typeof c.text === 'string') req.textChars += c.text.length;
      else if (c.type === 'thinking' && typeof c.thinking === 'string')
        req.thinkingChars += c.thinking.length;
      else if (c.type === 'tool_use' && typeof c.id === 'string') {
        const inputJson = JSON.stringify(c.input ?? {});
        req.toolUseChars += inputJson.length;
        req.toolUseIds.push(c.id);
        const call: ToolCall = {
          id: c.id,
          name: typeof c.name === 'string' ? c.name : 'unknown',
          requestIndex: sidechain ? -1 : req.index,
          isSidechain: sidechain,
          timestamp: ts,
          input: summarizeInput(c.input),
          inputChars: inputJson.length,
          resultAddedBefore: -1,
        };
        this.toolCallsById.set(call.id, call);
        this.s.toolCalls.push(call);
      }
    }
  }

  private addUser(o: Json, ts: number): void {
    const m = o.message;
    if (!isObj(m)) return;
    const sidechain = o.isSidechain === true;
    const addedBefore = this.s.requests.length;
    if (typeof m.content === 'string') {
      if (!sidechain) this.pushPrompt(o, m.content, m.content.length, ts, addedBefore);
      return;
    }
    if (!Array.isArray(m.content)) return;
    let promptChars = 0;
    let promptText = '';
    for (const c of m.content) {
      if (!isObj(c)) continue;
      if (c.type === 'tool_result' && typeof c.tool_use_id === 'string') {
        const call = this.toolCallsById.get(c.tool_use_id);
        if (!call) continue;
        const { chars, text } = blockText(c.content);
        const result: ToolResult = {
          chars,
          lines: text ? text.split('\n').length : 0,
          isError: c.is_error === true,
          hash: contentHash(text),
          timestamp: ts,
        };
        // Facts list unresolved errors, so keep a short preview of error output (never of normal output).
        if (result.isError)
          result.errorPreview = text.replace(/\s+/g, ' ').trim().slice(0, ERROR_PREVIEW_CHARS);
        call.result = result;
        call.resultAddedBefore = sidechain ? -1 : addedBefore;
      } else if (c.type === 'text' && typeof c.text === 'string') {
        promptChars += c.text.length;
        promptText += c.text;
      } else if (c.type === 'image') {
        promptChars += IMAGE_CHARS;
      }
    }
    if (promptChars > 0 && !sidechain) this.pushPrompt(o, promptText, promptChars, ts, addedBefore);
  }

  private pushPrompt(o: Json, text: string, chars: number, ts: number, addedBefore: number): void {
    let kind: UserPrompt['kind'] = 'human';
    if (o.isCompactSummary === true) kind = 'compact-summary';
    else if (o.isMeta === true || isSystemText(text)) kind = 'meta';
    this.s.prompts.push({
      timestamp: ts,
      chars,
      preview: text.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim(),
      kind,
      addedBefore,
    });
  }

  /** Merges a subagent transcript's requests in as sidechain requests. */
  addSubagent(sub: ParsedSession): void {
    for (const r of [...sub.requests, ...sub.sidechainRequests]) {
      this.s.sidechainRequests.push({
        ...r,
        index: this.s.sidechainRequests.length,
        isSidechain: true,
      });
    }
    for (const t of sub.toolCalls) {
      this.s.toolCalls.push({ ...t, isSidechain: true, requestIndex: -1, resultAddedBefore: -1 });
    }
  }

  finish(): ParsedSession {
    if (!Number.isFinite(this.s.firstTimestamp)) this.s.firstTimestamp = 0;
    if (!Number.isFinite(this.s.lastTimestamp)) this.s.lastTimestamp = 0;
    return this.s;
  }
}

/** Command output, reminders and similar entries arrive as user messages but aren't typed by a person. */
const SYSTEM_TEXT =
  /^\s*<(command-name|command-message|local-command-stdout|local-command-caveat|system-reminder|task-notification|bash-input|bash-stdout)/;

function isSystemText(text: string): boolean {
  return SYSTEM_TEXT.test(text);
}

function summarizeInput(input: unknown): ToolInputSummary {
  if (!isObj(input)) return {};
  const out: ToolInputSummary = {};
  const fp = input.file_path ?? input.notebook_path;
  if (typeof fp === 'string') out.file_path = fp;
  if (typeof input.path === 'string') out.path = input.path;
  if (typeof input.offset === 'number') out.offset = input.offset;
  if (typeof input.limit === 'number') out.limit = input.limit;
  if (typeof input.command === 'string') out.command = input.command;
  if (typeof input.pattern === 'string') out.pattern = input.pattern;
  if (typeof input.url === 'string') out.url = input.url;
  // To-do tools: TodoWrite `todos`, the desktop app's update_plan `items`, TaskCreate `tasks` (sometimes a JSON string).
  const list = todoList(input.todos ?? input.items ?? input.tasks);
  if (list) {
    out.todosDone = list.length > 0 && list.every((t) => t.status === 'completed');
    out.todos = list.slice(0, MAX_TODOS);
  }
  if (typeof input.taskId === 'string') out.taskId = input.taskId;
  if (typeof input.status === 'string') out.status = input.status;
  return out;
}

const MAX_TODOS = 20;
const TODO_CHARS = 120;
const ERROR_PREVIEW_CHARS = 200;

function todoList(v: unknown): { content: string; status: string }[] | undefined {
  let arr = v;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(arr)) return undefined;
  return arr.map((t) => {
    const o = isObj(t) ? t : {};
    const text = o.content ?? o.subject ?? o.description ?? '';
    return {
      content:
        typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, TODO_CHARS) : '',
      status: typeof o.status === 'string' ? o.status : 'pending',
    };
  });
}

function blockText(content: unknown): { chars: number; text: string } {
  if (typeof content === 'string') return { chars: content.length, text: content };
  if (!Array.isArray(content)) return { chars: 0, text: '' };
  let text = '';
  let extra = 0;
  for (const c of content) {
    if (!isObj(c)) continue;
    if (c.type === 'text' && typeof c.text === 'string') text += c.text;
    else if (c.type === 'image') extra += IMAGE_CHARS;
  }
  return { chars: text.length + extra, text };
}

function emptyUsage(): Usage {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseTranscriptText(text: string, file = 'inline.jsonl'): ParsedSession {
  const p = new TranscriptParser(file);
  for (const line of text.split('\n')) p.addLine(line);
  return p.finish();
}

/** Streams a transcript file, plus any `<session>/subagents/*.jsonl` next to it. */
export async function parseTranscriptFile(file: string): Promise<ParsedSession> {
  const p = new TranscriptParser(file);
  await streamLines(file, (l) => p.addLine(l));
  const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  for (const name of await safeReaddir(subDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const sp = new TranscriptParser(path.join(subDir, name));
    await streamLines(path.join(subDir, name), (l) => sp.addLine(l));
    p.addSubagent(sp.finish());
  }
  return p.finish();
}

async function streamLines(file: string, onLine: (l: string) => void): Promise<void> {
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) onLine(line);
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    if (!(await stat(dir)).isDirectory()) return [];
    return await readdir(dir);
  } catch {
    return [];
  }
}
