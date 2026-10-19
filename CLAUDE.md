# review-kit

Плагин Claude Code для работы с pull request'ами: ревью чужих PR воронкой агентов, разбор замечаний к своему PR, раунд
правок, перепроверка после своего ревью. Хостинг подключается адаптером; сейчас есть только Forgejo/Gitea.

POSIX (Linux, macOS, WSL), git ≥ 2.38, Node 24. Версия — `version` в `.claude-plugin/plugin.json`.

## Устройство

| Путь | Что это |
|---|---|
| `.claude-plugin/` | манифест (`plugin.json`: версия, `userConfig`) и `marketplace.json` |
| `hooks/hooks.json` | подключает мод `mod/register.ts` |
| `mod/register.ts` | команды `/pr…`, инструменты `review_*`, `conflict_start`, `replies_publish`, `commit_push`, хуки, состояние прогона |
| `mod/forge/` | модель хостинга (`types.ts`), выбор адаптера и токена (`index.ts`), адаптеры (`forgejo.ts`), фейк для тестов |
| `mod/status.ts` | сценарий и статус PR, intake замечаний |
| `mod/run/` | вход агентам (`input.ts`), сбор находок и триажа (`findings.ts`), тело ревью и ответы (`review.ts`) |
| `mod/git.ts` | переключение на PR, раунд, слияние базы, commit+push, уборка, worktree |
| `mod/orca.ts`, `mod/plannotator.ts` | интеграции с Orca и Plannotator |
| `mod/policy.ts` | guard прогона: запрет сырых git/curl-команд |
| `mod/gate.ts` | gate чтения манифеста агентами |
| `funnel/` | Workflow-скрипты: `review-funnel.js` (A/B → C), `triage.js` (D) |
| `agents/` | `correctness` (A), `quality` (B), `refuter` (C), `triage` (D) |
| `skills/` | `pr-flow`, `pr-review-run`, `pr-feedback-run`, `pr-fix-run`, `pr-recheck-run`, `pr-tab`, `commit`, `confl`, `push`, `merge`, `gsync` |
| `config/funnel.json` | пороги воронки |

Рабочие файлы прогона в целевом проекте — `.review-kit/run/<N>/`.

## Правила

- Имя команды мода и имя скилла не совпадают (`/pr-feedback` и `pr-feedback-run`): конфликт роняет регистрацию всего мода.
- Публикация ревью и ответов, commit+push — только инструментами `review_publish`, `replies_publish`, `commit_push`;
  подтверждение они спрашивают сами. Исключение: ревью по решению Plannotator публикуется без вопроса — решение и есть
  подтверждение («Отправить аннотации» — запрос изменений, «Approve» — одобрение).
- Внутри прогона внешние эффекты — только через инструменты мода. Исключение — ручной `/commit`: ровно `git commit`.
- Каждая остановка скилла заканчивается `review_finish` (кроме остановок Plannotator в `pr-fix-run`).
- Ветки и stash удаляются только через `/pr cleanup`.
- Находка агента без сценария отказа отбрасывается.
- Агенты A–D запускаются только своими типами (`review-kit:correctness` и т.д.) из workflow — gate висит только на них.
- Всё зависящее от хостинга — только в адаптере `mod/forge/`. Новая система — новый файл адаптера, регистрация и
  тесты маппинга, без правок ядра; чего система не умеет — через `capabilities`. Исключение: переменные токена читаются
  в `register.ts` (`readTokens`), потому что `$.env.get` требует литеральных имён.
- Детерминированная работа — в моде, в скилле только то, что требует суждения модели.

## Соглашения

- Всё, что видит пользователь, — на русском; тексты скиллов и промпты агентов — на английском.
- TS в `mod/`: без точек с запятой, одинарные кавычки, константы `UPPER_CASE` в начале файла.
- Формат отчёта ревью и вердикты — `skills/pr-review-run/SKILL.md`, раздел 2.

## Проверка и запуск

- Тесты: `node --test 'mod/**/*.test.ts'` (без зависимостей и компилятора). Валидация: `claude plugin validate .`.
- Локально: из тестового проекта `claude --plugin-dir /home/prian/projects/review-kit`, токен `FORGEJO_TOKEN` в окружении.
  Проверять явными `/pr…` командами — глобальные плагины могут перехватить «посмотри PR».

## Git

- https://github.com/prianikc/review-kit, ветка `main`.
- Каждый пуш в `main`, меняющий плагин, поднимает `version` в `.claude-plugin/plugin.json` (patch — исправление,
  minor — новое поведение), иначе установленный плагин не обновится.
