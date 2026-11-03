# Changelog

## Unreleased

### Phase 1: core + analyzer

- `core/transcript`: streaming parser for Claude Code JSONL transcripts (merges split assistant entries,
  tolerates malformed lines, reads subagent transcripts).
- `core/accounting`: per-session analysis covering cost by category, context curve, clear points, cache
  rebuilds, biggest tool results, repeated reads, simulated guard savings, and inferred target project.
- `core/breakeven`: clear-vs-continue math, with the plan §6 table as tests.
- `core/pricing`, `core/config` (layered, validated, never throws), `core/guards/noisy` patterns.
- `tokentrim analyze`: Markdown, self-contained HTML (charts, dark mode) and JSON reports; `--by-target`,
  `--target`, `--last`, `--since/--until`, `--session`, `--redact`.
- Baseline numbers from the author's sessions in `docs/BASELINE.md`.

### Phase 0: scaffolding

- npm workspaces monorepo, TypeScript strict, ESLint, Prettier, Vitest, esbuild bundling.
- CI on Windows, macOS and Ubuntu: full checks on Node 22 and 24, bundled CLI smoke-tested on Node 18.
- Fixture redaction script, synthetic transcript builder, MIT license, contributing guide.
