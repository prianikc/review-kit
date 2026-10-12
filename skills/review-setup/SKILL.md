---
name: review-setup
description: Use when installing, finishing the installation of, or removing review-kit 2.0 in a project, or when a review-kit skill stops because review_confirm is missing.
---

# review-setup

The installer is `tools/setup.py` of this plugin. `<src>` = the folder this skill was loaded from, two levels up
(the unpacked plugin). Steps are resumable: progress is in `.claude/review-kit.installed.json`.

1. `review_confirm` is not among your tools → «мод review-kit не загружен: нужен Claude Code 2.1.296 или новее и запуск с
   `--plugin-dir <папка плагина>`», stop.
2. Run exactly: `python3 <src>/tools/setup.py plan --source <src> --place exclude`
   Show in Russian: the version; what will be removed (grouped: skills, agents, tools, rules, history `pr-*.md`, `.review`/`.fixes`,
   1.17 configs) and the count; `tracked` separately — those are in git and are NOT removed, the package author removes them with
   one commit; whether Forgejo settings will be migrated; `pending` steps.
   The user asked only for a dry run (`--dry-run`) → stop here.
3. AskUserQuestion «Где держать плагин?» — «Вне git (.git/info/exclude)» → `exclude`, «В репозитории» → `repo`.
   Then AskUserQuestion «Устанавливаем?» with the plan above — «Нет» first. «Нет» → stop.
4. Run exactly: `python3 <src>/tools/setup.py apply --source <src> --place <place>`.
   - `pending` stops at `verified` → «2.0 скопирован и включён, 1.17 ещё на месте. Выйдите и запустите Claude без --plugin-dir,
     затем снова /review-setup — он проверит мод и удалит 1.17.» Stop.
5. In the session started without `--plugin-dir`, with `review_confirm` available and `verified` pending: run exactly
   `python3 .claude/skills/review-kit/tools/setup.py verified`, then
   `python3 .claude/skills/review-kit/tools/setup.py apply --source .claude/skills/review-kit --place <place from the state file>`.
   Report what was removed and that the 2.0 rules are installed; tell the user to open a new session once more so the rules load.
6. Removal of 2.0 — only on the user's explicit request: AskUserQuestion «Удалить review-kit 2.0?» («Нет» first), then
   `python3 .claude/skills/review-kit/tools/setup.py uninstall`. The 1.17 archive is reinstalled by its own installer.
