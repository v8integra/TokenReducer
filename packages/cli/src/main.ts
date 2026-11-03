import { runAnalyze } from './analyze.js';
import { ArgError, parseAnalyzeArgs, USAGE } from './args.js';

const HELP = `tokentrim — measure and cut wasted tokens in Claude Code sessions

Commands:
  analyze     token report for past sessions (run "tokentrim analyze --help")

More commands (audit, bench, setup-statusline, doctor) arrive in later phases.
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
