import { readFile, writeFile } from 'node:fs/promises';
import { MODULES, type ModuleName } from './defaults.js';
import { projectConfigPath } from './index.js';

export class ConfigWriteError extends Error {}

export function isModuleName(v: string): v is ModuleName {
  return (MODULES as readonly string[]).includes(v);
}

/**
 * Turns one module on or off in `<project>/tokentrim.config.json`, creating the file if needed and keeping
 * every other key. This is the only place TokenTrim edits a user file (plan §8, rule 5). A file that isn't
 * valid JSON is never overwritten.
 */
export async function setModule(
  projectDir: string,
  module: ModuleName,
  on: boolean,
): Promise<string> {
  const file = projectConfigPath(projectDir);
  let doc: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    // No project config yet.
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      throw new ConfigWriteError(
        `${file} isn't valid JSON, so it was left alone. Fix it and try again.`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new ConfigWriteError(`${file} must contain a JSON object, so it was left alone.`);
    doc = parsed as Record<string, unknown>;
  }
  const modules =
    typeof doc.modules === 'object' && doc.modules !== null && !Array.isArray(doc.modules)
      ? (doc.modules as Record<string, unknown>)
      : {};
  doc.modules = { ...modules, [module]: on };
  await writeFile(file, JSON.stringify(doc, null, 2) + '\n');
  return file;
}
