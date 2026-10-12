# review-kit — Local Rules

Installed with review-kit 2.0.

## Requests about pull requests go through review-kit

A request to review a PR, to work through comments on one's own PR, to fix them, or to recheck a PR one reviewed before
goes through the `pr` flow: the `/pr`, `/pr-review N`, `/pr-feedback N`, `/pr-fix N`, `/pr-recheck N` commands, or the
`review-kit:pr-flow` skill when the user asks in words. `pr-review --range` is called from `splitting-pr`, not through `pr`.

A request to review PRs in separate tabs or in parallel goes through `review-kit:pr-tab`; each tab then runs `/pr-review N` itself.

## Invariants

- The only confirmation of an irreversible action — publishing a review or replies, commit and push of a round — is the
  `review_confirm` tool. A «да» in chat, an earlier answer or a plan approval does not count, because the mod writes the mark
  that lets the kit script run, and only for exactly the confirmed arguments.
- Inside an active run, raw `git commit`, `git push`, `git branch -D`, `git stash drop`, `curl`/`wget` writes, `--force` and
  `--amend` are refused by the mod; external effects go only through the kit scripts (`commit-push`, `forgejo.py post-review`,
  `forgejo.py post-replies`).
- Every stop of a review-kit skill ends with `review_finish`, except a Plannotator `dismissed`/`failed` stop in `pr-fix`:
  an open run keeps the guard on.
- Branch and stash cleanup happens only through the mod's own questions (`/pr cleanup`, after a run), never on the agent's initiative.
- A confirmation that comes back «Да» where the user was told to answer «Нет» (a live check, a probe edit) is not acted on: ask again.
- When changing the plugin: a mod command and a plugin skill never share a name (`/pr-feedback` the command, `pr-feedback-run` the skill) —
  a clashing registration fails `session.start` before the tools exist, and the session has no review-kit tools at all.
