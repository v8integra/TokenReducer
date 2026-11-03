# Baseline (Phase 1 milestone)

Measured 2026-11-02 with `tokentrim analyze` on the author's own Claude Code sessions, before any TokenTrim
module was active. Costs are input-token equivalents (ITE, see README). Full reports stay local in
`.tokentrim/reports/baseline-2026-11-02/` (gitignored, they contain paths).

## Scope

| Transcript folder                       | Sessions | Requests | Cost (ITE) | Cost per typed prompt |
| --------------------------------------- | -------: | -------: | ---------: | --------------------: |
| Desktop app sessions across 13 projects |       13 |    7,497 |      446 M |                 995 K |
| Older LocalAI folder                    |        7 |    5,314 |      283 M |                 2.0 M |
| Unreal test project                     |       31 |    1,102 |       22 M |                 210 K |

Most sessions ran Opus with a 1 M context window and grew to ~965 K before auto-compacting.

## Main findings (13-project set)

| Metric                                                    |                                                                Value |
| --------------------------------------------------------- | -------------------------------------------------------------------: |
| Cache reads as a share of cost                            |                                        **77 %** (3.43 B tokens read) |
| Average context per request                               |                                                        ~458 K tokens |
| Cache hit ratio                                           |                                                               98.8 % |
| Cache writes / output share                               |                                                      11.2 % / 11.8 % |
| Estimated thinking kept in context                        |                                                       28.7 % of cost |
| Tool-call inputs (edit/write bodies, commands) in context |                                                               16.3 % |
| Fixed overhead per request (system, tools, memory)        |                                                 ~56 K tokens, 10.8 % |
| Cache rebuilds (≥ 50 % of context re-written)             |                47, costing 6.1 % extra; 46 of them after an idle gap |
| Idle gaps > 5 min / > 60 min                              |                                                             283 / 50 |
| Upper bound from one clear per segment at break-even      |                           6.7 % (9.6–9.8 % in the other two folders) |
| Simulated guard savings                                   | 0.5 % (duplicate reads 0.2 %, noisy commands 0.3 %, large files 0 %) |

## What this means for the plan

1. **Context size is the cost.** Nearly everything is the same large context re-read on every request.
   Anything that keeps the average context smaller (clearing at task boundaries, earlier compaction, keynotes)
   beats anything that trims single tool results. The meter, checkpoint and advisor (Phase 2) matter most.
2. **The guards as specified would save little.** Claude Code already avoids most duplicate reads and caps
   large reads, so they barely show up. Phase 3 should either be cut down or retargeted at what does show up,
   such as large Write/Edit bodies staying in context and `cat`-style commands.
3. **Idle rebuilds are the next-biggest lever.** These sessions use a 1-hour cache TTL (most 5-minute gaps
   didn't rebuild), so the idle check should default to 60 minutes when the data shows that, or read the TTL
   from the session.
4. **One clear per segment is a floor, not the ceiling.** The 6.7 % assumes a single clear per segment.
   Clearing at every boundary would save more. Phase 2's advisor should be measured against that with the
   benchmark, not with this simulation.
