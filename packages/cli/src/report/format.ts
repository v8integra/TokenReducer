import path from 'node:path';
import { shortHash } from '@tokentrim/core';

export function tok(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e5 ? 0 : 1)}K`;
  return `${Math.round(n)}`;
}

export function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  const p = (100 * part) / whole;
  return p > 0 && p < 0.1 ? '<0.1%' : `${p.toFixed(1)}%`;
}

export function day(t: number): string {
  return t > 0 ? new Date(t).toISOString().slice(0, 10) : '?';
}

export function turns(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : 'never';
}

/** Output paths, commands and titles through this so --redact is applied in one place. */
export class Redactor {
  constructor(readonly on: boolean) {}

  path(p: string): string {
    if (!this.on) return p;
    return `file#${shortHash(p.toLowerCase())}${path.extname(p.replace(/ \[.*\]$/, ''))}`;
  }

  label(tool: string, l: string): string {
    if (!this.on || !l) return l;
    return /^[A-Za-z]:[\\/]|^\//.test(l) ? this.path(l) : `${tool.toLowerCase()}#${shortHash(l)}`;
  }

  title(t: string | undefined, sessionId: string): string {
    if (this.on || !t) return sessionId.slice(0, 8);
    return t;
  }
}

/** Markdown table cell: no pipes or newlines. */
export function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const SPARK = '▁▂▃▄▅▆▇█';

export function sparkline(values: number[], width = 40, max = Math.max(...values, 1)): string {
  if (values.length === 0) return '';
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    const from = Math.floor((i * values.length) / width);
    const to = Math.max(from + 1, Math.floor(((i + 1) * values.length) / width));
    const slice = values.slice(from, to);
    if (slice.length === 0) continue;
    const v = Math.max(...slice);
    out.push(SPARK[Math.min(SPARK.length - 1, Math.floor((v / max) * SPARK.length))]!);
  }
  return out.join('');
}
