import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CHARS_PER_TOKEN,
  latestKeynotesPath,
  loadConfig,
  refreshSession,
  sessionKeynotesPath,
} from '@tokentrim/core';
import type { Io } from './analyze.js';

export const KEYNOTES_USAGE = `tokentrim keynotes refresh --session <id> [--project <dir>]
tokentrim keynotes show [--session <id>] [--project <dir>]

refresh  bring a session's keynotes Facts up to date and print where the file is
show     print a session's keynotes (default: the latest in the project)
`;

/** Used by the /tokentrim:checkpoint skill, which then has Claude edit the Summary in the printed file. */
export async function runKeynotes(argv: string[], io: Io): Promise<number> {
  const [action, ...rest] = argv;
  let projectDir = process.cwd();
  let sessionId: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--project' && rest[i + 1]) projectDir = path.resolve(rest[++i]!);
    else if (rest[i] === '--session' && rest[i + 1]) sessionId = rest[++i];
    else {
      io.log(KEYNOTES_USAGE);
      return 2;
    }
  }
  const { config } = await loadConfig({ projectDir });

  if (action === 'refresh') {
    if (!sessionId) {
      io.log(KEYNOTES_USAGE);
      return 2;
    }
    if (!config.modules.checkpoint) {
      io.log(
        'The checkpoint module is off for this project. Turn it on with: tokentrim config on checkpoint',
      );
      return 1;
    }
    await refreshSession(projectDir, sessionId, undefined, config);
    const file = sessionKeynotesPath(projectDir, sessionId);
    const size = Math.ceil((await readFile(file, 'utf8')).length / CHARS_PER_TOKEN);
    io.log(
      [
        `Keynotes file: ${file}`,
        `Size: ~${size} tokens (cap ${config.checkpoint.max_tokens}).`,
        'The Facts section is regenerated after every turn; only the Summary section is kept as written.',
      ].join('\n'),
    );
    return 0;
  }

  if (action === 'show') {
    const file = sessionId
      ? sessionKeynotesPath(projectDir, sessionId)
      : latestKeynotesPath(projectDir);
    if (!existsSync(file)) {
      io.log('No keynotes yet for this project.');
      return 1;
    }
    io.log(await readFile(file, 'utf8'));
    return 0;
  }

  io.log(KEYNOTES_USAGE);
  return 2;
}
