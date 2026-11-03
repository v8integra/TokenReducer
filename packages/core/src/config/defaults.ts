export const MODULES = ['meter', 'checkpoint', 'advisor', 'guards', 'nav', 'audit'] as const;
export type ModuleName = (typeof MODULES)[number];

export interface TokenTrimConfig {
  modules: Record<ModuleName, boolean>;
  checkpoint: { max_tokens: number; inject_on_startup: boolean };
  advisor: {
    max_breakeven_turns: number;
    /** Suggest /compact once the context passes this many tokens (docs/DECISIONS.md D12). */
    context_budget: number;
    /** Which task-boundary signals count: 'strong' ones only, or also any closed-out turn. */
    boundary_signals: 'strong' | 'any';
    tell_claude: boolean;
    desktop_notify: boolean;
  };
  idle: { cache_ttl_minutes: number; min_context: number; block_once: boolean };
  guards: {
    duplicate_read: boolean;
    large_file_lines: number;
    noisy_commands: boolean;
    noisy_patterns_extra: string[];
  };
  pricing: { r_read: number; r_write: number; r_out: number; usd_per_mtok_input: number | null };
}

export function defaultConfig(): TokenTrimConfig {
  return {
    modules: {
      meter: true,
      checkpoint: true,
      advisor: true,
      guards: true,
      nav: true,
      audit: true,
    },
    checkpoint: { max_tokens: 1500, inject_on_startup: false },
    advisor: {
      max_breakeven_turns: 4,
      context_budget: 200_000,
      boundary_signals: 'strong',
      tell_claude: true,
      desktop_notify: false,
    },
    idle: { cache_ttl_minutes: 5, min_context: 40000, block_once: false },
    guards: {
      duplicate_read: true,
      large_file_lines: 800,
      noisy_commands: true,
      noisy_patterns_extra: [],
    },
    pricing: { r_read: 0.1, r_write: 1.25, r_out: 5.0, usd_per_mtok_input: null },
  };
}
