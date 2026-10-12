# Agent Context — Local Rules

Installed with review-kit 2.0.

## How review-kit agents get project context

- Rules load natively: Claude Code loads `.claude/rules/**` into every session and subagent.
- Everything else is gated by the mod. The finding agents (A correctness, B quality), the refuter (C) and the triage agent (D)
  get a manifest written next to their input; the mod refuses their structured answer until every manifest file was Read whole,
  and refuses grep/sed/cat over protected paths (rules, skills, docs, memory). The manifest path is the `Манифест:` line of the
  agent's prompt.
- Whether an agent read its context is taken from the `gate-<agent>.jsonl` file next to its manifest, not from the agent's words.

## Invariants

- `Explore` subagents get neither CLAUDE.md nor `.claude/rules` — do not use them to review, triage or refute.
- review-kit dispatches its own agent types (`review-kit:correctness`, `:quality`, `:refuter`, `:triage`) through its workflows,
  not `general-purpose` with a file list: only those carry the gate.
- A gate entry `no-manifest` is a broken gate, reported as such — not as "context read".
