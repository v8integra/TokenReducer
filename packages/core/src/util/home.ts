import os from 'node:os';
import path from 'node:path';

/** `~/.tokentrim/`: global state and logs (plan §3). */
export function tokentrimHome(home = os.homedir()): string {
  return path.join(home, '.tokentrim');
}

/** Stable copy of the status line script, so settings.json survives plugin updates moving the plugin folder. */
export function statuslineBinPath(home = os.homedir()): string {
  return path.join(tokentrimHome(home), 'bin', 'statusline.js');
}

/** The status line command that was there before ours, which ours runs first (chaining). */
export function statuslineChainPath(home = os.homedir()): string {
  return path.join(tokentrimHome(home), 'statusline-chain.json');
}

export interface StatuslineChain {
  /** The previous `statusLine` object from settings.json, restored by `setup-statusline --remove`. */
  previous: { type?: string; command?: string; padding?: number; [k: string]: unknown } | null;
  installedAt: string;
}

/** True for the command `setup-statusline` writes, whatever the slashes. */
export function isOurCommand(cmd: string): boolean {
  return /\.tokentrim[\\/]+bin[\\/]+statusline\.js/.test(cmd);
}
