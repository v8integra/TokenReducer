import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  ConfigWriteError,
  isModuleName,
  loadConfig,
  MODULES,
  projectConfigPath,
  setModule,
} from '@tokentrim/core';
import type { Io } from './analyze.js';

export const CONFIG_USAGE = `tokentrim config [status | on <module> | off <module>] [--project <dir>]

Modules: ${MODULES.join(', ')}
`;

/** `status`, `on <module>`, `off <module>`. Used by the /tokentrim:tokentrim skill. */
export async function runConfig(argv: string[], io: Io): Promise<number> {
  const args = [...argv];
  let projectDir = process.cwd();
  const p = args.indexOf('--project');
  if (p >= 0) {
    const v = args[p + 1];
    if (!v) {
      io.log(CONFIG_USAGE);
      return 2;
    }
    projectDir = path.resolve(v);
    args.splice(p, 2);
  }
  const [action = 'status', module] = args.map((a) => a.toLowerCase());

  if (action === 'on' || action === 'off') {
    if (!module || !isModuleName(module)) {
      io.log(`Unknown module "${module ?? ''}". Modules: ${MODULES.join(', ')}.`);
      return 2;
    }
    try {
      const file = await setModule(projectDir, module, action === 'on');
      io.log(`Turned ${module} ${action} in ${file}.\n`);
    } catch (e) {
      if (e instanceof ConfigWriteError) {
        io.log(e.message);
        return 1;
      }
      throw e;
    }
  } else if (action !== 'status') {
    io.log(CONFIG_USAGE);
    return 2;
  }

  const { config, warnings, disabled } = await loadConfig({ projectDir });
  const file = projectConfigPath(projectDir);
  const lines = [`TokenTrim for ${projectDir}`, ''];
  for (const m of MODULES) lines.push(`  ${m.padEnd(11)} ${config.modules[m] ? 'on' : 'off'}`);
  lines.push('', `Project config: ${existsSync(file) ? file : 'none (defaults)'}`);
  if (disabled) lines.push('TOKENTRIM_DISABLE=1 is set, so every module is off.');
  for (const w of warnings) lines.push(`Warning: ${w}`);
  io.log(lines.join('\n'));
  return 0;
}
