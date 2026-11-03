# Changelog

## Unreleased

### Phase 2e: keynotes

- `core/keynotes`: deterministic Facts (files changed, notable commands, open errors, to-dos, last prompts, branch),
  rendering and the 1,500-token cap; `core/store` for shared state and keynotes files.
- Hooks: Stop and PreCompact refresh Facts; SessionEnd(clear) links to the next session; SessionStart injects
  keynotes once after /clear or compaction.
- `/tokentrim:checkpoint` skill and `tokentrim keynotes refresh | show`.

### Phase 2d: meter

- `core/meter`: status line text and green/yellow/red band from context, budget, break-even, boundary signals and
  cache state; `advisor.context_budget` and `advisor.boundary_signals` settings.
- Status line script (`dist/statusline.js`, 13 KB) that chains any existing status line.
- `tokentrim setup-statusline [--dry-run | --yes | --remove]` and the `/tokentrim:setup-statusline` skill.

### Phase 2c: plugin skeleton

- `packages/plugin-claude-code`: manifest, `hooks/hooks.json` (SessionStart, Stop), one fail-open hook bundle,
  `/tokentrim:tokentrim [status | on <module> | off <module>]` as a zero-overhead skill.
- `core/live`: incremental per-session metrics (context, cost, cache hit, break-even, last turn's boundary
  signals) that the Stop hook keeps in `.tokentrim/state/`.
- `tokentrim config` CLI command; `core/config` can toggle a module in the project config.
- Hook contract and fail-open tests run the real bundle.

### Phase 2a: policy simulation

- `core/boundaries`: per-turn task-boundary signals (to-dos done, commit, tests green after red, wrap-up wording,
  closed-out turn).
- `core/simulate`: replays sessions under clear/compact/idle policies; `tokentrim analyze --simulate` adds a policy
  table to every report.
- Defaults for the advisor chosen from the results (`docs/DECISIONS.md` D12).

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
