# Plannotator Conventions

The Plannotator plugin hooks `ExitPlanMode`: the plan opens in its UI, and the user either approves
it or sends annotations back. For anything beyond that (code review, annotating files or URLs),
invoke the `plannotator` skill.

## Rules

- **Every plan and spec goes through `ExitPlanMode`**, so it is reviewed in Plannotator before it is
  saved or implemented.
- **Keep waiting until a final result** — annotations, approval, an error or an exit code. An empty
  response, no output or a polling timeout is an intermediate state, not completion.
- **Do not end the turn while an active Plannotator process has not returned a final result.**
- **Process every annotation before continuing**, then resubmit the revised plan through
  `ExitPlanMode` until it is approved.
- **No `git add`/`git commit`/PR creation as part of a review** without a direct request.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Treating an empty poll response as "review is done" | Keep waiting — empty ≠ finished |
| Ending the response while the review is still running | Keep the turn open until a final result |
| Moving on without addressing annotations | Process every annotation, resubmit |
| Committing as part of wrapping up a review | Only commit if the user explicitly asks |
