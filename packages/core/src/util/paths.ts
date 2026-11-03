import path from 'node:path';

/** Whether this platform compares paths case-insensitively by default (Windows, macOS). */
export function caseInsensitivePaths(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** Normalizes a path for comparison: resolves separators, trims trailing slashes, folds case where the OS does. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const isWin = platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(p);
  let out = isWin ? path.win32.normalize(p).replace(/\\/g, '/') : path.posix.normalize(p);
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return caseInsensitivePaths(platform) ? out.toLowerCase() : out;
}

export function samePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/** Claude Code stores a project's transcripts under a folder named after the cwd with every non-alphanumeric char replaced by '-'. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
