import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Hooks must finish well inside the 5 s timeout in hooks.json; past this, give up silently. */
export const WATCHDOG_MS = 4000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface HookOutput {
  /** JSON to print on stdout. Omit for no output. */
  json?: Record<string, unknown>;
}

export type Handler = (input: Record<string, unknown>) => Promise<HookOutput | void>;

export function logDir(home = os.homedir()): string {
  return path.join(home, '.tokentrim', 'logs');
}

/** Appends to ~/.tokentrim/logs/hooks.log, rotating at 5 MB. Logging itself must never throw. */
export function logError(event: string, err: unknown): void {
  try {
    const dir = logDir();
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'hooks.log');
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, file + '.1');
    } catch {
      // No log yet.
    }
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    appendFileSync(file, `${new Date().toISOString()} ${event} ${msg}\n`);
  } catch {
    // Nowhere left to report to.
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Runs a hook handler fail-open (plan §8, rule 1): any error, bad input or timeout ends in exit 0 with no
 * output, so Claude Code behaves as if TokenTrim weren't installed.
 */
export async function runHook(event: string, handler: Handler): Promise<void> {
  const done = (code = 0) => process.exit(code);
  if (process.env.TOKENTRIM_DISABLE === '1') return done();
  const watchdog = setTimeout(() => {
    logError(event, new Error(`timed out after ${WATCHDOG_MS} ms`));
    done();
  }, WATCHDOG_MS);
  watchdog.unref();
  try {
    const raw = await readStdin();
    const input: unknown = JSON.parse(raw);
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new Error('hook input is not a JSON object');
    const out = await handler(input as Record<string, unknown>);
    if (out?.json) process.stdout.write(JSON.stringify(out.json));
  } catch (e) {
    logError(event, e);
  }
  clearTimeout(watchdog);
  done();
}
