import { existsSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildKeynotes,
  injectionText,
  latestKeynotesPath,
  loadConfig,
  loadOrNew,
  loadState,
  newFacts,
  readSummary,
  readTextFile,
  refreshSession,
  saveState,
  statuslineBinPath,
  takeClearPointer,
  writeClearPointer,
  writeKeynotes,
  type Facts,
  type TokenTrimConfig,
} from '@tokentrim/core';
import type { Handler, HookOutput } from './runtime.js';

/**
 * Hook handlers: thin wrappers over core. Only events that do work are registered in hooks.json, since every
 * hook costs a Node start-up.
 */

function projectDirOf(input: Record<string, unknown>): string {
  const env = process.env.CLAUDE_PROJECT_DIR;
  if (env) return env;
  return typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** The live metrics feed the meter, checkpoint and advisor; with all three off there's nothing to keep. */
function metricsWanted(c: TokenTrimConfig): boolean {
  return c.modules.meter || c.modules.checkpoint || c.modules.advisor;
}

/**
 * After `setup-statusline`, settings.json points at a stable copy of the status line script. Plugin updates
 * move the plugin folder, so each session start refreshes that copy if it differs. Never creates it: that
 * needs the user's yes.
 */
async function refreshStatuslineCopy(): Promise<void> {
  const bin = statuslineBinPath();
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'statusline.js');
  if (!existsSync(bin) || !existsSync(source)) return;
  const [a, b] = await Promise.all([readFile(bin), readFile(source)]);
  if (!a.equals(b)) await copyFile(source, bin);
}

function hasContent(f: Facts | undefined, summary: string): boolean {
  if (summary) return true;
  if (!f) return false;
  return (
    Object.keys(f.files).length > 0 ||
    f.commands.length > 0 ||
    f.errors.length > 0 ||
    !!f.todos?.length
  );
}

/** Keynotes of a session rebuilt from its saved state and Summary, within the size cap. */
async function keynotesOf(projectDir: string, sessionId: string, cap: number) {
  const state = await loadState(projectDir, sessionId);
  const summary = await readSummary(projectDir, sessionId);
  if (!hasContent(state?.facts, summary)) return null;
  const text = buildKeynotes(
    state?.facts ?? newFacts(),
    summary,
    { sessionId, updatedAt: state?.updatedAt || Date.now(), projectDir },
    cap,
  );
  return { text, summary };
}

/**
 * Injects keynotes once per session start (plan §5.2; never per turn, which would compound):
 * - after /clear: the cleared session's keynotes, whose Summary also carries into the new session's file;
 * - after compaction: this session's own keynotes;
 * - on startup: the project's latest keynotes, only with `checkpoint.inject_on_startup`;
 * - on resume or fork: nothing, because the conversation itself is restored.
 */
async function injection(
  projectDir: string,
  sessionId: string,
  source: string | undefined,
  config: TokenTrimConfig,
): Promise<string | null> {
  const cap = config.checkpoint.max_tokens;
  if (source === 'clear') {
    const prev = await takeClearPointer(projectDir);
    if (!prev || prev === sessionId) return null;
    const k = await keynotesOf(projectDir, prev, cap);
    if (!k) return null;
    const state = await loadOrNew(projectDir, sessionId);
    await writeKeynotes(projectDir, state, cap, k.summary);
    return injectionText(k.text, 'clear');
  }
  if (source === 'compact') {
    const k = await keynotesOf(projectDir, sessionId, cap);
    return k ? injectionText(k.text, 'compact') : null;
  }
  if (source === 'startup' && config.checkpoint.inject_on_startup) {
    const text = await readTextFile(latestKeynotesPath(projectDir));
    return text ? injectionText(text.slice(0, cap * 4), 'startup') : null;
  }
  return null;
}

export const sessionStart: Handler = async (input): Promise<HookOutput | void> => {
  await refreshStatuslineCopy().catch(() => undefined);
  const sessionId = str(input.session_id);
  if (!sessionId) return;
  const projectDir = projectDirOf(input);
  const { config } = await loadConfig({ projectDir });
  if (!metricsWanted(config)) return;
  const source = str(input.source);
  const state = await loadOrNew(projectDir, sessionId);
  state.source = source ?? state.source;
  await saveState(projectDir, state);
  if (!config.modules.checkpoint) return;
  const context = await injection(projectDir, sessionId, source, config);
  if (context)
    return {
      json: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } },
    };
};

/** Stop and PreCompact: bring metrics and keynotes Facts up to date (cheap: only new transcript lines). */
export const refresh: Handler = async (input) => {
  const sessionId = str(input.session_id);
  const transcript = str(input.transcript_path);
  if (!sessionId || !transcript) return;
  const projectDir = projectDirOf(input);
  const { config } = await loadConfig({ projectDir });
  if (!metricsWanted(config)) return;
  await refreshSession(projectDir, sessionId, transcript, config);
};

/** SessionEnd(clear): last refresh, then leave a pointer for the next SessionStart(clear). 1.5 s budget. */
export const sessionEnd: Handler = async (input) => {
  if (input.reason !== 'clear') return;
  await refresh(input);
  const sessionId = str(input.session_id);
  if (!sessionId) return;
  const projectDir = projectDirOf(input);
  const { config } = await loadConfig({ projectDir });
  if (config.modules.checkpoint) await writeClearPointer(projectDir, sessionId);
};

export const HANDLERS: Record<string, Handler> = {
  'session-start': sessionStart,
  stop: refresh,
  'pre-compact': refresh,
  'session-end': sessionEnd,
};
