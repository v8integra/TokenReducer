// Bundles each entry point into a single self-contained file so users never run npm install.
import { build } from 'esbuild';

await build({
  entryPoints: { tokentrim: 'packages/cli/src/main.ts' },
  outdir: 'packages/cli/dist',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
