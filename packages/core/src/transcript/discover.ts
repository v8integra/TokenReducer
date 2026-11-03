import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encodeProjectDir } from '../util/paths.js';

export interface TranscriptFile {
  file: string;
  sessionId: string;
  mtime: number;
  size: number;
}

export function claudeProjectsDir(homeDir = os.homedir()): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homeDir, '.claude'), 'projects');
}

export function transcriptDirFor(projectCwd: string, projectsDir = claudeProjectsDir()): string {
  return path.join(projectsDir, encodeProjectDir(projectCwd));
}

/** Lists `*.jsonl` session transcripts in one Claude Code project folder, newest first. */
export async function listTranscripts(dir: string): Promise<TranscriptFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: TranscriptFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(dir, name);
    try {
      const st = await stat(file);
      if (st.isFile())
        out.push({ file, sessionId: name.slice(0, -6), mtime: st.mtimeMs, size: st.size });
    } catch {
      // Skip files that vanish or can't be read.
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
