# Code Review Report Format — Local Rules

Installed with review-kit 2.0. The shape, verdict and levels of every review report; the reader is the PR author or the
user deciding whether to merge — they act on the verdict line first.

## Order

Verdict first (`Approved | Approved with comments | Changes requested | Blocked`) with one line of reason, then the findings
(Critical, Important, Minor), then «Подтверждено, ниже порога» when not empty, then «Не проверялось» — always present.
A recheck adds «Прошлые замечания» (закрыто / не закрыто / частично / не проверено) before the findings. Written in Russian;
rule quotes stay in the rule file's language.

## Levels and verdict

- **Critical** — breaks the product, loses data, or is exploitable → Blocked.
- **Important** — measurable regression, concrete risk, or a project-rule violation a human reviewer would send back →
  Changes requested.
- **Minor** — style, naming, preference.
- Only Minor → Approved with comments; nothing → Approved. In a recheck an `open`/`partial` earlier comment counts as Important.

## Mapping to Forgejo

- Approved and Approved with comments → `APPROVED` only after the second `review_confirm` question; otherwise `COMMENT`.
- Changes requested and Blocked → `REQUEST_CHANGES` (its body is never empty).

## Invariants

- A finding carries a failure scenario or a rule file with a verbatim quote; without one it is dropped.
- One cause, one finding, all sites. No cap on the number of findings.
- The rule quote lives in the report frame only, not in the published comment: the reader needs the substance in plain words.
- Do not report what a linter or formatter owns, generated files, or "might be slow" without a path.
- State the problem, not the author.
