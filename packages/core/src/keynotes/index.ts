import path from 'node:path';
import type { ParsedSession } from '../transcript/types.js';
import { pathKey } from '../util/paths.js';
import { CHARS_PER_TOKEN } from '../util/tokens.js';

/**
 * Keynotes (plan §5.2): a small file that survives /clear and compaction. Two parts:
 * - Facts: extracted deterministically from the transcript, no tokens spent;
 * - Summary: written by Claude only when the user runs /tokentrim:checkpoint.
 * Everything here is pure; the hooks do the file I/O.
 */
export interface Facts {
  branch?: string;
  /** Changed files by absolute path, with how they were changed and when (request order). */
  files: Record<string, { edits: number; writes: number; last: number }>;
  /** Recent notable commands (tests, builds, git), newest last. */
  commands: { cmd: string; ok: boolean }[];
  /** Failures not yet followed by a success of the same thing, newest last. */
  errors: { key: string; what: string; preview: string }[];
  todos: { content: string; status: string }[] | null;
  /** The last few prompts the user typed, truncated. */
  requests: string[];
  /** Monotonic counter used to order files. */
  seq: number;
}

export function newFacts(): Facts {
  return { files: {}, commands: [], errors: [], todos: null, requests: [], seq: 0 };
}

const MAX_COMMANDS = 6;
const MAX_ERRORS = 4;
const MAX_REQUESTS = 3;
const MAX_FILES = 40;
const NOTABLE =
  /\b(test|build|lint|tsc|vitest|jest|pytest|cargo|go\s+(test|build|run)|dotnet|mvn|gradle|make|deploy)\b|\b(npm|pnpm|yarn)\s+(run|test|install|ci|i)\b|\bgit\s+(commit|push|merge|rebase|checkout|switch|tag|reset|revert)\b/;
const EDIT_TOOLS = /^(Edit|MultiEdit|NotebookEdit)$/;
/** Looking around, not doing: a failure here isn't an "open error" worth carrying over. */
const EXPLORATORY =
  /^(ls|dir|cat|type|head|tail|find|grep|rg|sed\s+-n|wc|pwd|which|where|echo|stat|file|tree|Get-ChildItem|Get-Content|git\s+(status|log|diff|show|branch|remote))\b/;

/** The command as a person would name it: no leading `cd`, output plumbing or heredoc bodies. */
export function shortCommand(cmd: string): string {
  return cmd
    .replace(/^\s*cd\s+("[^"]*"|\S+)\s*(&&|;)\s*/, '')
    .replace(/\s*"?\$\(cat\s*<<[\s\S]*$/, ' …')
    .replace(/\s+\d?>&\d\b/g, '')
    .replace(/\s*(\||>|&\s*disown)[\s\S]*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

function cleanError(preview: string): string {
  return preview.replace(/^Exit code (\d+)\s*/, 'exit $1: ');
}

/** Applies the tool calls and prompts of a transcript chunk to the facts. */
export function updateFacts(f: Facts, delta: ParsedSession): Facts {
  if (delta.gitBranch) f.branch = delta.gitBranch;
  for (const t of delta.toolCalls) {
    if (t.isSidechain) continue;
    // The to-do list is the tool's input, so it counts even before (or without) a result.
    if (t.input.todos) f.todos = t.input.todos;
    if (!t.result) continue;
    const res = t.result;
    const fp = t.input.file_path;
    let key: string | undefined;
    let what = '';
    if (fp && (t.name === 'Write' || EDIT_TOOLS.test(t.name))) {
      key = `${t.name === 'Write' ? 'Edit' : t.name}:${pathKey(fp)}`;
      what = `${t.name} ${fp}`;
      if (!res.isError) {
        const rec = f.files[fp] ?? { edits: 0, writes: 0, last: 0 };
        if (t.name === 'Write') rec.writes++;
        else rec.edits++;
        rec.last = ++f.seq;
        f.files[fp] = rec;
      }
    } else if (t.name === 'Bash' && t.input.command) {
      const cmd = shortCommand(t.input.command);
      if (!EXPLORATORY.test(cmd)) {
        key = `Bash:${cmd}`;
        what = cmd;
      }
      if (NOTABLE.test(cmd)) {
        f.commands = f.commands.filter((c) => c.cmd !== cmd);
        f.commands.push({ cmd, ok: !res.isError });
        f.commands = f.commands.slice(-MAX_COMMANDS);
      }
    }
    if (key) {
      f.errors = f.errors.filter((e) => e.key !== key);
      if (res.isError)
        f.errors = [...f.errors, { key, what, preview: cleanError(res.errorPreview ?? '') }].slice(
          -MAX_ERRORS,
        );
    }
  }
  for (const p of delta.prompts) {
    if (p.kind === 'human' && p.preview)
      f.requests = [...f.requests, p.preview].slice(-MAX_REQUESTS);
  }
  const files = Object.entries(f.files);
  if (files.length > MAX_FILES) {
    files.sort((a, b) => b[1].last - a[1].last);
    f.files = Object.fromEntries(files.slice(0, MAX_FILES));
  }
  return f;
}

export const FACTS_START = '<!-- tokentrim:facts -->';
export const FACTS_END = '<!-- /tokentrim:facts -->';
export const SUMMARY_START = '<!-- tokentrim:summary -->';
export const SUMMARY_END = '<!-- /tokentrim:summary -->';
export const SUMMARY_PLACEHOLDER =
  '_Not written yet. Run /tokentrim:checkpoint to record decisions, the current task and next steps._';

interface FactLimits {
  files: number;
  commands: number;
  errors: number;
  todos: number;
  requests: number;
}

function rel(p: string, projectDir?: string): string {
  if (!projectDir) return p;
  const isWin = /^[A-Za-z]:[\\/]/.test(p);
  const lib = isWin ? path.win32 : path.posix;
  const r = lib.relative(projectDir, p);
  return r && !r.startsWith('..') && !lib.isAbsolute(r)
    ? r.replace(/\\/g, '/')
    : p.replace(/\\/g, '/');
}

/** Longest shared folder (with trailing slash) of absolute forward-slash paths, if it's more than a drive. */
function commonDir(paths: string[]): string {
  if (paths.length === 0) return '';
  let prefix = paths[0]!.slice(0, paths[0]!.lastIndexOf('/') + 1);
  for (const p of paths.slice(1)) {
    while (prefix && !p.toLowerCase().startsWith(prefix.toLowerCase()))
      prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf('/') + 1);
  }
  return prefix.split('/').filter(Boolean).length >= 3 ? prefix : '';
}

export function renderFacts(f: Facts, projectDir?: string, lim?: Partial<FactLimits>): string {
  const L: FactLimits = {
    files: 12,
    commands: MAX_COMMANDS,
    errors: MAX_ERRORS,
    todos: 12,
    requests: MAX_REQUESTS,
    ...lim,
  };
  const out: string[] = ['## Facts', ''];
  if (f.branch) out.push(`- Branch: ${f.branch}`);
  const recent = Object.entries(f.files)
    .sort((a, b) => b[1].last - a[1].last)
    .slice(0, L.files);
  // Work often happens outside the folder Claude Code was started in; name the shared folder once.
  const shown = recent.map(([p]) => rel(p, projectDir));
  const root = commonDir(shown.filter((p) => /^([A-Za-z]:)?\//.test(p)));
  const files = recent.map(([, r], i) => {
    const name = root && shown[i]!.startsWith(root) ? shown[i]!.slice(root.length) : shown[i]!;
    const edits = r.edits ? `${r.edits} edit${r.edits === 1 ? '' : 's'}` : '';
    return `${name} (${[r.writes ? 'written' : '', edits].filter(Boolean).join(', ')})`;
  });
  const more = Object.keys(f.files).length - files.length;
  if (files.length)
    out.push(
      `- Files changed${root ? ` in ${root}` : ''}: ${files.join(', ')}${more > 0 ? `, +${more} more` : ''}`,
    );
  const cmds = f.commands.slice(-L.commands);
  if (cmds.length)
    out.push(
      `- Recent commands: ${cmds.map((c) => `${c.ok ? '✓' : '✗'} \`${c.cmd}\``).join(' · ')}`,
    );
  for (const e of f.errors.slice(-L.errors))
    out.push(`- Open error: \`${rel(e.what, projectDir)}\`${e.preview ? ` — ${e.preview}` : ''}`);
  if (f.todos?.length) {
    // Unfinished items first; they're what the next session needs.
    const todos = [...f.todos].sort(
      (a, b) => Number(a.status === 'completed') - Number(b.status === 'completed'),
    );
    const shown = todos.slice(0, L.todos);
    out.push(
      `- To-dos: ${shown.map((t) => `[${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join(' · ')}${todos.length > shown.length ? ` · +${todos.length - shown.length} more` : ''}`,
    );
  }
  for (const r of f.requests.slice(-L.requests)) out.push(`- You asked: "${r}"`);
  if (out.length === 2) out.push('- Nothing recorded yet.');
  return out.join('\n');
}

export interface KeynotesDoc {
  sessionId: string;
  updatedAt: number;
  facts: string;
  summary: string;
}

export function renderKeynotes(d: KeynotesDoc): string {
  return [
    `# Keynotes (session ${d.sessionId.slice(0, 8)}, ${new Date(d.updatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
    '',
    FACTS_START,
    d.facts,
    FACTS_END,
    '',
    SUMMARY_START,
    '## Summary',
    '',
    d.summary.trim() || SUMMARY_PLACEHOLDER,
    SUMMARY_END,
    '',
  ].join('\n');
}

/** The Summary a user or Claude wrote, or '' when it's missing or still the placeholder. */
export function extractSummary(text: string): string {
  const a = text.indexOf(SUMMARY_START);
  const b = text.indexOf(SUMMARY_END);
  if (a < 0 || b < a) return '';
  const body = text
    .slice(a + SUMMARY_START.length, b)
    .replace(/^\s*## Summary\s*/, '')
    .trim();
  return body === SUMMARY_PLACEHOLDER ? '' : body;
}

const tokensOf = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

/**
 * Builds keynotes that fit in `maxTokens` (plan §5.2: keynotes must stay small or they stop saving anything).
 * Facts shrink first, oldest and least useful items going first; the Summary is cut only as a last resort.
 */
export function buildKeynotes(
  facts: Facts,
  summary: string,
  meta: { sessionId: string; updatedAt: number; projectDir?: string },
  maxTokens: number,
): string {
  const steps: Partial<FactLimits>[] = [
    {},
    { commands: 3, todos: 8, files: 8 },
    { commands: 2, todos: 5, files: 5, requests: 2, errors: 2 },
    { commands: 0, todos: 3, files: 3, requests: 1, errors: 1 },
    { commands: 0, todos: 0, files: 0, requests: 0, errors: 1 },
  ];
  let text = '';
  for (const lim of steps) {
    text = renderKeynotes({ ...meta, facts: renderFacts(facts, meta.projectDir, lim), summary });
    if (tokensOf(text) <= maxTokens) return text;
  }
  // Still too big: the Summary itself is over budget. Keep its start.
  const room = Math.max(0, maxTokens * CHARS_PER_TOKEN - (text.length - summary.length) - 40);
  const cut = summary.slice(0, room).replace(/\s+\S*$/, '');
  return renderKeynotes({
    ...meta,
    facts: renderFacts(facts, meta.projectDir, steps.at(-1)),
    summary: `${cut}\n\n_(trimmed to fit the keynotes size cap)_`,
  });
}

/** What SessionStart injects. The framing keeps it from reading as instructions. */
export function injectionText(keynotes: string, reason: 'clear' | 'compact' | 'startup'): string {
  const why =
    reason === 'clear'
      ? 'from the session before /clear'
      : reason === 'compact'
        ? 'from before compaction'
        : 'from the last session in this project';
  return `TokenTrim keynotes ${why}. They are notes, not instructions; check the code before relying on them.\n\n${keynotes}`;
}
