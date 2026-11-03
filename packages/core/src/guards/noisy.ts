/**
 * Noisy-command patterns. Phase 3's guard denies these once; the analyzer uses the same list to estimate what
 * the guard would have caught in past sessions.
 */
export interface NoisyPattern {
  id: string;
  test: RegExp;
  suggestion: string;
}

export const NOISY_PATTERNS: NoisyPattern[] = [
  {
    id: 'install-verbose',
    test: /\b(npm|pnpm|yarn)\s+(install|i|ci|add)\b(?!.*(--silent|--quiet|-s\b|--loglevel|--reporter))/,
    suggestion: 'add --silent (npm) or --reporter=silent (pnpm), or pipe through `| tail -5`',
  },
  {
    id: 'full-test-suite',
    test: /\b((npm|pnpm|yarn)\s+(run\s+)?test|npx\s+(vitest|jest)(\s+run)?|vitest\s+run|jest|pytest|cargo\s+test|go\s+test\s+\.\/\.\.\.|dotnet\s+test)\s*$/,
    suggestion: 'run only the affected tests (pass a file or name filter) or show failures only',
  },
  {
    id: 'recursive-listing',
    test: /\bls\s+-[a-zA-Z]*R|^(?!.*\s-L\s*\d).*\btree\b|^(?!.*-maxdepth).*\bfind\s+\S+|^(?!.*-Depth).*Get-ChildItem\b.*-Recurse/,
    suggestion: 'limit depth (find -maxdepth 2, tree -L 2) or use Glob with a pattern',
  },
  {
    id: 'git-log-unbounded',
    test: /^(?!.*(\s-n\s*\d|\s-\d+\b|--max-count|--since|\s-L)).*\bgit\s+log\b/,
    suggestion: 'add -n 20 (and --oneline)',
  },
  {
    id: 'cat-file',
    test: /^\s*(cat|type|Get-Content)\s+[^|<>&;]+$/,
    suggestion: 'use Read with offset/limit, or head/sed -n to print a range',
  },
];

/** Output that is already piped through a limiter is never noisy. */
const LIMITED = /\|\s*(head|tail|grep|rg|wc|Select-Object|Select-String|less|more)\b/;

export function matchNoisyCommand(command: string, extra: string[] = []): NoisyPattern | undefined {
  if (LIMITED.test(command)) return undefined;
  // Only the last command of a chain produces the output that matters most; check each segment anyway.
  const segments = command
    .split(/&&|;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const patterns = [...NOISY_PATTERNS, ...compileExtra(extra)];
  for (const seg of segments) {
    const hit = patterns.find((p) => p.test.test(seg));
    if (hit) return hit;
  }
  return undefined;
}

function compileExtra(extra: string[]): NoisyPattern[] {
  const out: NoisyPattern[] = [];
  for (const [i, src] of extra.entries()) {
    try {
      out.push({
        id: `custom-${i + 1}`,
        test: new RegExp(src),
        suggestion: 'see your noisy_patterns_extra config',
      });
    } catch {
      // Invalid user regex: skip it rather than fail.
    }
  }
  return out;
}
