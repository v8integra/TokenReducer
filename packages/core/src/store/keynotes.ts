import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildKeynotes, extractSummary, newFacts } from '../keynotes/index.js';
import type { LiveState } from '../live/index.js';

export function keynotesDir(projectDir: string): string {
  return path.join(projectDir, '.tokentrim', 'keynotes');
}

export function sessionKeynotesPath(projectDir: string, sessionId: string): string {
  return path.join(keynotesDir(projectDir), `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.md`);
}

/** Copy of the most recently updated session's keynotes, for people (and `inject_on_startup`). */
export function latestKeynotesPath(projectDir: string): string {
  return path.join(projectDir, '.tokentrim', 'keynotes.md');
}

/** Written by SessionEnd(clear) so the next SessionStart(clear) knows which session it follows. */
export function clearPointerPath(projectDir: string): string {
  return path.join(projectDir, '.tokentrim', 'state', 'last-cleared.json');
}

/** Session keynotes kept; older ones are pruned. */
const KEEP_SESSIONS = 30;

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/** The Summary currently in a session's keynotes file ('' if none yet). */
export async function readSummary(projectDir: string, sessionId: string): Promise<string> {
  return extractSummary((await readText(sessionKeynotesPath(projectDir, sessionId))) ?? '');
}

/**
 * Re-renders a session's keynotes from its live state, keeping whatever Summary the file already has (or
 * `summaryIfNew` for a fresh file), within `maxTokens`. Returns the text written.
 */
export async function writeKeynotes(
  projectDir: string,
  state: LiveState,
  maxTokens: number,
  summaryIfNew = '',
): Promise<string> {
  const file = sessionKeynotesPath(projectDir, state.sessionId);
  const existing = await readText(file);
  const summary = existing === null ? summaryIfNew : extractSummary(existing);
  const text = buildKeynotes(
    state.facts ?? newFacts(),
    summary,
    { sessionId: state.sessionId, updatedAt: state.updatedAt || Date.now(), projectDir },
    maxTokens,
  );
  // Skip the write when only the timestamp line would change.
  const body = (t: string) => t.slice(t.indexOf('\n'));
  if (existing === null || body(existing) !== body(text)) {
    await writeAtomic(file, text);
    await writeAtomic(latestKeynotesPath(projectDir), text);
  }
  if (existing === null) await prune(projectDir).catch(() => undefined);
  return text;
}

async function prune(projectDir: string): Promise<void> {
  const dir = keynotesDir(projectDir);
  const names = (await readdir(dir)).filter((n) => n.endsWith('.md'));
  if (names.length <= KEEP_SESSIONS) return;
  const withTime = await Promise.all(
    names.map(async (n) => ({ n, t: (await stat(path.join(dir, n))).mtimeMs })),
  );
  withTime.sort((a, b) => b.t - a.t);
  for (const { n } of withTime.slice(KEEP_SESSIONS)) await rm(path.join(dir, n), { force: true });
}

export async function writeClearPointer(
  projectDir: string,
  sessionId: string,
  now = Date.now(),
): Promise<void> {
  await writeAtomic(clearPointerPath(projectDir), JSON.stringify({ sessionId, at: now }));
}

/** The session that was just cleared, if the pointer is recent; the pointer is consumed either way. */
export async function takeClearPointer(
  projectDir: string,
  maxAgeMs = 10 * 60_000,
  now = Date.now(),
): Promise<string | null> {
  const file = clearPointerPath(projectDir);
  const text = await readText(file);
  if (text === null) return null;
  await rm(file, { force: true });
  try {
    const p = JSON.parse(text) as { sessionId?: unknown; at?: unknown };
    if (typeof p.sessionId === 'string' && typeof p.at === 'number' && now - p.at <= maxAgeMs)
      return p.sessionId;
  } catch {
    // Corrupt pointer: treat as none.
  }
  return null;
}

export { readText as readTextFile };
