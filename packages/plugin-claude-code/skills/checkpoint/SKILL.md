---
name: checkpoint
description: Save decisions, the current task and next steps to TokenTrim keynotes so they survive /clear.
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/tokentrim.js" keynotes refresh --session ${CLAUDE_SESSION_ID} --project "${CLAUDE_PROJECT_DIR}"`

If the output above reports an error, show it to the user and stop.

Otherwise, Read the keynotes file it names, then use Edit to replace only the text between the
`<!-- tokentrim:summary -->` and `<!-- /tokentrim:summary -->` markers. Keep the `## Summary` heading and
write at most about 250 words of short bullets under these headings:

- **Decisions** and why they were made
- **Current task** and where it stands
- **Next steps**
- **Gotchas** a fresh session would trip over

Leave out anything already in the Facts section or obvious from the code. Don't edit the Facts section; it is
regenerated after every turn.

Then tell the user in one sentence that the keynotes are saved and they can run /clear; the next session will
start with them.
