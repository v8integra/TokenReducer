export interface AnalyzeArgs {
  /** Project folder whose Claude Code transcripts to read (default: cwd). */
  project?: string;
  /** Explicit transcript folder; overrides --project. */
  transcriptsDir?: string;
  /** Session ids or .jsonl paths. */
  sessions: string[];
  /** Only the newest N sessions. */
  last?: number;
  since?: number;
  until?: number;
  /** Only sessions whose inferred target project matches (case-insensitive). */
  target?: string;
  out?: string;
  html: boolean;
  json: boolean;
  redact: boolean;
  /** Analyze each target project separately and write one report per target. */
  byTarget: boolean;
  /** Replay sessions under candidate context policies. */
  simulate: boolean;
}

export class ArgError extends Error {}

export function parseAnalyzeArgs(argv: string[]): AnalyzeArgs {
  const a: AnalyzeArgs = {
    sessions: [],
    html: false,
    json: false,
    redact: false,
    byTarget: false,
    simulate: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new ArgError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--project':
        a.project = value();
        break;
      case '--transcripts':
        a.transcriptsDir = value();
        break;
      case '--session':
        a.sessions.push(value());
        break;
      case '--last':
        a.last = positiveInt(flag, value());
        break;
      case '--since':
        a.since = date(flag, value());
        break;
      case '--until':
        a.until = date(flag, value()) + 86_400_000 - 1;
        break;
      case '--target':
        a.target = value();
        break;
      case '--out':
        a.out = value();
        break;
      case '--html':
        a.html = true;
        break;
      case '--json':
        a.json = true;
        break;
      case '--redact':
        a.redact = true;
        break;
      case '--simulate':
        a.simulate = true;
        break;
      case '--by-target':
        a.byTarget = true;
        break;
      default:
        throw new ArgError(`unknown option ${flag}`);
    }
  }
  return a;
}

function positiveInt(flag: string, v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ArgError(`${flag} expects a positive whole number`);
  return n;
}

function date(flag: string, v: string): number {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v);
  if (!Number.isFinite(t)) throw new ArgError(`${flag} expects a date like 2026-10-01`);
  return t;
}

export const USAGE = `tokentrim analyze [options]

Reads Claude Code transcripts locally and writes a token report. Nothing leaves your machine.

  --project <dir>       project whose sessions to read (default: current folder)
  --transcripts <dir>   read this transcript folder directly instead
  --session <id|file>   one session (repeatable)
  --last <n>            only the newest n sessions
  --since <date>        sessions active on or after this date (YYYY-MM-DD)
  --until <date>        sessions that started on or before this date
  --target <name>       only sessions that mostly worked in this project folder
  --by-target           one report per target project, plus an index
  --simulate            estimate savings of clear/compact policies on these sessions
  --out <dir>           where to write reports (default: <project>/.tokentrim/reports)
  --html                also write a self-contained HTML report with charts
  --json                also write the raw analysis as JSON
  --redact              replace file paths and commands with short hashes
`;
