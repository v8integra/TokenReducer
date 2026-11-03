// Bundles each entry point into a single self-contained file so users never run npm install.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  logLevel: 'info',
};

await build({
  ...common,
  // setup-statusline copies statusline.js from beside the CLI, so the CLI dist carries it too.
  entryPoints: {
    tokentrim: 'packages/cli/src/main.ts',
    statusline: 'packages/plugin-claude-code/src/statusline-main.ts',
  },
  outdir: 'packages/cli/dist',
  banner: { js: '#!/usr/bin/env node' },
});

// The plugin ships its own copies, so an installed plugin folder is self-contained.
await build({
  ...common,
  entryPoints: {
    hook: 'packages/plugin-claude-code/src/hook-main.ts',
    statusline: 'packages/plugin-claude-code/src/statusline-main.ts',
    tokentrim: 'packages/cli/src/main.ts',
  },
  outdir: 'packages/plugin-claude-code/dist',
});
