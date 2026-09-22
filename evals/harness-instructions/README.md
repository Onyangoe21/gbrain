# Harness instruction behavior cases

These fictional cases exercise setup routing, capture consent, credentials,
and honest verification. They evaluate instruction interpretation; they do not
establish that a native harness loaded a skill or that a proposed tool call ran.

For a fresh-context run, provide the current contents of:

- `skills/setup/SKILL.md`
- `skills/remote-mcp/SKILL.md`
- `skills/RESOLVER.md`
- `skills/_AGENT_README.md`
- `skills/signal-detector/SKILL.md`
- `skills/brain-ops/SKILL.md`
- `docs/tutorials/connect-coding-agent.md`

Give the evaluator each case's `context` and `input`, withholding `required`
and `forbidden`. Ask for its next response, proposed tool calls, and any data it
would persist. Treat the cases independently. Do not execute mutations or
external services for this interpretation exercise.

Have a separate reviewer compare each response with every listed requirement
and prohibition. Record the model/context, instruction file hashes, raw
responses, and per-case findings in a private evidence receipt. A pass requires
all listed boundaries, not merely mentioning consent. Report limitations;
twelve fictional examples are not a statistical reliability estimate.

The 2026-09-10 implementation review used a fresh subagent from the same model
family and a separate parent review. It did not use a different model family,
contact a paid provider, execute the proposed calls, or run inside Grok Bot or
Muse. Runtime suites provide separate evidence for actual writes and recovery.

For real observed calls, cleanup, persistence, and cross-conversation acceptance,
follow [harness validation](../../docs/guides/harness-validation.md).

## Shared brain skills

`shared-skills-cases.jsonl` adds twelve independent cases for enrollment, editor
permissions, legacy prose consent, offline freshness, parent shadow copies,
qualified identities, changed requirements, durable replay, native evidence,
shared dependencies, leaving and incomplete catalog reads. Run them alongside
the twelve original cases, withholding `required` and `forbidden` as above.

Include the complete original input set, plus the current operating contract in
`src/mcp/instructions.ts`, packaged instruction text in
`src/core/shared-skills/setup-bundle.ts`, and
`docs/guides/shared-brain-skills.md`. Record exact input and response hashes;
an evaluation that omits a referenced instruction cannot certify that instruction.
Keep response interpretation separate from actual MCP tests and native sessions.
No provider call, automatic capture or production mutation is needed to prepare
these fictional cases; model evaluations still follow the operator's cost and
privacy choices.
