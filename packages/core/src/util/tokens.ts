/**
 * Transcripts don't record per-item token counts, only per-request usage. We estimate item sizes from
 * characters and then reconcile against the real usage numbers (see accounting). ~3.7 chars/token is
 * a middle ground between English prose (~4) and code/JSON (~3.3).
 */
export const CHARS_PER_TOKEN = 3.7;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n');
}
