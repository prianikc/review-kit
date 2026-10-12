import argparse, glob, json, os, shutil, subprocess, sys

VERSION_FILE = 'VERSION'
STEPS = ('copy', 'enable', 'verified', 'remove117', 'rules')
PLUGIN_DIR = '.claude/skills/review-kit'
STATE = '.claude/review-kit.installed.json'
CONFIG = '.claude/review-kit.local.json'
OLD_INSTALLED = '.claude/review-skills.installed.json'
OLD_CONFIG = '.claude/review-skills.local.json'
OLD_HISTORY = ('docs/code-review/pr-*.md', 'docs/review-fixes/pr-*.md')
OLD_LEFTOVERS = ('.review', '.fixes', '.claude/tools/check-kit-wrappers.sh', '.claude/tools/__pycache__')
OLD_DIRS = ('docs/review-fixes', '.claude/agents', '.claude/tools')
RULES_DIR = '.claude/rules/base'
RUNTIME_EXCLUDE = ('.review-kit/', '.claude/worktrees/', CONFIG, STATE, f'{RULES_DIR}/review-kit.local.md', f'{RULES_DIR}/code-review-report.local.md', f'{RULES_DIR}/agent-context.local.md')
SKIP_COPY = shutil.ignore_patterns('tests', '*.test.sh', '*.test.ts', '*.test.mjs', '__pycache__', '*.zip')


def git(repo: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True)


def is_tracked(repo: str, path: str) -> bool:
    return bool(git(repo, 'ls-files', '--', path).stdout.strip())


def exists(repo: str, path: str) -> bool:
    return os.path.lexists(os.path.join(repo, path))


def read_json(path: str, default: object) -> object:
    if not os.path.isfile(path):
        return default
    with open(path, encoding='utf-8') as source:
        return json.load(source)


def write_json(path: str, value: object) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as out:
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.write('\n')


NEW_RULE_MARK = 'Installed with review-kit 2.0'


def is_new_rule(repo: str, path: str) -> bool:
    full = os.path.join(repo, path)
    return os.path.isfile(full) and NEW_RULE_MARK in open(full, encoding='utf-8').read()


def skill_dirs(files: list[str]) -> list[str]:
    names = {path.split('/')[2] for path in files if path.startswith('.claude/skills/') and path.count('/') >= 3}
    return [f'.claude/skills/{name}' for name in sorted(names) if name != 'review-kit']


def removal(repo: str, installed: dict) -> dict:
    history = sorted(os.path.relpath(p, repo) for pattern in OLD_HISTORY for p in glob.glob(os.path.join(repo, pattern)))
    dirs = skill_dirs(installed.get('files', []))
    files = [p for p in installed.get('files', []) if not any(p.startswith(f'{d}/') for d in dirs)]
    candidates = [*dirs, *files, *installed.get('rules', []), *history, *OLD_LEFTOVERS, OLD_INSTALLED, OLD_CONFIG]
    present = list(dict.fromkeys(p for p in candidates if exists(repo, p) and not is_new_rule(repo, p)))
    tracked = [p for p in present if is_tracked(repo, p)]
    return {'remove': [p for p in present if p not in tracked], 'tracked': tracked}


def prune_empty(repo: str, dirs: list[str]) -> None:
    for path in sorted(dirs, key=len, reverse=True):
        full = os.path.join(repo, path)
        if os.path.isdir(full) and not any(files for _, _, files in os.walk(full)):
            shutil.rmtree(full)


def migrate(repo: str) -> dict:
    target = os.path.join(repo, CONFIG)
    if os.path.isfile(target):
        return read_json(target, {})
    old = read_json(os.path.join(repo, OLD_CONFIG), {})
    config = {'forgejo': old.get('forgejo', {}), 'baseBranch': (old.get('git') or {}).get('baseBranch', 'main'), 'stack': old.get('stack', [])}
    write_json(target, config)
    return config


def drop_hooks(repo: str, removed: list[str]) -> None:
    for name in ('.claude/settings.json', '.claude/settings.local.json'):
        path = os.path.join(repo, name)
        settings = read_json(path, None)
        if not isinstance(settings, dict) or 'hooks' not in settings:
            continue
        hooks = {}
        for event, groups in settings['hooks'].items():
            kept_groups = []
            for group in groups:
                kept = [h for h in group.get('hooks', []) if not any(p in h.get('command', '') for p in removed)]
                if kept:
                    kept_groups.append({**group, 'hooks': kept})
            if kept_groups:
                hooks[event] = kept_groups
        if hooks != settings['hooks']:
            write_json(path, {**settings, 'hooks': hooks})


def exclude_path(repo: str) -> str:
    return os.path.join(repo, git(repo, 'rev-parse', '--git-path', 'info/exclude').stdout.strip() or '.git/info/exclude')


def exclude_cleanup(repo: str, lines: list[str]) -> None:
    path = exclude_path(repo)
    if not os.path.isfile(path):
        return
    current = open(path, encoding='utf-8').read().splitlines()
    gone = {line for line in lines if not exists(repo, line.strip('/').lstrip('/'))}
    with open(path, 'w', encoding='utf-8') as out:
        out.write(''.join(f'{line}\n' for line in current if line not in gone))


def exclude_add(repo: str, lines: list[str]) -> None:
    path = exclude_path(repo)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    current = open(path, encoding='utf-8').read().splitlines() if os.path.isfile(path) else []
    with open(path, 'a', encoding='utf-8') as out:
        out.write(''.join(f'{line}\n' for line in lines if line not in current))


def remove_path(repo: str, path: str) -> None:
    full = os.path.join(repo, path)
    if os.path.isdir(full) and not os.path.islink(full):
        shutil.rmtree(full)
    elif os.path.lexists(full):
        os.remove(full)


def apply_step(step: str, repo: str, state: dict, source: str, place: str) -> dict:
    steps = dict(state.get('steps', {}))
    installed = read_json(os.path.join(repo, OLD_INSTALLED), {})

    if step == 'copy':
        target = os.path.join(repo, PLUGIN_DIR)
        if os.path.realpath(source) != os.path.realpath(target):
            shutil.copytree(source, target, ignore=SKIP_COPY, dirs_exist_ok=True)
        migrate(repo)
        steps['copy'] = True
    elif step == 'enable':
        exclude_add(repo, [*RUNTIME_EXCLUDE, *((f'{PLUGIN_DIR}/',) if place == 'exclude' else ())])
        steps['enable'] = True
    elif step == 'remove117' and steps.get('verified'):
        plan = removal(repo, installed)
        drop_hooks(repo, plan['remove'])
        for path in plan['remove']:
            remove_path(repo, path)
        prune_empty(repo, [*OLD_DIRS, *{os.path.dirname(p) for p in plan['remove'] if os.path.dirname(p)}])
        exclude_cleanup(repo, installed.get('exclude', []))
        steps['remove117'] = True
    elif step == 'rules' and steps.get('remove117') and not removal(repo, installed)['remove']:
        for rule in glob.glob(os.path.join(source, 'rules', '*.md')):
            os.makedirs(os.path.join(repo, RULES_DIR), exist_ok=True)
            shutil.copyfile(rule, os.path.join(repo, RULES_DIR, os.path.basename(rule)))
        steps['rules'] = True

    return {**state, 'steps': steps}


def pending(state: dict) -> list[str]:
    return [step for step in STEPS if not state.get('steps', {}).get(step)]


def version_of(source: str) -> str:
    path = os.path.join(source, VERSION_FILE)
    return open(path, encoding='utf-8').read().strip() if os.path.isfile(path) else 'dev'


def plan(repo: str, source: str, place: str) -> dict:
    installed = read_json(os.path.join(repo, OLD_INSTALLED), {})
    state = read_json(os.path.join(repo, STATE), {})
    return {**removal(repo, installed), 'migrate': os.path.isfile(os.path.join(repo, OLD_CONFIG)) and not os.path.isfile(os.path.join(repo, CONFIG)),
            'place': place, 'version': version_of(source), 'pending': pending(state)}


def apply(repo: str, source: str, place: str) -> dict:
    path = os.path.join(repo, STATE)
    state = {**read_json(path, {}), 'version': version_of(source), 'place': place}
    for step in pending(state):
        if step == 'verified':
            break
        state = apply_step(step, repo, state, source, place)
        write_json(path, state)
        if not state['steps'].get(step):
            break
    return state


def uninstall(repo: str) -> dict:
    state = read_json(os.path.join(repo, STATE), {})
    for rule in ('review-kit.local.md', 'code-review-report.local.md', 'agent-context.local.md'):
        remove_path(repo, f'{RULES_DIR}/{rule}')
    remove_path(repo, PLUGIN_DIR)
    remove_path(repo, '.review-kit')
    remove_path(repo, STATE)
    return {'removed': True, 'was': state.get('steps', {})}


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    for name in ('plan', 'apply'):
        command = sub.add_parser(name)
        command.add_argument('--source', required=True)
        command.add_argument('--place', choices=('repo', 'exclude'), default='exclude')
    sub.add_parser('verified')
    sub.add_parser('uninstall')
    parser.add_argument('--repo', default='.')
    args = parser.parse_args()

    repo = os.path.abspath(args.repo)
    try:
        if args.cmd == 'plan':
            result = plan(repo, os.path.abspath(args.source), args.place)
        elif args.cmd == 'apply':
            result = apply(repo, os.path.abspath(args.source), args.place)
        elif args.cmd == 'verified':
            path = os.path.join(repo, STATE)
            state = read_json(path, {})
            if not state.get('steps', {}).get('enable'):
                sys.stderr.write('setup: 2.0 ещё не включён — сначала /review-setup с --plugin-dir\n')
                sys.exit(3)
            result = {**state, 'steps': {**state['steps'], 'verified': True}}
            write_json(path, result)
        else:
            result = uninstall(repo)
    except (OSError, ValueError, shutil.Error) as error:
        sys.stderr.write(f'setup: {error}\n')
        sys.exit(2)

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
