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
