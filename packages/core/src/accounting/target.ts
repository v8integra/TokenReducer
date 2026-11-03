import path from 'node:path';
import type { ParsedSession } from '../transcript/types.js';
import { pathKey } from '../util/paths.js';

const ABS_PATH = /(?:[A-Za-z]:[\\/]|\/(?:Users|home|c|mnt)\/)[^\s"'`|<>;,)]+/g;

/**
 * Works out which project a session was really about. Usually that is the cwd itself, but people often launch
 * Claude Code from one folder and work in a sibling (e.g. sessions started in LocalAI that build FluxChunk).
 * Each tool call votes once for every folder (one level below the cwd's parent) that its paths point into.
 */
export function inferTargetProject(s: ParsedSession): string {
  const cwd = s.cwd;
  if (!cwd) return 'unknown';
  const p = /^[A-Za-z]:[\\/]/.test(cwd) ? path.win32 : path.posix;
  const parent = pathKey(p.dirname(cwd)) + '/';
  const votes = new Map<string, { name: string; n: number }>();

  const folderOf = (raw: string): string | undefined => {
    // Git Bash style /c/Users/... → C:/Users/...
    const norm = raw.replace(/^\/([a-z])\//i, '$1:/').replace(/\\/g, '/');
    if (!pathKey(norm).startsWith(parent)) return undefined;
    return norm.slice(parent.length).split('/')[0] || undefined;
  };

  for (const t of s.toolCalls) {
    const raws = [t.input.file_path, t.input.path].filter((r): r is string => !!r);
    for (const m of t.input.command?.matchAll(ABS_PATH) ?? []) raws.push(m[0]);
    const folders = new Map<string, string>();
    for (const raw of raws) {
      const name = folderOf(raw);
      if (name) folders.set(name.toLowerCase(), name);
    }
    for (const [k, name] of folders) {
      const v = votes.get(k) ?? { name, n: 0 };
      v.n++;
      votes.set(k, v);
    }
  }
  let best: { name: string; n: number } | undefined;
  for (const v of votes.values()) if (!best || v.n > best.n) best = v;
  return best && best.n >= 3 ? best.name : p.basename(cwd);
}
