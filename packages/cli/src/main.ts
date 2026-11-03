import { runAnalyze } from './analyze.js';
import { ArgError, parseAnalyzeArgs, USAGE } from './args.js';
import { runConfig } from './config-cmd.js';
import { runKeynotes } from './keynotes-cmd.js';
import { parseSetupArgs, runSetupStatusline, SETUP_USAGE } from './setup-statusline.js';

const HELP = `tokentrim — measure and cut wasted tokens in Claude Code sessions

Commands:
  analyze     token report for past sessions (run "tokentrim analyze --help")
  config      show module status, or turn a module on/off for a project
  keynotes    refresh or show a session's keynotes (used by /tokentrim:checkpoint)
  setup-statusline   add the TokenTrim meter to Claude Code's status line (asks first)

More commands (audit, bench, doctor) arrive in later phases.
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === 'analyze') {
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(USAGE);
      return 0;
    }
    try {
      return await runAnalyze(parseAnalyzeArgs(rest), {
        log: (s) => process.stdout.write(s + '\n'),
        progress: (s) => process.stderr.write(s + '\n'),
      });
    } catch (e) {
      if (e instanceof ArgError) {
        process.stderr.write(`${e.message}\n\n${USAGE}`);
        return 2;
      }
      throw e;
    }
  }
  const io = {
    log: (s: string) => process.stdout.write(s + '\n'),
    progress: (s: string) => process.stderr.write(s + '\n'),
  };
  if (cmd === 'config') return runConfig(rest, io);
  if (cmd === 'keynotes') return runKeynotes(rest, io);
  if (cmd === 'setup-statusline') {
    if (rest.includes('--help')) {
      process.stdout.write(SETUP_USAGE);
      return 0;
    }
    const o = parseSetupArgs(rest);
    if (typeof o === 'string') {
      process.stderr.write(o);
      return 2;
    }
    return runSetupStatusline(o, io);
  }
  process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`tokentrim: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exit(1);
  },
);
