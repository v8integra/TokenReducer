# TokenTrim — Build Plan

> Working name. Rename freely before the first public release.

## 1. What this is

TokenTrim is an open-source **Claude Code plugin + CLI** that cuts wasted tokens in AI coding sessions. It works on projects of any size and language, with any Claude model, on Windows, macOS and Linux.

It doesn't try to replace Claude Code's own behavior. It **measures** where tokens go, **prevents** common waste (duplicate reads, huge file reads, noisy commands), **preserves** working context across `/clear` and compaction through keynotes, and **advises** the user when clearing or compacting is cheaper than continuing.

**Goals**
- Lower total tokens per completed task, proven with a reproducible benchmark.
- Zero friction: one install, every module on by default, each module can be turned off.
- Never break a session. Every hook fails open.
- Cross-platform (Windows/macOS/Linux) and model-agnostic.
- Portfolio quality: clean architecture, tests, CI on 3 OSes, published benchmark results.

**Non-goals**
- Not a paid product.
- Not a full code knowledge graph like Graphify. The navigation module stays small and lazy.
- No auto-typing of `/clear` or `/compact`. Simulated keystrokes are fragile and platform-specific. Claude Code currently gives hooks and skills no API to run built-in commands.

**Process framing (for the README):** DMAIC. **Define** the waste, **Measure** with the analyzer, **Analyze** the reports, **Improve** with guards, checkpoints and advice, **Control** with the audit, status line meter and benchmark.

---

## 2. Background facts the design relies on

**Verify each of these against the current Claude Code docs before implementing.** Hook schemas change between versions. Where docs and this plan disagree, follow the docs and note the change in `docs/DECISIONS.md`.

- Every turn re-sends the whole conversation. Per-turn cost grows linearly with context size, so total session cost grows roughly quadratically.
- Fixed overhead (system prompt, tool schemas, MCP schemas, CLAUDE.md) is usually ~15–35K tokens before the first message.
- Prompt caching, in API price ratios: cache read ≈ 0.1× input, cache write ≈ 1.25× input, output ≈ 5× input (Sonnet/Opus tiers). Default cache TTL is ~5 minutes; some setups use 1 hour.
- Hook events used: `SessionStart` (sources: `startup`, `resume`, `clear`, `compact`), `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact` (`manual`/`auto`), possibly `PostCompact`.
- Hooks get JSON on stdin, including `session_id`, `transcript_path` and `cwd`. They can return JSON with:
  - `hookSpecificOutput.additionalContext` (SessionStart / UserPromptSubmit) to inject context
  - `permissionDecision: "deny"` plus a reason (PreToolUse) to block a tool call, with the reason shown to Claude
  - `systemMessage` to show a message to the user
  - exit code 2 on UserPromptSubmit to block a prompt (shows stderr to the user)
- Transcripts are JSONL files under `~/.claude/projects/<encoded-path>/<session>.jsonl`. Assistant entries contain `usage` with `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`.
- Plugin layout: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`, `commands/` or `skills/`, `bin/`. Use `${CLAUDE_PLUGIN_ROOT}` for paths. Plugin commands are namespaced, e.g. `/tokentrim:checkpoint`.
- The status line command receives session JSON on stdin, which may include context usage such as `used_percentage`. **Verify** whether a plugin can register a status line directly. If it can't, ship `tokentrim setup-statusline` (see §5.1).
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` exists but is unreliable (it can only lower the threshold, and settings.json `env` is ignored in some versions). Document it as optional. Do not depend on it.
- Installing any plugin shows a one-time trust warning. That's expected and fine. Hooks then run without prompts. Plugin MCP tools may get the normal first-use permission prompt.

---

## 3. Architecture

Monorepo, TypeScript, pnpm workspaces (npm workspaces is also fine).

```
tokentrim/
├─ packages/
│  ├─ core/                 # Pure TS, no Claude Code assumptions, no I/O side effects where possible
│  │  ├─ transcript/        # JSONL parser → normalized events (turns, tool calls, usage)
│  │  ├─ accounting/        # token category breakdown, cache hit ratio, growth rate
│  │  ├─ breakeven/         # clear-vs-continue math (§6)
│  │  ├─ keynotes/          # deterministic extraction + merge + render
│  │  ├─ guards/            # pure decision functions (input → allow/deny + reason)
│  │  ├─ config/            # schema, defaults, loader (user + project merge)
│  │  └─ pricing/           # price ratios + optional absolute prices per model family
│  ├─ plugin-claude-code/   # Adapter: hooks, commands, status line, packaging
│  │  ├─ .claude-plugin/plugin.json
│  │  ├─ hooks/hooks.json
│  │  ├─ commands/          # checkpoint.md, tokentrim.md (on/off/status), report.md
│  │  ├─ .mcp.json          # nav MCP server
│  │  └─ src/hooks/*.ts     # thin wrappers: read stdin → call core → write stdout
│  ├─ nav-mcp/              # MCP server: outline, find_symbol, read_symbol, callers
│  └─ cli/                  # `tokentrim analyze | audit | bench | setup-statusline | doctor`
├─ bench/                   # fixture repos + scripted tasks + runner
├─ docs/                    # ARCHITECTURE.md, DECISIONS.md, MODULES.md, BENCHMARKS.md
└─ .github/workflows/ci.yml # windows/macos/ubuntu matrix
```

**Rules**
- `core` contains all logic and is fully unit-tested. Adapters stay thin. This leaves room for future adapters (Codex, Cursor, Gemini CLI) without rewriting logic.
- Hooks are bundled with **esbuild** into single self-contained `.js` files under `plugin-claude-code/dist/`, so users never run `npm install`.
- State lives in `<project>/.tokentrim/` (keynotes, index, per-session state). Global state and logs go in `~/.tokentrim/`. Never write anywhere else.

---

## 4. Cross-platform rules (Windows, macOS, Linux)

- **No bash or PowerShell scripts.** Every hook command is `node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/<name>.js"`. Always quote the path, since Windows paths can contain spaces.
- Use `path`, `os.homedir()`, `os.tmpdir()`, and `fs` promises. Never hardcode `/` or `~`.
- Normalize CRLF → LF before hashing file contents.
- Path comparisons are case-insensitive on Windows and macOS (default), and case-sensitive on Linux. Centralize this in a `samePath()` helper.
- No native Node addons. Use **web-tree-sitter (WASM)** with bundled grammar `.wasm` files.
- Node 18+ is required. `tokentrim doctor` checks the Node version and plugin wiring. If Node is missing, hooks can't run and Claude Code continues normally. The README must say this up front.
- CI runs the full test suite plus a hook smoke test (pipe sample JSON into each bundled hook) on `windows-latest`, `macos-latest` and `ubuntu-latest`.

---

## 5. Modules

All modules are **on by default**. Each one can be turned off in config (§7) or with `/tokentrim:tokentrim off <module>`.

### 5.1 `meter` — status line
- Shows: context tokens and %, estimated session cost (ratio units, or $ if absolute pricing is configured), cache hit ratio, **turns until a clear pays off** (§6), and the **cost of the next request** (≈ `r_read × C`). On a 1M window, 45% full already means ~450K tokens re-read per request, so the bands key off absolute context against `advisor.context_budget` and break-even, never window % alone.
- Color bands: green / yellow / red, with configurable thresholds and defaults based on §6 and the context budget.
- At red, the text includes the recommended action, e.g. `⚠ 142K · clear pays off in ~3 turns · /tokentrim:checkpoint then /clear`.
- Data source: the `Stop` hook writes `.tokentrim/state/<session>.json`, and the status line script reads it plus its own stdin JSON. The status line script must be fast (<50 ms) and must never throw.
- If a plugin can't register a status line: `tokentrim setup-statusline` adds it to the user's settings **only after asking**, backs up the file, and **chains** any existing status line command instead of replacing it.

### 5.2 `checkpoint` — keynotes and context restore
- **Keynotes file:** `.tokentrim/keynotes.md`, plus an archive in `.tokentrim/keynotes/<timestamp>-<session>.md`.
- **Two sections:**
  1. **Facts (deterministic, no tokens spent):** extracted from the transcript by `core/keynotes`. Covers files created/edited, commands run with exit status, unresolved errors, the latest to-do list state, the user's last few requests (truncated), and the branch/commit if available.
  2. **Summary (model-written):** decisions and why, current task, next steps, gotchas. Written only when `/tokentrim:checkpoint` runs.
- **Size cap:** default 1,500 tokens. Older items get summarized or dropped first. Keynotes must stay small or they stop saving anything.
- **Hooks:**
  - `Stop` updates the Facts section incrementally (cheap, local file work only).
  - `PreCompact` (manual and auto) refreshes Facts before compaction.
  - `SessionStart` with source `clear`, `compact` or `resume` injects keynotes through `additionalContext`, **once**. On `startup`, inject only if `inject_on_startup` is true (default: false), and say so in the status line.
  - `SessionEnd` with reason `clear` makes a final Facts refresh and archives the file.
- **`/tokentrim:checkpoint` command:** tells Claude to update the Summary section concisely within the cap, then tells the user they can now `/clear`.
- **Never inject on every turn.** Per-turn injection stays in the history and compounds.

### 5.3 `advisor` — notices and recommendations
The baseline (docs/BASELINE.md) shows that **average context size is the cost**: 77% of spend is cache reads of a ~458K average context, because 1M-window sessions run to ~965K before auto-compacting. The advisor's job is to keep the average context small, at **every** task boundary, not once per session.

- Runs in `Stop` after metrics update. Uses §6 to decide when to recommend:
  - `/tokentrim:checkpoint` → `/clear` when break-even ≤ `advisor.max_breakeven_turns` (default 4) **and** a task boundary is detected (to-do list all completed, a `git commit` succeeded, tests passed after failures, or the user's last message reads as a wrap-up). Re-arms after every clear, so a long working day gets a recommendation at each boundary.
  - `/compact <focus>` when context passes `advisor.context_budget` (default 200K, tuned by the policy simulation in Phase 2) and the user is mid-task (no boundary detected). This replaces waiting for auto-compact near the window limit.
  - `/model` (switching to a cheaper model) **only** suggested right after a clear, because switching mid-session breaks the cache.
  - MCP/skill overhead recommendations move to the audit (§5.6), which runs between sessions.
- **Delivery:** `systemMessage` to the user, **once per threshold band crossing** (state tracked per session). Optionally (`advisor.tell_claude`, default true), also a one-time `additionalContext` line asking Claude to mention the recommendation in one sentence at the end of its reply.
- **Idle/cache-expiry check** (`UserPromptSubmit`): if time since the last `Stop` exceeds the cache TTL and context is above `idle.min_context` (default 40K), show a notice with both costs (`r_write × C` to continue vs. §6 one-time cost to clear). In the baseline, 46 of 47 cache rebuilds came after an idle gap and cost 6.1% extra. With `idle.block_once: true` (default **false**), block that prompt once with exit code 2 and a clear message. Re-sending the same prompt goes through.
- **Cache TTL is detected, not assumed.** `idle.cache_ttl_minutes` defaults to `"auto"`: the hook looks at the session's own history (idle gaps followed or not followed by a rebuild, §5.7) and uses 60 minutes when gaps over 5 minutes didn't rebuild, else 5. The baseline sessions use a 1-hour TTL; a fixed 5-minute default could have fired up to ~280 false notices (one per idle gap over 5 minutes).
- **Optional desktop notification** (`advisor.desktop_notify`, default false): native toast on Windows/macOS/Linux. Must be a lazy-loaded optional dependency that fails silently.

### 5.4 `guards` — waste prevention (PreToolUse)
Each guard is a pure function in `core/guards`. The hook wrapper handles state and I/O.

**Scope cut after the baseline.** Simulated on 7,497 real requests, the original three guards would have saved 0.5% in total: Claude Code already returns a stub for unchanged re-reads (duplicate reads: 0.2%) and caps large reads (large-file guard: 0 hits). Only the noisy-command guard showed up (0.3%, mostly `cat` of files). The guards ship small and off-by-default where they don't earn their keep:

- **Noisy commands** (`Bash`, on by default): `cat`/`type`/`Get-Content` of whole files, recursive `ls`/`find`/`tree` without a depth limit, `git log` without `-n`, unfiltered full test suites, installs without quiet flags. Patterns live in `core/guards/noisy.ts` (already shared with the analyzer). **Deny once** per command pattern per session, suggesting the quieter form. Commands already piped through `head`/`tail`/`grep`/`wc` are never denied.
- **Duplicate read** (`Read`, default **off**): kept as a fallback for Claude Code versions without built-in read dedup. Same rules as before (same path + range, unchanged hash, no clear/compact since).
- **Large file**: dropped. Revisit only if a future Claude Code version stops capping reads.
- **Large Write bodies** (measure first, no guard yet): tool-call inputs are 16.3% of baseline cost, because every `Write`/`Edit` body stays in context for the rest of the segment. The analyzer reports how much of that is `Write` over an *existing* file (where an `Edit` would carry far less). A guard is only built in a later phase if that slice is material, and even then it suggests rather than blocks.
- **Never** block `Edit`, `Write`, `MultiEdit` or anything destructive.
- Track guard hits, estimated tokens saved and false positives (a denial followed by the same command) in session state, so the analyzer reports real numbers instead of the simulation.

### 5.5 `nav` — lazy code navigation (MCP server)
- Tools (each kept to a short, tight schema to minimize MCP overhead):
  - `outline(path)`: exports, classes, functions and signatures with line ranges, no bodies.
  - `find_symbol(name)`: definition locations and signatures.
  - `read_symbol(name | path#symbol)`: only that symbol's source.
  - `callers(name)`: best-effort references (tree-sitter name matching; label results as approximate).
- web-tree-sitter grammars at launch: TypeScript/TSX, JavaScript, Python, C#, C++, Go, Rust, Java. Unsupported files fall back to line-range reads.
- The index is built lazily per file on first request and cached in `.tokentrim/index/` keyed by content hash. **No up-front report** gets loaded into context.
- Add 3–4 lines to the plugin's instructions telling Claude these tools exist and when to prefer them. Nothing longer.

### 5.6 `audit` — setup hygiene (`tokentrim audit` CLI and `/tokentrim:tokentrim audit`)
Reports, with estimated per-turn token cost and a suggested fix for each:
- CLAUDE.md files (all levels) over a size threshold
- MCP servers and their estimated schema size; servers unused across recent sessions
- Very large files in the repo that aren't covered by ignore or permission rules
- Things that break the cache mid-session (frequent CLAUDE.md edits, model switches seen in transcripts)

The audit is read-only and never changes user files.

### 5.7 `analyzer` — measurement (`tokentrim analyze`)
- Input: one session, all sessions for the current project, or a date range. Reads transcripts locally only.
- Output: a Markdown report and an optional self-contained HTML report with charts. Covers:
  - tokens by category (fixed overhead, conversation, tool output by tool, output)
  - cache read/write/miss ratio; cache-expiry events (gaps over the TTL)
  - top 10 biggest tool results; files read more than once
  - context growth curve per session, marking where a clear would have paid off (§6)
  - guard hits and estimated savings
- **Privacy:** report contents are aggregated by default. File paths are shown, file contents never are. A `--redact` flag hashes paths.

### 5.8 `bench` — proof (`tokentrim bench`)
- `bench/fixtures/`: 3 repos (small ~20 files, medium ~300, large ~2,000+, generated or vendored OSS with licenses respected).
- `bench/tasks/*.yaml`: scripted tasks (add a feature, fix a seeded bug, explain a module, refactor), each with an automated pass/fail check.
- The runner uses headless mode (`claude -p "<task>" --output-format json`) with the plugin enabled and disabled, N runs each (default 5). It records usage from the JSON result, task pass/fail and wall time.
- The report gives median and spread per task and condition, plus **tokens per successful task**. Publish the results in `docs/BENCHMARKS.md` and summarize them in the README. Report any regressions honestly.

---

## 6. Clear-vs-continue break-even math (`core/breakeven`)

All values are in "input-token equivalents" using price ratios, so the math works for any model. Ratios are configurable per model family in `core/pricing`.

```
r_read   = cache read ratio      (default 0.10)
r_write  = cache write ratio     (default 1.25)
r_out    = output ratio          (default 5.0)

C = current context tokens (last assistant turn: input + cache_read + cache_creation)
B = base overhead tokens (first turn of the session ≈ system + tools + memory files)
K = keynotes tokens (estimate or actual)
R = re-read tokens: estimated tokens of files likely needed again
    (default: files edited or read in the last M turns, M=10, capped)
S = B + K + R   (size of the new session's starting context)

one_time = r_out*K + r_write*((K + R) + (base_cached ? 0 : B))
per_turn_saving = r_read * (C - S)
breakeven_turns = per_turn_saving > 0 ? one_time / per_turn_saving : Infinity
```

The per-turn growth term `g` appears on both sides and cancels, so it isn't needed.

**Cache expired** (idle > TTL): continuing costs `r_write * C` on the next turn, versus `one_time` for clearing. If `r_write * C > one_time`, clearing is cheaper immediately.

**Expected values** (B=25K, K=2K, R=15K; turns to break even with the base cached / not cached), which must exist as unit tests:

| C | cached | not cached |
|---|---|---|
| 60K | ~17.4 | ~34.7 |
| 100K | ~5.4 | ~10.8 |
| 150K | ~2.9 | ~5.8 |

Cache-expired at C=100K: continue ≈ 125K vs clear ≈ 62.5K → recommend clear.

**Context window:** read the window size from status line / session data when available, otherwise use a model-family map with a 200K fallback. All thresholds are percentages or break-even based, never hardcoded token counts.

---

## 7. Configuration

Files, merged in order (later wins):
1. built-in defaults
2. `~/.tokentrim/config.json` (user)
3. `<project>/tokentrim.config.json` (project, can be committed)
4. env: `TOKENTRIM_DISABLE=1` kills everything; `TOKENTRIM_DISABLE_<MODULE>=1` kills one module

```json
{
  "$schema": "https://raw.githubusercontent.com/<owner>/tokentrim/main/schema/config.schema.json",
  "modules": {
    "meter": true, "checkpoint": true, "advisor": true,
    "guards": true, "nav": true, "audit": true
  },
  "checkpoint": { "max_tokens": 1500, "inject_on_startup": false },
  "advisor": {
    "max_breakeven_turns": 4,
    "context_budget": 200000,
    "tell_claude": true,
    "desktop_notify": false
  },
  "idle": { "cache_ttl_minutes": "auto", "min_context": 40000, "block_once": false },
  "guards": {
    "duplicate_read": false,
    "noisy_commands": true,
    "noisy_patterns_extra": []
  },
  "pricing": { "r_read": 0.1, "r_write": 1.25, "r_out": 5.0, "usd_per_mtok_input": null }
}
```

- Validate with a JSON Schema (also published for editor autocomplete). An invalid config logs a warning and falls back to defaults. It never crashes.
- `/tokentrim:tokentrim on|off <module>` and `status` edit the project config file and print the current state.

---

## 8. Safety and "never cause problems" rules

1. **Fail open.** Every hook wraps its body in try/catch. On any error or timeout, exit 0 with no output, so Claude Code behaves as if the plugin weren't there. Log errors to `~/.tokentrim/logs/`, rotated, max 5 MB.
2. **Short timeouts.** Set a hook timeout in hooks.json (≤5 s; status line target <50 ms). Use no network calls in any hook.
3. **Don't break the prompt cache.** Inject only at SessionStart, plus the one-time advisor line. Never add per-turn content.
4. **Deny-once semantics** for the large-file and noisy-command guards, so Claude is never stuck.
5. **Never modify user files** except `.tokentrim/`, the project config through the explicit on/off command, and user settings through `setup-statusline` after asking, with a backup made first.
6. **No telemetry.** Everything stays local.
7. `.tokentrim/` should be gitignored. The `doctor` command checks this and *suggests* adding it. It never edits `.gitignore` on its own.

---

## 9. Hook wiring summary

| Event | Matcher | Module(s) | Action |
|---|---|---|---|
| SessionStart | startup/resume/clear/compact | checkpoint, guards | inject keynotes (once); reset read registry on clear/compact |
| UserPromptSubmit | — | advisor (idle) | cache-expiry notice (auto-detected TTL) / optional block-once |
| PreToolUse | Bash | guards | noisy-command |
| PreToolUse | Read | guards | duplicate-read (only when enabled) |
| PostToolUse | Read/Edit/Write/MultiEdit | guards, checkpoint | update registry and hashes; record edited files for Facts |
| Stop | — | meter, checkpoint, advisor | update metrics state, Facts, boundary detection, recommendations |
| PreCompact | manual/auto | checkpoint | refresh Facts before compaction |
| SessionEnd | clear/other | checkpoint | final refresh + archive |

---

## 10. Build phases

Each phase ends with passing tests on all 3 OSes and a short entry in `CHANGELOG.md`.

**Phase 0 — Scaffolding**
- Monorepo, TS strict, ESLint + Prettier, Vitest, esbuild bundling, CI matrix (windows/macos/ubuntu), MIT license, CONTRIBUTING.md.
- Collect real sample transcripts (redacted) as test fixtures.

**Phase 1 — Core + analyzer (the measurement baseline)**
- `transcript`, `accounting`, `breakeven` (with the §6 table as tests), `pricing`, `config`.
- `tokentrim analyze` with Markdown + HTML output.
- Milestone: run it on your own past sessions and save the baseline numbers.

**Phase 2 — Context control: policy simulation, meter, checkpoint, advisor** (the main lever; see docs/BASELINE.md)
- **2a. Policy simulation first (CLI only, no hooks).** Extend `tokentrim analyze --simulate` to replay each recorded session under candidate policies and estimate savings before any hook exists:
  - *boundary clears*: clear at every detected task boundary where break-even ≤ N (re-arming after each clear; after a clear, context is modelled as `S + growth since the clear`);
  - *context budget*: compact or clear when context passes B ∈ {150K, 200K, 300K, 400K};
  - *idle clears*: clear instead of continuing after an idle gap past the detected TTL.
  Report savings per policy and per project, plus how often each would have interrupted the user. The defaults for `max_breakeven_turns`, `context_budget` and the idle notice come from this table, recorded in `docs/DECISIONS.md`.
- **2b. Boundary detection in `core`:** to-do list all completed, successful `git commit`, tests passing after failures, wrap-up wording. Unit-tested on synthetic transcripts and checked by hand against 3 real sessions.
- **2c. Plugin:** manifest, hooks.json, bundled hooks, `/tokentrim:checkpoint`, `/tokentrim:tokentrim on|off|status`. Settle open questions 1–3 and 5 (§13) first.
- **2d. Meter:** status line (or `setup-statusline` fallback) with context, next-request cost, break-even and budget band.
- **2e. Keynotes:** Facts kept small so the fresh-start size `S` stays low (files edited, open errors, to-dos, last requests); Summary via `/tokentrim:checkpoint`; inject once on `clear`/`compact`/`resume`.
- **2f. Advisor:** boundary-clear and budget-compact recommendations (re-arming), idle notice with auto-detected TTL.
- Local install instructions for testing (`/plugin install ./packages/plugin-claude-code`, `/reload-plugins`).
- **Milestones:**
  1. The simulation shows a policy worth ≥ 20% of baseline cost on the 13-project set (if no policy reaches that, record why and adjust targets before building 2c–2f).
  2. A full real session where keynotes survive `/clear`, the advisor fires at each task boundary, and no idle notice fires on a 1-hour-TTL session before 60 minutes.
  3. Re-running the analyzer on two weeks of sessions with the plugin on shows lower average context per request than the baseline's ~458K.

**Phase 3 — Fixed-overhead audit and targeted guards**
Fixed overhead (system prompt, tool and MCP schemas, skills, memory files) was ~56K tokens on every request, 10.8% of baseline cost, so the audit moves ahead of the guards and absorbs the old Phase 4.
- **Audit** (`tokentrim audit` and `/tokentrim:tokentrim audit`, read-only, §5.6): estimated per-request tokens of each CLAUDE.md/memory file, MCP server schemas, skill listings and deferred-tool lists; servers and skills unused across recent sessions (from the analyzer's tool stats); cache breakers seen in transcripts (model switches, rebuilds without an idle gap). Each item gets a saving in ITE over the analyzed period and a suggested fix.
- **Guards** (§5.4 as revised): noisy-command guard on by default; duplicate-read guard off by default; no large-file guard. Real hit, saving and false-positive tracking in session state.
- **Write-vs-Edit measurement** in the analyzer: share of tool-call-input cost from `Write` over existing files. Decide in `docs/DECISIONS.md` whether a suggestion is worth building.
- **Milestones:** the audit lists at least the top 3 overhead items on the author's setup with estimated savings; noisy-command guard false-positive rate under 5% over a week of real use.

**Phase 4 — Folded into Phase 3** (the audit). Numbering kept so later references stay valid.

**Phase 5 — Nav MCP**
- web-tree-sitter grammars, four tools, lazy hash-keyed cache, small instruction snippet.
- Milestone: on the large fixture, `outline`/`read_symbol` measurably reduce read tokens.

**Phase 6 — Benchmark and release**
- `bench` runner, fixtures, tasks, `docs/BENCHMARKS.md`.
- Polished README with a GIF demo, architecture diagram, benchmark table and DMAIC write-up.
- Publish a plugin marketplace repo (`/plugin marketplace add <owner>/tokentrim`) and tag v0.1.0. Optionally submit to the community marketplace.

**Stretch**
- `tokentrim run`: a headless runner on the Claude Agent SDK that auto-checkpoints and starts fresh sessions with keynotes at the break-even point (fully automated for CI/batch work).
- Adapters for other agents (Codex, Cursor, Gemini CLI) using `core`.
- A VS Code status bar extension reading the same state file.

---

## 11. Testing strategy

- **Unit (core):** breakeven math, transcript parsing (including malformed lines), guard decisions, keynote extraction and capping, config merge/validation, path helpers on each OS.
- **Hook contract tests:** pipe recorded hook-input JSON fixtures into each bundled hook and assert the stdout JSON and exit code. These run in the CI matrix.
- **Fail-open tests:** corrupt state files, missing transcript, unreadable config, and a simulated timeout must all produce exit 0 with no output.
- **Golden tests:** analyzer report output on fixture transcripts.
- **Manual QA checklist** in `docs/QA.md` for each release: install, full session, clear/restore, compaction, disable each module, uninstall leaves nothing behind except `.tokentrim/`.

---

## 12. README / portfolio checklist

- One-paragraph pitch plus a before/after token chart from the benchmark.
- Install in two commands; Node 18+ requirement up front.
- Module table with defaults and how to turn each off.
- Break-even explanation (§6) in plain language, with the formula.
- Honest limitations: can't run `/clear` itself; the guards are heuristics; numbers use API price ratios, and subscription limit weighting isn't published.
- Architecture diagram (core vs adapters).
- DMAIC framing.
- Links to BENCHMARKS.md, DECISIONS.md, CONTRIBUTING.md.

---

## 13. Open questions to settle early (record answers in `docs/DECISIONS.md`)

1. Can a plugin register a status line directly, or is `setup-statusline` required?
2. Exact current JSON fields for `systemMessage`, `additionalContext` and `permissionDecision` in this Claude Code version.
3. Does the status line stdin include context usage / window size? Use it if so.
4. Do plugin MCP tools need per-tool approval? Document the one-time "always allow" step if they do.
5. Does `PostCompact` exist in the current version, and does it expose the compact summary? (It could improve keynotes.)
6. Plugin command naming: `commands/` vs `skills/` in the current plugin spec.
7. Does the status line or hook input expose the cache TTL in use? If so, prefer it over `"auto"` detection.
8. Can a hook see the to-do list state directly, or only through the transcript? (Affects boundary detection cost.)

---

## 14. Revision log

- **2026-11-03 — Phases 2–4 revised after the Phase 1 baseline** (docs/BASELINE.md). Findings: 77% of cost is cache reads of a ~458K average context; simulated guards save 0.5%; idle rebuilds cost 6.1% and sessions use a 1-hour TTL; fixed overhead is 10.8%. Changes: Phase 2 starts with a policy simulation and targets average context (re-arming boundary clears, a context budget, auto-detected TTL); guards cut to noisy commands (duplicate-read off, large-file dropped, Write-vs-Edit measured first); the audit moves into Phase 3 and Phase 4 is folded. Not yet re-evaluated: Phase 5 (nav MCP), since `Read` results were only 5.7% of baseline cost and its schemas add fixed overhead; revisit after Phase 3's audit numbers.
- **2026-11-03 — Phase 2a done.** `analyze --simulate` built; milestone 1 met (strong boundary clears alone ≈ 32%, strong + idle + 200K budget ≈ 58% on the 13-project set). Defaults recorded in docs/DECISIONS.md D12: strong signals only by default (`advisor.boundary_signals: "strong" | "any"`), idle notice on, `context_budget` 200K, skip budget suggestions with a long break-even.
- **2026-11-03 — Phase 2c done.** Open questions 1, 2, 3, 5 and 6 answered (docs/DECISIONS.md D13): no plugin status line (setup-statusline stays), plugin commands are skills with `disable-model-invocation: true`, SessionStart now reports cache expiry itself (2f should use it). Plugin skeleton, fail-open runtime, incremental Stop metrics and `/tokentrim:tokentrim` built; `/tokentrim:checkpoint` moved to 2e.
- **2026-11-03 — Phase 2d done.** Meter, `tokentrim setup-statusline` (asks, backs up, chains, `--remove`) and `/tokentrim:setup-statusline`. The status line input reports the cache TTL, so `idle.cache_ttl_minutes: "auto"` is dropped. The <50 ms target is revised to ≤40 ms over Node start-up (D15).
- **2026-11-03 — Phase 2e done.** Keynotes Facts, size cap, `/tokentrim:checkpoint`, injection after clear/compact (not resume: the conversation is restored there). Per-session keynotes plus a clear pointer link the old and new session (D16).
