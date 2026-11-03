// Entry point for every hook: `node dist/hook.js <event>`. One bundle keeps the plugin small.
import { HANDLERS } from './hooks.js';
import { runHook } from './runtime.js';

const event = process.argv[2] ?? '';
const handler = HANDLERS[event];
if (handler) void runHook(event, handler);
else process.exit(0); // Unknown event: do nothing rather than fail.
