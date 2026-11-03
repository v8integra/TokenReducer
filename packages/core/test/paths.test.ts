import { describe, expect, it } from 'vitest';
import {
  contentHash,
  encodeProjectDir,
  matchNoisyCommand,
  pathKey,
  samePath,
} from '../src/index.js';

describe('paths', () => {
  it('compares Windows paths case- and separator-insensitively', () => {
    expect(samePath('C:\\Users\\Dev\\A.ts', 'c:/users/dev/a.ts', 'win32')).toBe(true);
    expect(samePath('C:\\Users\\Dev\\A.ts\\', 'C:\\Users\\Dev\\A.ts', 'win32')).toBe(true);
  });

  it('is case-insensitive on macOS and case-sensitive on Linux', () => {
    expect(samePath('/Users/dev/A.ts', '/users/dev/a.ts', 'darwin')).toBe(true);
    expect(samePath('/home/dev/A.ts', '/home/dev/a.ts', 'linux')).toBe(false);
    expect(samePath('/home/dev/./x/../a.ts', '/home/dev/a.ts', 'linux')).toBe(true);
  });

  it('normalizes drive-letter paths even when not on Windows', () => {
    expect(pathKey('C:\\a\\b', 'linux')).toBe('C:/a/b');
  });

  it('encodes a cwd the way Claude Code names its project folders', () => {
    expect(encodeProjectDir('C:\\Users\\Raven\\Desktop\\Projects\\LocalAI')).toBe(
      'C--Users-Raven-Desktop-Projects-LocalAI',
    );
    expect(encodeProjectDir('/home/me/my.app')).toBe('-home-me-my-app');
  });

  it('hashes CRLF and LF content identically', () => {
    expect(contentHash('a\r\nb\r\n')).toBe(contentHash('a\nb\n'));
  });
});

describe('noisy commands', () => {
  it.each([
    ['npm install', 'install-verbose'],
    ['pnpm i', 'install-verbose'],
    ['npm test', 'full-test-suite'],
    ['npx vitest run', 'full-test-suite'],
    ['cd app && pytest', 'full-test-suite'],
    ['ls -laR', 'recursive-listing'],
    ['find . -name "*.ts"', 'recursive-listing'],
    ['tree', 'recursive-listing'],
    ['git log', 'git-log-unbounded'],
    ['git log --stat', 'git-log-unbounded'],
    ['cat src/big.ts', 'cat-file'],
  ])('flags %s', (cmd, id) => {
    expect(matchNoisyCommand(cmd)?.id).toBe(id);
  });

  it.each([
    'npm install --silent',
    'npm test -- parser',
    'npx vitest run packages/core',
    'find . -maxdepth 2 -name "*.ts"',
    'tree -L 2',
    'git log -n 10 --oneline',
    'git log --oneline -5',
    'npm test | tail -20',
    'cat a.txt | grep foo',
    'git status',
  ])('leaves %s alone', (cmd) => {
    expect(matchNoisyCommand(cmd)).toBeUndefined();
  });

  it('supports extra patterns and ignores invalid ones', () => {
    expect(matchNoisyCommand('make all', ['^make\\b', '(['])?.id).toBe('custom-1');
  });
});
