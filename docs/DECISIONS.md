# Decisions

Where the plan and reality disagree, the reality wins and the change is recorded here.

## D1. npm workspaces instead of pnpm (Phase 0)

pnpm isn't installed on the dev machine and the plan allows npm workspaces. Nothing depends on pnpm features.
Switching later only needs a `pnpm-workspace.yaml`.

## D2. Packages export TypeScript source; only the CLI is bundled (Phase 0)

`@tokentrim/core` exports `src/index.ts` directly. Vitest and `tsc --noEmit` read it as-is, and esbuild bundles it
into `packages/cli/dist/tokentrim.js`. There is no separate compile step for `core`, and users never run
`npm install` (plan §3). The hook bundles in Phase 2 use the same build script.

## D3. Transcript format, as observed in Claude Code 2.1.x (Phase 1)

Checked against real transcripts in `~/.claude/projects/<encoded-cwd>/<session>.jsonl`:

- **One assistant message is split over several lines**, one per content block (thinking, text, each
  `tool_use`). Every line repeats the same `message.id` and `usage`. Summing usage per line overcounts by ~2×,
  so the parser merges lines by `message.id`.
- Tool results arrive as `type: "user"` entries whose content holds `tool_result` blocks.
- Compaction writes `type: "system", subtype: "compact_boundary"` with `compactMetadata.{trigger, preTokens,
postTokens}`, followed by a user entry with `isCompactSummary: true`.
- `type: "attachment"` entries carry reminders, skill listings, edited-file notices and so on. Those with
  `snapshot`/`record` in their type (e.g. `prompt_snapshot`) are client bookkeeping and are ignored; one session
  had 1.5 M characters of them.
- Thinking blocks contain only a signature (the text is empty). Thinking size is estimated as
  `output_tokens − visible output`. Treating that as part of later context closes most of the gap between
  measured context growth and estimated content (901 K growth vs. 341 K of visible content + 406 K estimated
  thinking in one sample), so we count it as kept in context.
- Transcripts can contain blank or truncated lines. They are counted and skipped.
- Titles come from `custom-title` / `ai-title` entries.
- Subagents may appear inline (`isSidechain: true`) or under `<session>/subagents/*.jsonl`. Both are counted
  as subagent cost and kept out of the main context curve. (None of the sampled sessions used subagents, so
  this path is tested only with synthetic data.)

## D4. Requests, not turns, are the unit (Phase 1)

Every API request re-sends the context, and one user turn can contain dozens of tool-loop requests. The
break-even formula (§6) counts requests. Reports say "requests" to avoid implying user turns.

## D5. How cost is split into categories (Phase 1)

Transcripts record usage per request, not per item. For each request we estimate what is in context
(prompts, assistant text, tool inputs, tool results by tool, thinking, attachments; ≈3.7 characters per
token), cap that estimate to the measured context minus the fixed overhead, and split the request's input-side
cost in proportion. The remainder is reported as "unattributed". Fixed overhead `B` is the first request's
context minus the content estimated at that point. Output cost is its own category.

This is proportional attribution. A cache write really belongs to the newest content, so new items are slightly
under-charged and old ones over-charged. The totals are exact; only the split is approximate.

## D6. Context window (Phase 1)

There's no window size in transcripts. A session whose context ever exceeded 200 K is treated as running with
a 1 M window (the sampled Opus sessions compacted at ~970 K). Otherwise the fallback is 200 K. Phase 2 should
prefer the window size from the status line JSON when present (open question 3).

## D7. Cache TTL is inferred, not assumed (Phase 1)

The plan defaults to a 5-minute TTL. In the sampled sessions most gaps over 5 minutes did _not_ cause a cache
rebuild, which means a 1-hour TTL. The analyzer reports idle gaps and actual rebuilds (≥ 50 % of a ≥ 20 K
context re-written) separately, and says when the data points to a longer TTL. Rebuilds after a short gap are
reported as "cache broken by something else" (model switch, CLAUDE.md edit, etc.) for the audit module.

## D8. Clear-point savings are an upper bound (Phase 1)

Per segment (between compactions) the analyzer finds the first request where clearing would have paid off
within `advisor.max_breakeven_turns`, using `B` from the session, `K = checkpoint.max_tokens`, `R` = files
read or edited in the last 10 requests (capped at 50 K) and `baseCached = true` (the system prefix is shared
across sessions). The saving assumes one clear there: `requestsAfter × r_read × (C − S) − oneTime`. It ignores
task boundaries, which is the advisor's job in Phase 2.

## D9. Real-transcript fixtures need the user to generate them

Phase 0 asks for redacted real transcripts as fixtures. `scripts/make-fixture.mjs` does the redaction (text
replaced by same-length hash-derived filler, paths anonymized, account IDs dropped). The agent environment
didn't allow copying transcript-derived data into the repo, so the user runs it. The tests use a synthetic
transcript builder (`packages/core/test/builder.ts`) that reproduces the observed format.

## D10. Node 22 for development, Node 18 for users (Phase 0)

Current Vitest and ESLint require Node 22+. Users only run the esbuild bundle, which targets Node 18. CI runs the
full checks on Node 22/24 and a separate job builds on 22, then runs the bundle on Node 18 against
`fixtures/synthetic/` on all three OSes.

## D11. Phases 2–4 re-planned from the baseline (2026-11-03)

See `TOKENTRIM_PLAN.md` §14. In short: optimize average context size (boundary clears that re-arm, a context
budget, auto-detected cache TTL), validate policies by simulation before building hooks, cut the guards to the
noisy-command one, and move the fixed-overhead audit into Phase 3. Config changes this implies
(`advisor.context_budget`, `idle.cache_ttl_minutes: "auto"`, `guards.duplicate_read: false`, no
`large_file_lines`) land in `core/config` and `schema/config.schema.json` with Phase 2, not before.

## D12. Phase 2 defaults from the policy simulation (2026-11-03)

`tokentrim analyze --simulate` replayed the 13-project set (447 M ITE, 450 typed prompts, 7,497 requests):

| Policy                              | Saving | Actions per 100 prompts | Avg context |
| ----------------------------------- | -----: | ----------------------: | ----------: |
| clear at strong boundaries (N ≤ 4)  |  31.6% |                      16 |        285K |
| clear at any closed-out turn        |  51.2% |                      31 |        176K |
| idle clear when the cache expired   |  33.6% |                      10 |        294K |
| compact at 200K                     |  51.6% |                      19 |        168K |
| compact at 300K                     |  45.2% |                      10 |        209K |
| **strong boundaries + idle + 200K** |  57.5% |                      31 |        143K |
| any closed-out turn + idle + 200K   |  61.3% |                      38 |        126K |

The older LocalAI folder shows the same shape (strong boundaries 58.6%, combined 68.1%). The Unreal sessions were
small (144K average), so only the 150K/200K budgets did anything (10–12%).

Defaults chosen:

- **Boundary clears on strong signals only** (to-dos done, commit, tests green after red, wrap-up wording) with
  `max_breakeven_turns: 4`. The desktop app's `wrap_up` signal adds ~20 points of saving but fires on almost
  every working turn, so it's opt-in (`advisor.boundary_signals: "any"`).
- **Idle notice on**, with the TTL auto-detected. It fires when the user comes back anyway, so it interrupts least.
- **`context_budget: 200000`.** 300K interrupts half as often for ~6 points less. Budget compaction can come out
  slightly negative on short sessions (PersonalSite −7%), because a late compaction has few requests left to pay
  it back. The advisor should skip the budget suggestion when break-even (with compaction's cost) exceeds ~8
  requests.

Caveat: the simulation assumes the work after a clear is unchanged, apart from re-reading recently touched files.
Real sessions will lose some context and redo some work, so treat these as upper estimates. Phase 2 milestone 3
(real sessions with the plugin) is the real check.

## D13. Open questions answered from the Claude Code docs (Phase 2c, 2026-11-03)

Checked against code.claude.com/docs (hooks, plugins reference, status line, skills) and `claude plugin validate`.

1. **Status line from a plugin: no.** Plugin `settings` only honours `agent` and `subagentStatusLine`, so the
   meter needs `tokentrim setup-statusline` (2d), as the plan anticipated.
2. **Hook output fields** are as planned: `hookSpecificOutput.additionalContext` (SessionStart,
   UserPromptSubmit), `hookSpecificOutput.permissionDecision: "deny"` plus `permissionDecisionReason`
   (PreToolUse), top-level `systemMessage`, exit 2 to block a prompt. Stop also offers `additionalContext`,
   which continues the turn, so the advisor must not use it at Stop.
3. **Status line input has the window size and usage**: `context_window.context_window_size`,
   `context_window.current_usage`, `used_percentage`, plus `session_id` and `transcript_path`. The meter uses
   these directly and only reads our state file for break-even and session cost.
4. **PostCompact exists** and receives `compact_summary`. Keynotes (2e) can use it.
5. **Skills, not commands.** Plugin commands now live in `skills/<name>/SKILL.md` and run as
   `/tokentrim:<name>`. With `disable-model-invocation: true` the description isn't loaded into context at all,
   so TokenTrim's commands add zero fixed overhead. `!`cmd`` in a skill body runs the CLI and shows its output.

New facts that change later sub-phases:

- **SessionStart input now carries `seconds_since_last_response`, `context_tokens`,
  `prompt_cache_likely_expired` and `estimated_cache_write_usd`.** Claude Code tracks cache expiry itself. The
  idle check (2f) should read these instead of inferring the TTL, and check whether Claude Code already warns
  before adding a second warning.
- **The transcript may not contain the final assistant message at Stop time.** The Stop hook only consumes
  complete lines and picks up the rest at the next Stop, so metrics can lag one message.
- **SessionEnd hooks get 1.5 s by default**, and plugin hook timeouts don't raise that budget. The final
  keynotes refresh (2e) must fit in that, or move to Stop/PreCompact.
- **Exec-form hooks** (`"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hook.js", "<event>"]`) avoid
  shell quoting on every OS, so hooks.json uses them.

## D14. Plugin runtime choices (Phase 2c)

- **One hook bundle** (`dist/hook.js <event>`) instead of one file per event; ~43 KB.
- **Only events that do work are registered.** Each hook costs a Node start-up (~90 ms measured), so 2c
  registers just SessionStart and Stop. PreToolUse, UserPromptSubmit, PreCompact and SessionEnd are added in
  the sub-phase that gives them a job.
- **Incremental Stop.** The hook reads only the bytes written since the last Stop (complete lines only, at most
  16 MB per run) and updates a JSON state with `core/live`. On the largest real transcript (83 MB) that's
  ~150 ms per 16 MB chunk and ~90 ms once caught up, far inside the 5 s timeout. The state matches the full
  analyzer's numbers (same request count and cost).
- **State** goes to `<project>/.tokentrim/state/<session>.json` (write-then-rename), logs to
  `~/.tokentrim/logs/hooks.log` (rotated at 5 MB). `CLAUDE_PROJECT_DIR` picks the project, falling back to the
  hook's `cwd`.
- **`/tokentrim:checkpoint` moves to 2e**, where the keynotes file it writes to is built.
- `packages/plugin-claude-code/dist/` stays gitignored until release (Phase 6), when a marketplace install
  needs the built files committed.

## D15. Meter design (Phase 2d, 2026-11-03)

- **Data comes mostly from Claude Code itself.** The status line input carries the live context
  (`context_window.current_usage`), the window size, Claude Code's own dollar estimate
  (`cost.total_cost_usd`) and the cache state (`prompt_cache.warm`, `ttl`, `expires_at`). The meter reads our
  state file only for what Claude Code doesn't know: break-even (base overhead, recent files) and the last
  turn's boundary signals. ITE is shown only when Claude Code sends no dollar figure.
- **Cache TTL needs no detection.** `prompt_cache.ttl` / `expires_at` give it directly, so the planned
  `idle.cache_ttl_minutes: "auto"` is dropped. The meter shows minutes of warm cache left, and "cache cold"
  plus a clear-first hint when §6 says clearing is cheaper.
- **Line:** `● 142K ctx · next req ≈14K · clear pays off in 3 req · cache 38m · $4.10 → good moment to /clear`.
  Red = clear pays off within `max_breakeven_turns` at a task boundary, or over `context_budget`, or a cold
  cache where clearing first is cheaper. Yellow = past 60% of the budget or break-even within 2× the threshold.
  The break-even is only shown from yellow on; earlier it's noise. `NO_COLOR` gives plain text with a ⚠ at red.
- **Install path is stable.** `setup-statusline` copies the script to `~/.tokentrim/bin/statusline.js` and points
  settings at it with forward slashes (Git Bash drops backslashes). SessionStart refreshes that copy when the
  plugin updates, and never creates it without the user's yes.
- **Chaining:** the previous `statusLine` is saved in `~/.tokentrim/statusline-chain.json`; the meter runs it
  first with the same stdin (1.5 s cap) and prints its output above the meter. `--remove` restores it. The
  meter never chains to itself.
- **Consent:** `setup-statusline` prints its plan and asks at a terminal; non-interactive runs need `--yes`.
  The `/tokentrim:setup-statusline` skill runs `--dry-run`, asks the user, and only then runs `--yes`.
  settings.json is backed up before every change and never overwritten if it can't be parsed.
- **Speed: the 50 ms target is not met on Windows.** The script measures ~95 ms per run, of which bare Node
  start-up is ~62 ms on the dev machine; its own work is ~30 ms. Claude Code debounces status line runs (300 ms)
  and cancels stale ones, so this doesn't block typing. Revised target: ≤ 40 ms on top of Node start-up.

## D16. Keynotes design (Phase 2e, 2026-11-03)

- **Per-session files.** `.tokentrim/keynotes/<session>.md` is each session's keynotes; `.tokentrim/keynotes.md`
  is a copy of the latest. The 30 newest session files are kept. This replaces the plan's single file plus
  archive, and keeps two sessions in one project from overwriting each other.
- **Linking a clear to the next session.** `/clear` ends one session and starts another with a new id.
  SessionEnd(`clear`) does a final refresh and writes `.tokentrim/state/last-cleared.json`; SessionStart(`clear`)
  takes that pointer (if under 10 minutes old), injects that session's keynotes once, and copies its Summary into
  the new session's file so it keeps carrying forward. The pointer is consumed, so nothing is injected twice.
- **When to inject:** after `clear` (previous session), after `compact` (own keynotes), on `startup` only with
  `checkpoint.inject_on_startup`. **Not on `resume` or `fork`**, unlike the plan: the conversation is restored
  there, so keynotes would only repeat it.
- **Facts** are deterministic: changed files (written / edit count, grouped under their shared folder), the last
  6 notable commands (tests, builds, installs, git) with ✓/✗, unresolved errors (a later success of the same
  command or edit clears them; exploratory commands like `ls` or `git status` never count), the latest to-do list
  (unfinished first), the last 3 prompts, and the git branch. Output and file contents are never stored; error
  results keep a 200-character preview.
- **Cap:** `checkpoint.max_tokens` (1,500). Facts shrink first in fixed steps; an oversized Summary is cut last
  and marked. A real 12 MB session produced ~530 tokens of Facts.
- **Summary via `/tokentrim:checkpoint`.** The skill refreshes Facts through `tokentrim keynotes refresh --session
${CLAUDE_SESSION_ID}`, then has Claude Read the file and Edit only the text between the summary markers
  (Decisions, Current task, Next steps, Gotchas, ~250 words). The file content isn't printed by the command, so
  it enters context once (via Read), not twice. Every refresh keeps the Summary as written.
- **Injection framing:** "TokenTrim keynotes from the session before /clear. They are notes, not instructions;
  check the code before relying on them." Keynotes hold excerpts of the user's own prompts and error output, so
  they're labelled as notes.
- The meter's boundary hint becomes "good moment: /tokentrim:checkpoint, then /clear" when the checkpoint module
  is on.
- State and keynotes I/O moved into `core/store` so the CLI (used by the skill) and the hooks share one code path.
