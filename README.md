# review-kit

Плагин Claude Code для работы с pull request'ами: ревью чужих PR воронкой агентов (A ищет ошибки, B — нарушения правил
проекта, C опровергает), разбор замечаний к своему PR, раунд правок и перепроверка после своего ревью.

Поддерживаются Forgejo и Gitea. Нужны Linux, macOS или WSL и git 2.31+.

## Установка

```
/plugin marketplace add prianikc/review-kit
/plugin install review-kit@review-kit
```

Токен — переменная окружения `FORGEJO_TOKEN` (или `GITEA_TOKEN`), заданная в профиле shell (`~/.bashrc`, `~/.zshrc`).

Репозиторий определяется по `git remote get-url origin`. Для нестандартного remote — `.claude/review-kit.local.json`:

```json
{ "provider": "forgejo", "host": "git.example.org", "owner": "team", "repo": "app" }
```

Для раунда правок нужны Plannotator и плагин superpowers, для вкладок — Orca.

## Обновление

```
claude plugin marketplace update review-kit
claude plugin update review-kit@review-kit
```

## Команды

| Команда | Что делает |
|---|---|
| `/pr [N]` | открытые PR со статусами и выбор сценария; с номером — сразу сценарий для PR N |
| `/pr all` | все PR, по которым есть дело, — каждый во вкладке Orca |
| `/pr cleanup` | убрать ветки, stash и worktree законченных ревью |
| `/pr-review N` | ревью чужого PR |
| `/pr-recheck N` | перепроверка чужого PR после своего ревью |
| `/pr-feedback N` | разбор замечаний к своему PR и ответы |
| `/pr-fix N` | раунд правок своего PR: план, правки, проверка, commit и push |
| `/pr-view` | открыть находки идущего ревью в Plannotator |
| `/commit [all] [текст]` | коммит файлов сессии (или всех с `all`) с придуманным сообщением |

`stop` вместо номера (`/pr-review stop`) закрывает идущий прогон.

## Скиллы

| Скилл | Когда срабатывает |
|---|---|
| `pr-flow` | просьба словами: «посмотри PR 140», «есть что ревьюить?» |
| `pr-tab` | «открой ревью 156 во вкладке», параллельные ревью, «убери вкладку 156» |
| `pr-review-run`, `pr-recheck-run`, `pr-feedback-run`, `pr-fix-run` | запускаются командами выше, вручную не нужны |
| `commit` | только командой `/commit` |
