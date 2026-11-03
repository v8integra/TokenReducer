// Turns a real Claude Code transcript into a redacted test fixture.
//
//   node scripts/make-fixture.mjs <in.jsonl> <out.jsonl> [--max-lines N]
//
// Structure, usage numbers, timestamps, tool names and text *lengths* are kept, so the analyzer sees the same
// shape. Every piece of text is replaced by filler derived from a hash of the original (identical text stays
// identical, so duplicate-read detection still works). Paths keep their extension but lose every name.
import { createHash } from 'node:crypto';
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [input, output, ...rest] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/make-fixture.mjs <in.jsonl> <out.jsonl> [--max-lines N]');
  process.exit(2);
}
const maxLines = rest[0] === '--max-lines' ? Number(rest[1]) : Infinity;

/** Values under these keys are structural and safe to keep verbatim. */
const KEEP = new Set([
  'type',
  'subtype',
  'role',
  'model',
  'id',
  'tool_use_id',
  'uuid',
  'parentUuid',
  'logicalParentUuid',
  'timestamp',
  'stop_reason',
  'trigger',
  'version',
  'level',
  'promptId',
  'operation',
  'entrypoint',
  'permissionMode',
  'userType',
  'kind',
  'name',
  'messageId',
  'toolUseID',
  'leafUuid',
]);
/** Dropped entirely: account identifiers and opaque blobs. */
const DROP = new Set([
  'signature',
  'ownerAccountUuid',
  'ownerOrganizationUuid',
  'bridgeSessionId',
  'requestId',
]);
const PATH_KEYS = new Set(['file_path', 'notebook_path', 'path', 'filePath']);
const projects = new Map();

function filler(s) {
  if (!s) return s;
  const seed = createHash('sha1').update(s).digest('hex');
  // Keep newlines so line counts (large-file detection) survive.
  return s.replace(/[^\n]/g, (_, i) => seed[i % seed.length]);
}

function fakePath(p) {
  const ext = /\.[A-Za-z0-9]{1,6}$/.exec(p)?.[0] ?? '';
  const m = /Projects[\\/]+([^\\/]+)/i.exec(p);
  let project = 'Other';
  if (m) {
    const key = m[1].toLowerCase();
    if (!projects.has(key)) projects.set(key, `Project${String.fromCharCode(65 + projects.size)}`);
    project = projects.get(key);
  }
  const h = createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 8);
  return `C:\\Users\\dev\\Projects\\${project}\\file-${h}${ext}`;
}

function redact(v, key) {
  if (typeof v === 'string') {
    if (KEEP.has(key)) return v;
    if (key === 'cwd') return 'C:\\Users\\dev\\Projects\\LocalAI';
    if (key === 'sessionId') return 'fixture';
    if (PATH_KEYS.has(key)) return fakePath(v);
    // Keep paths inside commands as fake paths (target-project inference reads them); fill the rest.
    if (key === 'command') {
      return v
        .split(/((?:[A-Za-z]:[\\/]|\/c\/)[^\s"'`|<>;,)]+)/)
        .map((part, i) => (i % 2 ? fakePath(part) : filler(part)))
        .join('');
    }
    return filler(v);
  }
  if (Array.isArray(v)) return v.map((x) => redact(x, key));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!DROP.has(k)) out[k] = redact(x, k);
    return out;
  }
  return v;
}

const lines = [];
const rl = createInterface({
  input: createReadStream(input, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});
for await (const line of rl) {
  if (lines.length >= maxLines) break;
  if (!line.trim()) {
    lines.push(line);
    continue;
  }
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    lines.push('{"truncated": '); // keep one malformed line so parsers are exercised
    continue;
  }
  // Drop entry types that carry free-form text we don't need.
  if (['last-prompt', 'queue-operation', 'bridge-session', 'atis-latch'].includes(o.type)) continue;
  lines.push(JSON.stringify(redact(o, '')));
}
writeFileSync(output, lines.join('\n') + '\n');
console.log(`wrote ${lines.length} lines to ${output}`);
