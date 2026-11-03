---
name: setup-statusline
description: Add the TokenTrim meter to Claude Code's status line, keeping any status line you already have.
argument-hint: '[--remove]'
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/tokentrim.js" setup-statusline --dry-run $ARGUMENTS`

Show the plan above to the user as printed. If it says nothing would change, stop there.

Otherwise ask the user one yes/no question: whether to apply this change to their settings. Only if they say
yes, run this command and show its output:

`node "${CLAUDE_PLUGIN_ROOT}/dist/tokentrim.js" setup-statusline --yes $ARGUMENTS`

Don't edit settings.json any other way.
