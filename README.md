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
| `--simulate`                       | Estimate what clear/compact policies would have saved on these sessions                                                      |

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

## Try the plugin (development build)

The plugin keeps live per-session metrics, shows them as a status line meter, and keeps keynotes that survive `/clear`. The advisor is next.

```bash
npm run build
claude plugin marketplace add ./
claude plugin install tokentrim@tokentrim-dev
```

Run those from this folder, then start a new session (terminal or desktop app). The local marketplace loads the
plugin in place, so after code changes `npm run build` and a new session are enough. For a one-off terminal session
without installing, `claude --plugin-dir ./packages/plugin-claude-code` also works; the desktop app needs the
install.

Run `/tokentrim:setup-statusline` to add the meter to your status line (it shows the change and asks first;
your current status line keeps running above it). It looks like:

```
● 142K ctx · next req ≈14K · clear pays off in 3 req · cache 38m · $4.10 → good moment to /clear
```

Before a `/clear`, run `/tokentrim:checkpoint`: Claude writes a short Summary (decisions, current task, next steps)
into `.tokentrim/keynotes/`, next to Facts TokenTrim collects automatically (files changed, recent test/build
results, open errors, to-dos). The new session starts with them, capped at 1,500 tokens.

`/tokentrim:tokentrim status` shows which modules are on, and `/tokentrim:tokentrim off <module>` turns
one off for the current project. Metrics land in `<project>/.tokentrim/state/`; add `.tokentrim/` to your
`.gitignore`. Hooks fail open: if anything goes wrong they exit quietly and log to `~/.tokentrim/logs/`.

## Development

```bash
npm run check   # typecheck, lint, format check, tests
npm run build   # bundle the CLI with esbuild
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DECISIONS.md](docs/DECISIONS.md) and
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
