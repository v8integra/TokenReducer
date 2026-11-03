# Architecture

```
packages/
  core/   pure logic, no Claude Code adapter code
    transcript/   streaming JSONL parser → requests, tool calls, prompts, compactions
    accounting/   per-session analysis: cost split, cache behaviour, clear points, guard simulation
    breakeven/    clear-vs-continue math (plan §6)
    pricing/      price ratios, weighted cost, context window
    config/       defaults, validated layered merge, env overrides
    guards/       noisy-command patterns (shared by the analyzer now, the guard hook in Phase 3)
    util/         paths (samePath, project-dir encoding), hashing, token estimates
  cli/    `tokentrim` command; report rendering (Markdown, HTML, JSON)
```

Later phases add `plugin-claude-code` (hooks, commands, status line) and `nav-mcp` next to these. Both stay thin
and call into `core`.

## Data flow for `tokentrim analyze`

1. `discover` lists `~/.claude/projects/<encoded cwd>/*.jsonl` (or `--transcripts <dir>`).
2. `TranscriptParser` streams each file line by line and keeps only sizes, hashes and a few input fields
   (paths, commands, ranges). Full contents never reach memory as a whole, so 80 MB transcripts are fine.
3. `analyzeSession` walks the requests in order and tracks what is in context, resetting at compactions. It
   produces cost by category, the context curve with break-even per request, clear points, cache rebuilds,
   biggest tool results, repeated reads and simulated guard savings.
4. The CLI filters (date, target project, last N), groups (`--by-target`), aggregates and renders. The HTML
   report converts the Markdown report for its tables, so the two formats can't disagree.

## Rules

- `core` has no side effects beyond reading the files it's given. Everything in it is unit-tested.
- Paths are compared through `pathKey` / `samePath` only (case-insensitive on Windows and macOS).
- Reports never include file contents. `--redact` hashes paths, commands and titles.
