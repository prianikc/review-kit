# Writing Plans — Conventions

**Required sub-skill:** invoke `superpowers:writing-plans`, inside native Plan Mode. Before drafting
tasks, load the conventions for every stack the plan touches so code blocks already comply.

## Stack detection

Detect the languages and frameworks from the requested plan, not from the repository's overall
technology list. For each one, read the project's own rules and conventions for it (in
`.claude/rules/`, `CLAUDE.md`, linter and formatter configs) and invoke a matching best-practices
skill if one is installed, before presenting tasks. Markdown-only changes (docs, skills, rules)
need no stack rule. A missing rule file is not a blocker.

## Required plan

Include: goal, architecture, file map, implementation tasks, test scenarios, constraints, and one
final verification pass. Every task shows concrete before/after code (or the full new file), not
only prose. For test-worthy code, show the test before the implementation and follow TDD.

The final pass runs build, type-check, lint and tests exactly once at the end. Do not include
`git add`, `git commit` or PR creation steps.

Store plans at `docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md` only after `ExitPlanMode`
approval; delete them after implementation unless the user asks to keep them.

## Entity comments

Every entity declared in a plan's code block — class, method, function, DTO field, column, enum,
constant, type — gets a one-line comment above it saying what it does in the business logic.
Existing entities quoted in the block are annotated too. The form tells existing from new:

- `// ...` — already exists (including one this task modifies): what it does today.
- `/** ... */` — introduced by this task: what it will do.

Comments never reach the implementation; the final verification greps for leftovers. No annotations
inside test code blocks.

## Language

The plan is written in Russian, except markup the superpowers tooling parses by literal English
text: `### Task N: <русское название>` headings, `- [ ]` checkboxes, `Step N:`, `Files:`
(`Create:`/`Modify:`/`Test:`), `Interfaces:`, `## Global Constraints`, and the
`> **For agentic workers:** ...` header line.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Drafting before stack rules are loaded | Detect and read the stack rules first |
| Prose-only implementation task | Include exact code blocks |
| Tests deferred to a separate task | Put test-first code in the same task |
| Full suite after each task | Reserve it for the single final pass |
| Commit step in the plan | Remove it |
| Translating the `Task N` heading ("Задача 1") | Keep `### Task N: ...` — tooling parses the English word |
