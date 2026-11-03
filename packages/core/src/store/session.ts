import type { TokenTrimConfig } from '../config/defaults.js';
import {
  DEFAULT_LIVE_OPTIONS,
  newLiveState,
  updateLive,
  type LiveOptions,
  type LiveState,
} from '../live/index.js';
import { writeKeynotes } from './keynotes.js';
import { loadOrNew, readNewLines, saveState } from './state.js';

export function liveOptions(c: TokenTrimConfig): LiveOptions {
  return {
    ...DEFAULT_LIVE_OPTIONS,
    ratios: { r_read: c.pricing.r_read, r_write: c.pricing.r_write, r_out: c.pricing.r_out },
    keynotesTokens: c.checkpoint.max_tokens,
  };
}

/**
 * Brings a session's live state (and keynotes, when the checkpoint module is on) up to date with its
 * transcript. Shared by the Stop, PreCompact and SessionEnd hooks and by `tokentrim keynotes refresh`.
 */
export async function refreshSession(
  projectDir: string,
  sessionId: string,
  transcriptPath: string | undefined,
  config: TokenTrimConfig,
): Promise<LiveState> {
  let state = await loadOrNew(projectDir, sessionId);
  const transcript = transcriptPath ?? state.transcriptPath;
  if (transcript) {
    const chunk = await readNewLines(transcript, state.offset);
    if (chunk.restarted) state = newLiveState(sessionId, state.source);
    if (chunk.text) updateLive(state, chunk.text, liveOptions(config));
    state.offset = chunk.offset;
    state.transcriptPath = transcript;
  }
  await saveState(projectDir, state);
  if (config.modules.checkpoint)
    await writeKeynotes(projectDir, state, config.checkpoint.max_tokens);
  return state;
}
