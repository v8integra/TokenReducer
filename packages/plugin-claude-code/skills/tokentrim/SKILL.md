---
name: tokentrim
description: Show TokenTrim's status, or turn one of its modules on or off for this project.
argument-hint: '[status | on <module> | off <module>]'
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/tokentrim.js" config $ARGUMENTS`

Show the output above to the user exactly as printed, in a code block. Don't run anything else or add advice.
