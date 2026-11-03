import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEnv, defaultConfig, loadConfig, mergeLayer } from '../src/index.js';

describe('config merge', () => {
  it('overrides known keys and keeps the rest', () => {
    const w: string[] = [];
    const c = mergeLayer(
      defaultConfig(),
      { guards: { large_file_lines: 400 }, modules: { nav: false } },
      'test',
      w,
    );
    expect(c.guards.large_file_lines).toBe(400);
    expect(c.guards.duplicate_read).toBe(true);
    expect(c.modules.nav).toBe(false);
    expect(c.modules.meter).toBe(true);
    expect(w).toEqual([]);
  });

  it('skips unknown keys and wrong types with a warning', () => {
    const w: string[] = [];
    const c = mergeLayer(
      defaultConfig(),
      {
        $schema: 'x',
        bogus: 1,
        idle: { cache_ttl_minutes: 'five', min_context: -1 },
        guards: { noisy_patterns_extra: [1] },
      },
      'test',
      w,
    );
    expect(c.idle.cache_ttl_minutes).toBe(5);
    expect(c.idle.min_context).toBe(40_000);
    expect(c.guards.noisy_patterns_extra).toEqual([]);
    expect(w).toHaveLength(4);
    expect(w.join('\n')).toContain('bogus');
  });

  it('accepts a number or null for the optional dollar price', () => {
    const w: string[] = [];
    let c = mergeLayer(defaultConfig(), { pricing: { usd_per_mtok_input: 3 } }, 'a', w);
    expect(c.pricing.usd_per_mtok_input).toBe(3);
    c = mergeLayer(c, { pricing: { usd_per_mtok_input: null } }, 'b', w);
    expect(c.pricing.usd_per_mtok_input).toBeNull();
    expect(w).toEqual([]);
  });

  it('ignores a non-object layer', () => {
    const w: string[] = [];
    expect(mergeLayer(defaultConfig(), [1, 2], 'test', w)).toEqual(defaultConfig());
    expect(w).toHaveLength(1);
  });
});

describe('environment', () => {
  it('TOKENTRIM_DISABLE turns everything off', () => {
    const r = applyEnv(defaultConfig(), { TOKENTRIM_DISABLE: '1' });
    expect(r.disabled).toBe(true);
    expect(Object.values(r.config.modules).every((v) => v === false)).toBe(true);
  });

  it('TOKENTRIM_DISABLE_<MODULE> turns one module off', () => {
    const r = applyEnv(defaultConfig(), { TOKENTRIM_DISABLE_GUARDS: '1' });
    expect(r.config.modules.guards).toBe(false);
    expect(r.config.modules.meter).toBe(true);
  });
});

describe('loadConfig', () => {
  it('merges user then project config and never throws on bad JSON', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'tt-home-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'tt-proj-'));
    await mkdir(path.join(home, '.tokentrim'));
    await writeFile(
      path.join(home, '.tokentrim', 'config.json'),
      '﻿{"advisor":{"max_breakeven_turns":6},"idle":{"min_context":1}}',
    );
    await writeFile(path.join(project, 'tokentrim.config.json'), '{"idle":{"min_context":2}}');
    const r = await loadConfig({ homeDir: home, projectDir: project, env: {} });
    expect(r.config.advisor.max_breakeven_turns).toBe(6);
    expect(r.config.idle.min_context).toBe(2);
    expect(r.warnings).toEqual([]);

    await writeFile(path.join(project, 'tokentrim.config.json'), '{ not json');
    const bad = await loadConfig({ homeDir: home, projectDir: project, env: {} });
    expect(bad.config.idle.min_context).toBe(1);
    expect(bad.warnings[0]).toContain('invalid JSON');
  });

  it('works with no config files at all', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'tt-empty-'));
    const r = await loadConfig({ homeDir: empty, projectDir: empty, env: {} });
    expect(r.config).toEqual(defaultConfig());
  });
});
