import type { ParsedSession, ToolCall } from '../transcript/types.js';

/**
 * Task-boundary signals, all knowable when a turn ends (the `Stop` hook), so the advisor can use the same
 * detector live that the simulator uses on recorded sessions.
 *
 * - `todos-done`: the to-do list was updated and every item is completed.
 * - `commit`: a `git commit` succeeded.
 * - `tests-green`: a test command passed after an earlier one in the session failed.
 * - `wrap-up`: the prompt that started the turn reads as wrapping up ("thanks, looks good").
 * - `turn-complete`: the assistant formally closed out the turn (the desktop app's wrap_up tool). Weak: it
 *   fires on almost every working turn, including ones the user continues.
 */
export type BoundarySignal = 'todos-done' | 'commit' | 'tests-green' | 'wrap-up' | 'turn-complete';

export const STRONG_SIGNALS: ReadonlySet<BoundarySignal> = new Set([
  'todos-done',
  'commit',
  'tests-green',
  'wrap-up',
]);

export interface Turn {
  /** First and last main-chain request of the turn (inclusive). */
  startRequest: number;
  endRequest: number;
  signals: Set<BoundarySignal>;
}

const TEST_COMMAND =
  /\b((npm|pnpm|yarn)\s+(run\s+)?test|npx\s+(vitest|jest)|vitest|jest|pytest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b/;
const COMMIT = /\bgit\s+commit\b/;
const WRAP_UP =
  /^\s*(thanks|thank you|thx|ty|perfect|great|awesome|nice|looks good|lgtm|that works|works now|all good|done|ship it|good job|excellent)\b/i;
const TURN_TOOLS = /(^|__)wrap_up$/;
const TASK_LIST_TOOLS = /^(TodoWrite|TaskCreate)$|(^|__)update_plan$/;
const TASK_UPDATE_TOOLS = /^TaskUpdate$/;

/** Splits the main chain into user turns (each starts at a prompt the user typed) and tags their signals. */
/**
 * State that spans turns: the task list and whether the last test run failed. Plain JSON, so the live hooks can
 * persist it between `Stop` events and feed transcripts in pieces.
 */
export interface BoundaryCarry {
  taskStatus: Record<string, string>;
  testFailed: boolean;
}

export function newBoundaryCarry(): BoundaryCarry {
  return { taskStatus: {}, testFailed: false };
}

export function detectTurns(s: ParsedSession, carry: BoundaryCarry = newBoundaryCarry()): Turn[] {
  const n = s.requests.length;
  if (n === 0) return [];
  const human = s.prompts.filter((p) => p.kind === 'human');
  const starts = [
    ...new Set([0, ...human.map((p) => p.addedBefore).filter((i) => i > 0 && i < n)]),
  ].sort((a, b) => a - b);
  const turns: Turn[] = starts.map((start, k) => ({
    startRequest: start,
    endRequest: (starts[k + 1] ?? n) - 1,
    signals: new Set<BoundarySignal>(),
  }));
  const turnOf = (i: number) => {
    let lo = 0;
    for (let k = 0; k < turns.length; k++) if (turns[k]!.startRequest <= i) lo = k;
    return turns[lo]!;
  };

  for (const p of human) {
    if (p.addedBefore < n && WRAP_UP.test(p.preview)) turnOf(p.addedBefore).signals.add('wrap-up');
  }

  const taskStatus = new Map<string, string>(Object.entries(carry.taskStatus));
  const completedIn = new Set<Turn>();
  let testFailedBefore = carry.testFailed;
  const calls = s.toolCalls.filter((t) => !t.isSidechain && t.requestIndex >= 0);
  for (let k = 0; k < calls.length; k++) {
    const t = calls[k]!;
    const turn = turnOf(t.requestIndex);
    for (const sig of signalsOf(t, testFailedBefore)) turn.signals.add(sig);
    if (TASK_UPDATE_TOOLS.test(t.name) && t.input.taskId && t.input.status) {
      taskStatus.set(t.input.taskId, t.input.status);
      if (t.input.status === 'completed') completedIn.add(turn);
    }
    // Judge the task list as it stands when the turn ends, not mid-turn.
    const next = calls[k + 1];
    if (completedIn.has(turn) && (!next || turnOf(next.requestIndex) !== turn)) {
      if ([...taskStatus.values()].every((v) => v === 'completed')) turn.signals.add('todos-done');
    }
    // Bash reports a non-zero exit as an error result, so this tracks red → green.
    if (isTest(t) && t.result) testFailedBefore = t.result.isError;
  }
  carry.taskStatus = Object.fromEntries(taskStatus);
  carry.testFailed = testFailedBefore;
  return turns;
}

function signalsOf(t: ToolCall, testFailedBefore: boolean): BoundarySignal[] {
  const out: BoundarySignal[] = [];
  if (TURN_TOOLS.test(t.name)) out.push('turn-complete');
  if (TASK_LIST_TOOLS.test(t.name) && t.input.todosDone) out.push('todos-done');
  const cmd = t.input.command;
  if (cmd && t.result && !t.result.isError) {
    if (COMMIT.test(cmd)) out.push('commit');
    if (isTest(t) && testFailedBefore) out.push('tests-green');
  }
  return out;
}

function isTest(t: ToolCall): boolean {
  return !!t.input.command && TEST_COMMAND.test(t.input.command);
}
