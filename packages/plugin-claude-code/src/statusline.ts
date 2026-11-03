import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  isOurCommand,
  statuslineChainPath,
  type MeterInput,
  type StatuslineChain,
} from '@tokentrim/core';

type Json = Record<string, unknown>;

export const obj = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Runs the status line that was configured before ours, with the same stdin, and returns its output. */
export function chained(raw: string, chainFile = statuslineChainPath()): string {
  try {
    const chain = JSON.parse(readFileSync(chainFile, 'utf8')) as StatuslineChain;
    const cmd = chain.previous?.command;
    // Never chain to ourselves, which would recurse.
    if (!cmd || isOurCommand(cmd)) return '';
    const r = spawnSync(cmd, { shell: true, input: raw, encoding: 'utf8', timeout: 1500 });
    return (r.stdout ?? '').replace(/\s+$/, '');
  } catch {
    return '';
  }
}

export function meterInput(data: Json, now = Date.now()): MeterInput {
  const cw = obj(data.context_window);
  const usage = obj(cw.current_usage);
  const fromUsage =
    (num(usage.input_tokens) ?? 0) +
    (num(usage.cache_creation_input_tokens) ?? 0) +
    (num(usage.cache_read_input_tokens) ?? 0);
  const pc = data.prompt_cache === undefined ? undefined : obj(data.prompt_cache);
  return {
    context: fromUsage || num(cw.total_input_tokens) || 0,
    window: num(cw.context_window_size) ?? 200_000,
    usd: num(obj(data.cost).total_cost_usd),
    cache:
      pc && typeof pc.warm === 'boolean'
        ? { warm: pc.warm, expiresAt: num(pc.expires_at) ?? null }
        : undefined,
    now,
  };
}
