import type { Usage } from '../pricing/index.js';

/**
 * One API request, i.e. one assistant message. Claude Code writes each content block as its own line, so
 * several JSONL entries share a message id; they are merged into one request here.
 */
export interface ApiRequest {
  id: string;
  /** Position among this session's requests (main chain and sidechains counted separately). */
  index: number;
  timestamp: number;
  model: string;
  usage: Usage;
  isSidechain: boolean;
  textChars: number;
  thinkingChars: number;
  toolUseChars: number;
  toolUseIds: string[];
}

export interface ToolInputSummary {
  file_path?: string;
  path?: string;
  offset?: number;
  limit?: number;
  command?: string;
  pattern?: string;
  url?: string;
}

export interface ToolResult {
  chars: number;
  lines: number;
  isError: boolean;
  hash: string;
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Index of the main-chain request that issued this call (-1 for sidechain calls). */
  requestIndex: number;
  isSidechain: boolean;
  timestamp: number;
  input: ToolInputSummary;
  inputChars: number;
  /** Index of the first main-chain request whose context contains the result (-1 if none). */
  resultAddedBefore: number;
  result?: ToolResult;
}

export interface UserPrompt {
  timestamp: number;
  chars: number;
  /** Text truncated for display. Reports only print it when explicitly asked to. */
  preview: string;
  /** `meta` covers system-generated user entries (reminders, command output); `compact-summary` the summary after compaction. */
  kind: 'human' | 'meta' | 'compact-summary';
  addedBefore: number;
}

export interface Compaction {
  timestamp: number;
  trigger: string;
  preTokens: number | null;
  postTokens: number | null;
  /** Index of the first main-chain request after the compaction. */
  beforeRequest: number;
}

export interface ParsedSession {
  sessionId: string;
  file: string;
  title?: string;
  cwd?: string;
  version?: string;
  firstTimestamp: number;
  lastTimestamp: number;
  /** Main-chain requests, in order. */
  requests: ApiRequest[];
  /** Subagent / sidechain requests (inline sidechains and `subagents/*.jsonl`). */
  sidechainRequests: ApiRequest[];
  toolCalls: ToolCall[];
  prompts: UserPrompt[];
  compactions: Compaction[];
  malformedLines: number;
  totalLines: number;
}
