import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, MODULES, type ModuleName, type TokenTrimConfig } from './defaults.js';
import { mergeLayer } from './merge.js';

export { defaultConfig, MODULES, type ModuleName, type TokenTrimConfig } from './defaults.js';
export { mergeLayer } from './merge.js';

export interface LoadedConfig {
  config: TokenTrimConfig;
  warnings: string[];
  /** True when TOKENTRIM_DISABLE=1 turns everything off. */
  disabled: boolean;
}

export interface LoadOptions {
  projectDir?: string;
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

export function userConfigPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.tokentrim', 'config.json');
}

export function projectConfigPath(projectDir: string): string {
  return path.join(projectDir, 'tokentrim.config.json');
}

/** Merge order (later wins): defaults, user config, project config, environment. Never throws. */
export async function loadConfig(opts: LoadOptions = {}): Promise<LoadedConfig> {
  const warnings: string[] = [];
  let config = defaultConfig();
  config = mergeLayer(
    config,
    await readJson(userConfigPath(opts.homeDir), warnings),
    'user config',
    warnings,
  );
  if (opts.projectDir) {
    const p = projectConfigPath(opts.projectDir);
    config = mergeLayer(config, await readJson(p, warnings), 'project config', warnings);
  }
  return applyEnv(config, opts.env ?? process.env, warnings);
}

export function applyEnv(
  config: TokenTrimConfig,
  env: Record<string, string | undefined>,
  warnings: string[] = [],
): LoadedConfig {
  const disabled = env.TOKENTRIM_DISABLE === '1';
  const modules = { ...config.modules };
  for (const m of MODULES) {
    if (disabled || env[`TOKENTRIM_DISABLE_${m.toUpperCase()}`] === '1')
      modules[m as ModuleName] = false;
  }
  return { config: { ...config, modules }, warnings, disabled };
}

async function readJson(file: string, warnings: string[]): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined; // Missing file is normal.
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    warnings.push(`${file}: invalid JSON (${(e as Error).message}); using defaults for this layer`);
    return undefined;
  }
}
export { setModule, isModuleName, ConfigWriteError } from './write.js';
