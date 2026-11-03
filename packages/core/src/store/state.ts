import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isLiveState, newLiveState, type LiveState } from '../live/index.js';

/** A first Stop on a long resumed session reads at most this much; later Stops pick up the rest. */
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

export function stateDir(projectDir: string): string {
  return path.join(projectDir, '.tokentrim', 'state');
}

/** Session ids come from Claude Code, but they become file names, so keep only safe characters. */
export function stateFile(projectDir: string, sessionId: string): string {
  return path.join(stateDir(projectDir), `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

export async function loadState(projectDir: string, sessionId: string): Promise<LiveState | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(stateFile(projectDir, sessionId), 'utf8'));
    return isLiveState(parsed) && parsed.sessionId === sessionId ? parsed : null;
  } catch {
    return null; // Missing or corrupt: start over.
  }
}

/** Write-then-rename, so the status line never reads a half-written file. */
export async function saveState(projectDir: string, state: LiveState): Promise<void> {
  const file = stateFile(projectDir, state.sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

export async function loadOrNew(projectDir: string, sessionId: string): Promise<LiveState> {
  return (await loadState(projectDir, sessionId)) ?? newLiveState(sessionId);
}

/**
 * Reads the transcript from `offset` up to the last complete line. Returns the text and the new offset. A
 * transcript shorter than the offset (rewritten or replaced) restarts from 0.
 */
export async function readNewLines(
  transcriptPath: string,
  offset: number,
): Promise<{ text: string; offset: number; restarted: boolean }> {
  const size = (await stat(transcriptPath)).size;
  const restarted = size < offset;
  const start = restarted ? 0 : offset;
  const length = Math.min(size - start, MAX_CHUNK_BYTES);
  if (length <= 0) return { text: '', offset: start, restarted };
  const buf = Buffer.alloc(length);
  const fh = await open(transcriptPath, 'r');
  try {
    await fh.read(buf, 0, length, start);
  } finally {
    await fh.close();
  }
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline < 0) return { text: '', offset: start, restarted };
  return {
    text: buf.subarray(0, lastNewline + 1).toString('utf8'),
    offset: start + lastNewline + 1,
    restarted,
  };
}
