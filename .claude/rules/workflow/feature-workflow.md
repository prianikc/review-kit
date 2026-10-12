# Feature Workflow — Always-On Contract

Every new feature, behavior change and code edit goes through one pipeline. No step is skipped
because the task "looks small".

## The pipeline

1. **Sync with git.** Before reading a spec, planning, implementing or reviewing, run and report
   `git status --porcelain`, `git fetch`, `git log --oneline -5`, `git status -sb`. If the branch is
   behind, say so and ask before updating — no automatic `pull`/`merge`/`rebase`.
2. **Enter native Plan Mode** (`EnterPlanMode`) — before the first design question, not after it.
3. **Design** — for an idea, new behavior or architecture (or «давай подумаем» / "let's think about
   this"): read `workflow/brainstorming.md`, invoke `superpowers:brainstorming`.
4. **Plan** — read `workflow/writing-plans.md`, invoke `superpowers:writing-plans`.
5. **Review in Plannotator** — `ExitPlanMode` opens the plan in Plannotator (its plugin hooks
   `ExitPlanMode`). Follow `workflow/plannotator.md`; process every annotation and resubmit until
   the plan is approved.
6. **After approval, ask before starting implementation.**
7. **Implement**, then run the checks before claiming the work is done. Never commit or push
   without an explicit request.

## Every code change goes through Plan Mode — no size threshold

Before the first edit to anything in the product (application code, libraries, templates, styles,
config the app reads, migrations): `EnterPlanMode` → `superpowers:writing-plans` → `ExitPlanMode`
→ approval → edit. A one-liner, a rename, a typo, a fix from code review, a ticket or a bug report —
all planned. The reviewer states the problem; the plan states the solution; the user approves it
before it exists.

Writing or editing a plan file also goes through `superpowers:writing-plans` in Plan Mode, never a
direct `Write`/`Edit` of the markdown — "the plan only needs a correction" is the usual slip.

**Out of scope** (edit directly): rule and memory files, documentation the user asked for in this
message, spec and plan documents (which follow the paragraph above), scratchpad files, read-only
investigation, builds, linters, tests and git reads.

A change made without a plan is not papered over: say so, ask whether to revert it, redo it through
a plan.

## Plan Mode discipline

- While Plan Mode is active, every turn ends with `ExitPlanMode` or `AskUserQuestion` — no
  plain-text questions.
- Durable markdown artifacts (spec, plan) stay in the Plan Mode draft until `ExitPlanMode` is
  approved; only then are they saved to disk.
- One Plan Mode document per artifact: a spec and a plan get separate approval cycles.

## Spec and plan are written at different moments

1. **Spec — at documentation time.** What and why: context, scope, contracts, decisions with
   reasons, error cases, explicit out-of-scope, what needs testing. No step-by-step instructions,
   no full file listings.
2. **Implementation plan — immediately before writing the code.** Tasks, before/after code for every
   touched file, verification commands, expected results.

No implementation plan during the documentation pass: written weeks early, its snippets go stale and
it gets rewritten anyway. The spec is never skipped.
