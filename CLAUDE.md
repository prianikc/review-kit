# review-kit

Плагин Claude Code для работы с pull request'ами: ревью чужих PR воронкой агентов, разбор замечаний к своему PR, раунд
правок; повторное ревью учитывает историю — прошлые замечания и ответы автора. Хостинг подключается адаптером; сейчас есть только Forgejo/Gitea.

POSIX (Linux, macOS, WSL), git ≥ 2.38, Node 24. Версия — `version` в `.claude-plugin/plugin.json`.

## Устройство

| Путь | Что это |
|---|---|
| `.claude-plugin/` | манифест (`plugin.json`: версия, `userConfig`) и `marketplace.json` |
| `hooks/hooks.json` | подключает мод `mod/register.ts` |
| `mod/register.ts` | описания команды `/pr` и инструментов, подключение хуков (логика — в `mod/kit/`), хуки гейта агентов |
| `mod/kit/` | логика мода: `engine` (общие опоры), `state` (прогон), `forge` (хостинг и конфиг), `start` (старт, stash, самоочистка), `workflow` (вход агентам, сбор), `publish` (ревью, ответы, commit+push), `finish` (`review_finish`), `worktrees` (`review_worktree`), `gate`; сценарные тесты — `scenarios.test.ts` |
| `mod/testing/` | опоры тестов: `repo.ts` (git во временной папке), `engine.ts` (фейковый движок) |
| `mod/forge/` | модель хостинга (`types.ts`), выбор адаптера и токена (`index.ts`), адаптеры (`forgejo.ts`), фейк для тестов |
| `mod/status.ts` | сценарий и статус PR, intake замечаний |
| `mod/run/` | правила Claude Code для PR (`rules.ts`), вход агентам (`input.ts`), обсуждение PR (`discussion.ts`), сбор находок и триажа (`findings.ts`), тело ревью и ответы (`review.ts`), обзор и итог замечаний к своему PR (`overview.ts`) |
| `mod/guide.ts` | вход скилла `guide`: цель (PR или коммит), заголовок, сообщение, коммиты, stat, diff |
| `mod/git.ts` | переключение на PR, раунд, слияние базы, commit+push, уборка, worktree |
| `mod/manifest.ts` | чистые функции gate: роли, разбор манифеста, непрочитанные файлы |
| `funnel/` | Workflow-скрипты: `review-funnel.js` (A/B → C), `triage.js` (D) |
| `agents/` | `correctness` (A), `quality` (B), `refuter` (C), `triage` (D) |
| `skills/` | для пользователя — `guide`, `pr-flow`, `pr-confl`; внутренние (`user-invocable: false`) — `pr-review-run` (ревью и отчёт), `pr-publish-run` (публикация), `pr-feedback-run` (триаж), `pr-fix-run` (правки, commit+push), `pr-replies-run` (ответы) |
| `config/funnel.json` | пороги воронки |

Рабочие файлы прогона в целевом проекте — `.review-kit/run/<N>/`.

## Правила

- Команда мода одна — `/pr`. Новая команда мода не совпадает по имени ни с одним скиллом: конфликт роняет регистрацию мода.
- Публикация ревью и ответов, commit+push — только инструментами `review_publish`, `replies_publish`, `commit_push`;
  подтверждение они спрашивают сами, без исключений — и для расширений тоже.
- Скиллы публикуют ревью и ответы, коммитят и пушат только инструментами мода; запретов команд в ките нет — их задают
  правила проекта и окружения. Кит не знает других плагинов по имени.
- Каждая остановка скилла заканчивается `review_finish` (кроме остановок шагов 5–6 `pr-fix-run`: правки в дереве, прогон открыт).
- Ревью-кит удаляет только своё: ветку ревью, worktree ревью, папку прогона, гайды, свой stash — при завершении
  и при следующем `/pr`. Общую уборку веток и stash кит не делает.
- Находка агента без сценария отказа отбрасывается.
- Агенты A–D запускаются только своими типами (`review-kit:correctness` и т.д.) из workflow — gate висит только на них.
- Кит не зависит от других плагинов и программ и не называет их; чужие возможности — только через точки расширения.
- Всё зависящее от хостинга — только в адаптере `mod/forge/`. Новая система — новый файл адаптера, регистрация и
  тесты маппинга, без правок ядра; чего система не умеет — через `capabilities`. Исключение: переменные токена читаются
  в `mod/kit/forge.ts` (`readTokens`), потому что `$.env.get` требует литеральных имён.
- Детерминированная работа — в моде, в скилле только то, что требует суждения модели.
- Ключ состояния (`{ plugin, key }`) объявляется литералом в том файле, где вызывается `$.state` или `update`, и не
  экспортируется; модуль хуков импортирует свои файлы только статически (`claude plugin validate` это проверяет).

## Точки расширения

Контракт для других плагинов; кит их не знает по имени.

- **Публикация.** Скилл с описанием `review-kit extension: publish — <Name>. <English description>` — вариант `<Name>`
  в «Как публикуем?» (`pr-publish-run`). Перед вызовом кит пишет `texts.json` для всех находок. Расширение публикует
  `review_publish` с `source: "ext/<имя>"` (его `findings.json` и `texts.json` с `summary`) и обязательным `verdict`;
  кит спрашивает «Да/Нет». Возврат — разделы «Finish» (после `review_publish`) или «Directly» (сбой) `pr-publish-run`.
- **Проверка правок.** Скилл с описанием `review-kit extension: fix review — <Name>. <English description>` — вариант
  в «Правки PR N перед push» (`pr-fix-run` шаг 5). Возврат — шаг 6: `approved`, `annotated` + файл замечаний,
  `dismissed`/`failed`.
- **Worktree ревью.** `review_worktree` создаёт деревья и отдаёт `command` для каждого; терминал открывает расширение.
- Лимиты вариантов: публикация — не больше 2, проверка правок — не больше 1; первые по алфавиту имени скилла.
- Расширение пишет только в `.review-kit/run/<N>/ext/<имя>/`; состояние мода и остальные файлы прогона — только чтение.
- Имена разделов «Finish», «Directly» и «step 6» — часть контракта, не переименовываются.
- Файлы прогона, которые расширение читает (контракт, менять только с мажорной версией): `session.json` (`status:
  "active"` — прогон жив), `context.json` (`base`, `head`, `isOwn`, `state`), `findings.json` (`findings`, `belowBar`,
  `unconfirmed`), `texts.json` (`comments`), `hotspots.json` (`items`).

## Соглашения

- Всё, что видит пользователь, — на русском; тексты скиллов и промпты агентов — на английском.
- TS в `mod/`: без точек с запятой, одинарные кавычки, константы `UPPER_CASE` в начале файла.
- Формат отчёта ревью и вердикты — `skills/pr-review-run/SKILL.md`, раздел 2.

## Проверка и запуск

- Тесты: `node --test 'mod/**/*.test.ts' '.github/scripts/*.test.mjs'` (без зависимостей и компилятора). Валидация:
  `claude plugin validate .`.
- CI (`.github/workflows/ci.yml`) на PR и пуш в `main`: тесты, `claude plugin validate`, `version` в PR не тронута руками.
- Локально: из тестового проекта `claude --plugin-dir <путь к клону review-kit>`, токен `FORGEJO_TOKEN` в окружении.
  Проверять командой `/pr` — глобальные плагины могут перехватить «посмотри PR».

## Git

- https://github.com/prianikc/review-kit, ветка `main`.
- `version` в `.claude-plugin/plugin.json` поднимает GitHub Actions при слиянии PR в `main`
  (`.github/workflows/release.yml`), если PR менял файлы плагина: метка PR `major` или `minor`, без метки — patch;
  коммит бота в `main`, тег `vX.Y.Z` и Release. В PR `version` руками не меняется — CI проверяет. Без новой версии
  установленный плагин не обновится.
