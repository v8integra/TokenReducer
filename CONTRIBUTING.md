# Contributing

1. Node 22+ and npm for development (the bundled CLI and hooks run on Node 18+). Run `npm install`.
2. `npm run check` must pass: TypeScript strict, ESLint, Prettier, Vitest.
3. Logic goes in `packages/core` with unit tests. Adapters (CLI, hooks) stay thin.
4. Cross-platform rules: no shell scripts in hooks, `path`/`os` APIs only, compare paths with `samePath`,
   normalize CRLF before hashing.
5. Never put real transcript contents in fixtures. Use `node scripts/make-fixture.mjs <in> <out>` to make a
   redacted one, check it, then commit it. Synthetic transcripts can be built with
   `packages/core/test/builder.ts`.
6. Record any deviation from the plan in `docs/DECISIONS.md` and add a line to `CHANGELOG.md`.
