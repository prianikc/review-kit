# Brainstorming Conventions

**Required sub-skill:** invoke `superpowers:brainstorming`; it owns the design process. This file
adds activation, Plan Mode, approval and artifact rules on top of it.

## Trigger and flow

Use this for ideas, new behavior, architecture, or any request equivalent to «давай подумаем» /
"let's think about this". Enter native Plan Mode first. Explore project context, ask one question at
a time (through `AskUserQuestion`), compare 2–3 approaches, present the design, and get approval
before implementation.

After design approval, hand off to `workflow/writing-plans.md`. Do not implement before the design
is agreed when the task requires an architectural choice.

## Plan Mode and artifacts

- Every Plan Mode turn ends with `ExitPlanMode` or `AskUserQuestion`.
- Each document has its own approval cycle. Do not append a new draft to an already-approved Plan
  Mode file.
- Save the design spec only after approval, at `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
- If a plan follows, delete the temporary design spec unless the user asks to keep it.
- Write the design spec in Russian — headings and prose; code blocks and identifiers stay as-is.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Asking design questions before entering Plan Mode | `EnterPlanMode` first, then brainstorm |
| Implementing before design approval | Finish brainstorming and approval first |
| Saving the spec early | Keep the draft in Plan Mode until approval |
| Combining approval cycles | One Plan Mode document per artifact |
