# TokenTrim

Measure and cut wasted tokens in Claude Code sessions. Working name.

> **Status:** Phase 1 of the [build plan](TOKENTRIM_PLAN.md). The analyzer works. The plugin (status line
> meter, keynotes, advisor, guards, navigation) comes in later phases.

**Requires Node 18 or newer.**

## Analyze your sessions

```bash
npm install
npm run build
node packages/cli/dist/tokentrim.js analyze --project /path/to/your/project --html
```

This reads that project's Claude Code transcripts from `~/.claude/projects/` and writes a Markdown report (plus
HTML with charts) to `<project>/.tokentrim/reports/`. Nothing leaves your machine.

Useful options:

| Option                             | What it does                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `--by-target`                      | One report per project the sessions actually worked in (useful if you launch Claude Code from one folder and work in others) |
| `--target <name>`                  | Only sessions that mostly worked in that project                                                                             |
| `--last <n>`, `--since`, `--until` | Narrow the sessions                                                                                                          |
| `--session <id>`                   | One session                                                                                                                  |
| `--redact`                         | Hash paths, commands and titles before sharing a report                                                                      |
| `--json`                           | Also write the raw analysis                                                                                                  |

## What the report shows

- **Cost in input-token equivalents (ITE).** One uncached input token is 1, a cache read 0.1, a cache write
  1.25, an output token 5. That works for any model. Set `pricing.usd_per_mtok_input` to also see dollars.
- **Where the cost goes:** by billing component, and by what was sitting in context (fixed overhead, thinking,
  tool results by tool, edits, prompts).
- **Clear vs. continue:** the first point in each session segment where `/clear` would have paid for itself
  within a few requests, and an upper bound on what it would have saved.
- **Prompt cache:** idle gaps, cache rebuilds, and rebuilds that happened without an idle gap.
- **Biggest tool results** ranked by lifetime cost, **files read more than once**, and what the planned guards
  would have caught.

## Development

```bash
npm run check   # typecheck, lint, format check, tests
npm run build   # bundle the CLI with esbuild
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DECISIONS.md](docs/DECISIONS.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
