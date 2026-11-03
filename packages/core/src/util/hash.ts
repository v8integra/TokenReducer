import { createHash } from 'node:crypto';
import { normalizeNewlines } from './tokens.js';

/** Content hash with CRLF normalized, so the same file hashes equally on every OS. */
export function contentHash(s: string): string {
  return createHash('sha1').update(normalizeNewlines(s)).digest('hex').slice(0, 16);
}

export function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 10);
}
