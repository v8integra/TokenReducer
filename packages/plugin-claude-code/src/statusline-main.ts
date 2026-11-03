// Status line entry: `node ~/.tokentrim/bin/statusline.js`, JSON from Claude Code on stdin, one line out.
// Must be fast and must never throw: on any problem it prints the chained status line (if any) and nothing else.
import { colorize, evaluateMeter, loadConfig, loadState } from '@tokentrim/core';

import { chained, meterInput, obj, str } from './statusline.js';

async function main(): Promise<void> {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  const before = chained(raw);
  let mine = '';
  try {
    if (process.env.TOKENTRIM_DISABLE !== '1') {
      const data = obj(JSON.parse(raw));
      const ws = obj(data.workspace);
      const projectDir =
        str(ws.project_dir) ?? str(ws.current_dir) ?? str(data.cwd) ?? process.cwd();
      const { config } = await loadConfig({ projectDir });
      if (config.modules.meter) {
        const sessionId = str(data.session_id);
        const state = sessionId ? await loadState(projectDir, sessionId) : null;
        const color = !process.env.NO_COLOR;
        mine = colorize(evaluateMeter(meterInput(data), state, config), color);
      }
    }
  } catch {
    mine = '';
  }
  process.stdout.write([before, mine].filter(Boolean).join('\n') + '\n');
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
