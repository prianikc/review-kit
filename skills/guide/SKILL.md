---
name: guide
description: Use when someone needs a short guide to what a pull request or a commit changes — to understand what they are reviewing (/guide 140, /guide 3edsf3a, «что в этом PR», «что сделано в коммите abc123»). Called by pr-review-run while its agents run; people, agents and other skills may call it too.
argument-hint: "<номер PR | id коммита>"
---

# guide

Target: `$ARGUMENTS` (or the target the caller named) — a PR number (`140`, `#140`) or a commit id or ref. No target →
ask in text «Какой PR или коммит?» and end the turn.

This is a guide, not a review: no verdict, no levels, no publishing, no files written, no tree switching.

1. `guide_prepare` with `target`. An answer starting with `review-kit:` → show it and stop.
2. The answer is `guide: <path>` and the heading line. Read the whole file with Read (in parts when it is long): the
   heading and URL, `MESSAGE` (PR description or commit message), `COMMITS`, `STAT`, `NOTES` and `DIFF`.
3. Write the guide in Russian, right in the chat, short enough to fit one screen:
   - **Heading** — the heading line, then the URL when there is one.
   - «Сообщение» — the PR description or the commit message quoted as is (`>`); empty → «описания нет». For a PR also
     the commits, `<hash> <subject>`, at most 15 (more → «и ещё N»).
   - «Что сделано» — 3–7 bullets by meaning, not file by file: what changed and what it is for, with the key files in
     backticks. Something in the diff the message does not mention, or promised in the message but missing in the diff,
     is a bullet of its own.
   - «Узкие места» — at most 5 bullets `<file>:<line> — what to look at and why`: tricky logic, error and edge cases,
     concurrency, data and migrations, security, changed public contracts, changed behaviour without tests. Nothing
     stands out → «не видно». These are pointers for the reader, not findings.
   - «Размер» — one line from `STAT`: files, `+added −removed`. Every `NOTES` entry follows; a file whose diff was not
     attached is named as not covered by the guide.
4. Called from another skill or by an agent → the guide is your whole output for this step; return to the caller.
