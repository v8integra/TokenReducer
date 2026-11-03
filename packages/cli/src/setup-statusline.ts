import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  isOurCommand,
  statuslineBinPath,
  statuslineChainPath,
  type StatuslineChain,
} from '@tokentrim/core';
import type { Io } from './analyze.js';

export const SETUP_USAGE = `tokentrim setup-statusline [--dry-run | --yes | --remove] [--settings <file>]

Adds the TokenTrim meter to Claude Code's status line in your user settings.
Your current status line, if any, keeps running: its output is shown above the meter.
A backup of settings.json is made before any change.

  --dry-run          show what would change and stop
  --yes              apply without asking
  --remove           restore the previous status line
  --settings <file>  settings file to edit (default: ~/.claude/settings.json)
`;

interface Opts {
  dryRun: boolean;
  yes: boolean;
  remove: boolean;
  settings: string;
  home: string;
  /** Where the built statusline.js lives (beside this CLI bundle by default). */
  source: string;
  /** Asks a yes/no question; defaults to a terminal prompt. */
  confirm?: (q: string) => Promise<boolean>;
}

export function defaultSettingsPath(home = os.homedir()): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'settings.json');
}

/** Forward slashes on every OS: Git Bash on Windows drops unquoted backslashes. */
export function meterCommand(home = os.homedir()): string {
  return `node "${statuslineBinPath(home).replace(/\\/g, '/')}"`;
}

export function parseSetupArgs(argv: string[], home = os.homedir()): Opts | string {
  const o: Opts = {
    dryRun: false,
    yes: false,
    remove: false,
    settings: defaultSettingsPath(home),
    home,
    source: path.join(path.dirname(fileURLToPath(import.meta.url)), 'statusline.js'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--remove') o.remove = true;
    else if (a === '--settings' && argv[i + 1]) o.settings = path.resolve(argv[++i]!);
    else return `Unknown option ${a}.\n\n${SETUP_USAGE}`;
  }
  return o;
}

async function readSettings(file: string): Promise<Record<string, unknown>> {
  if (!existsSync(file)) return {};
  const text = await readFile(file, 'utf8');
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${file} isn't valid JSON, so it was left alone.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${file} doesn't contain a JSON object, so it was left alone.`);
  return parsed as Record<string, unknown>;
}

async function backup(file: string): Promise<string | null> {
  if (!existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const dest = `${file}.tokentrim-backup-${stamp}`;
  await copyFile(file, dest);
  return dest;
}

async function ask(q: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export async function runSetupStatusline(o: Opts, io: Io): Promise<number> {
  let settings: Record<string, unknown>;
  try {
    settings = await readSettings(o.settings);
  } catch (e) {
    io.log((e as Error).message);
    return 1;
  }
  const current = settings.statusLine as StatuslineChain['previous'] | undefined;
  const currentCmd = typeof current?.command === 'string' ? current.command : undefined;
  const ours = !!currentCmd && isOurCommand(currentCmd);
  const bin = statuslineBinPath(o.home);
  const chainFile = statuslineChainPath(o.home);

  if (o.remove) {
    if (!ours) {
      io.log('The TokenTrim meter is not in your status line; nothing to remove.');
      return 0;
    }
    let previous: StatuslineChain['previous'] = null;
    try {
      previous = (JSON.parse(await readFile(chainFile, 'utf8')) as StatuslineChain).previous;
    } catch {
      // No chain recorded: there was no status line before.
    }
    const plan = previous?.command
      ? `Restore your previous status line: ${previous.command}`
      : 'Remove the status line setting (there was none before TokenTrim).';
    if (!(await approve(o, io, `${plan}\nSettings file: ${o.settings}`))) return o.dryRun ? 0 : 1;
    const saved = await backup(o.settings);
    if (previous) settings.statusLine = previous;
    else delete settings.statusLine;
    await writeFile(o.settings, JSON.stringify(settings, null, 2) + '\n');
    await rm(chainFile, { force: true });
    io.log(`Done.${saved ? ` Backup: ${saved}` : ''}`);
    return 0;
  }

  if (!existsSync(o.source)) {
    io.log(`Can't find the status line script at ${o.source}. Run "npm run build" first.`);
    return 1;
  }
  if (ours) {
    // Already set up: only refresh the script copy, never touch settings or the chain.
    await mkdir(path.dirname(bin), { recursive: true });
    if (!o.dryRun) await copyFile(o.source, bin);
    io.log(
      `The TokenTrim meter is already in your status line.${o.dryRun ? '' : ' Script updated.'}`,
    );
    return 0;
  }

  const command = meterCommand(o.home);
  const lines = [
    `Settings file: ${o.settings}`,
    `New status line: ${command}`,
    currentCmd
      ? `Your current status line keeps running, shown above the meter: ${currentCmd}`
      : 'You have no status line yet.',
    existsSync(o.settings)
      ? 'A backup of the settings file is made first.'
      : 'The settings file will be created.',
    `Undo any time with: tokentrim setup-statusline --remove`,
  ];
  if (!(await approve(o, io, lines.join('\n')))) return o.dryRun ? 0 : 1;

  await mkdir(path.dirname(bin), { recursive: true });
  await copyFile(o.source, bin);
  const chain: StatuslineChain = {
    previous: current ?? null,
    installedAt: new Date().toISOString(),
  };
  await writeFile(chainFile, JSON.stringify(chain, null, 2) + '\n');
  const saved = await backup(o.settings);
  settings.statusLine = {
    type: 'command',
    command,
    ...(typeof current?.padding === 'number' ? { padding: current.padding } : {}),
  };
  await mkdir(path.dirname(o.settings), { recursive: true });
  await writeFile(o.settings, JSON.stringify(settings, null, 2) + '\n');
  io.log(
    `Done. The meter shows from the next status line update.${saved ? ` Backup: ${saved}` : ''}`,
  );
  return 0;
}

/** Prints the plan; applies only with --yes or a yes at the terminal (plan §5.1: "only after asking"). */
async function approve(o: Opts, io: Io, plan: string): Promise<boolean> {
  io.log(plan);
  if (o.dryRun) {
    io.log('\nDry run: nothing changed.');
    return false;
  }
  if (o.yes) return true;
  if (o.confirm) return o.confirm('Apply this change?');
  if (!process.stdin.isTTY) {
    io.log('\nNothing changed. Re-run with --yes to apply.');
    return false;
  }
  const ok = await ask('\nApply this change?');
  if (!ok) io.log('Nothing changed.');
  return ok;
}
