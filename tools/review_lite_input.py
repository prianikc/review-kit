import argparse, json, re, subprocess, sys

MAX_FILE_CHARS = 60_000
MAX_INPUT_CHARS = 250_000
FOCUSES = ('all', 'correctness', 'quality')


class InputError(ValueError):
    pass


def git_bytes(repo: str, *args: str) -> bytes:
    return subprocess.run(['git', '-C', repo, '-c', 'core.quotePath=false', *args], check=True, capture_output=True).stdout


def git(repo: str, *args: str) -> str:
    return git_bytes(repo, *args).decode('utf-8', errors='replace')


def split_z(data: bytes) -> list[str]:
    return [part.decode('utf-8', errors='replace') for part in data.split(b'\0') if part]


def changed_files(repo: str, base: str, head: str) -> list[str]:
    return sorted(split_z(git_bytes(repo, 'diff', '--name-only', '-z', '--no-renames', base, head)))


def tree_types(repo: str, rev: str) -> dict[str, str]:
    entries = (entry.split('\t', 1) for entry in split_z(git_bytes(repo, 'ls-tree', '-r', '-z', rev)))
    return {path: meta.split()[1] for meta, path in entries}


def binary_files(repo: str, base: str, head: str) -> set[str]:
    rows = (record.split('\t', 2) for record in split_z(git_bytes(repo, 'diff', '--numstat', '-z', '--no-renames', base, head)))
    return {row[2] for row in rows if len(row) == 3 and row[0] == '-'}


def file_states(repo: str, base: str, head: str) -> dict[str, tuple[str | None, str | None]]:
    types = tree_types(repo, head)
    binary = binary_files(repo, base, head)
    states = {}

    for path in changed_files(repo, base, head):
        if path not in types:
            states[path] = (None, 'удалён')
        elif types[path] == 'commit':
            states[path] = (None, 'сабмодуль')
        elif path in binary:
            states[path] = (None, 'бинарный')
        else:
            try:
                states[path] = (git_bytes(repo, 'show', f'{head}:{path}').decode('utf-8'), None)
            except UnicodeDecodeError:
                states[path] = (None, 'не UTF-8')

    return states


def not_attached(states: dict[str, tuple[str | None, str | None]], max_file_chars: int) -> dict[str, str]:
    return {
        path: reason or f'больше {max_file_chars} символов'
        for path, (text, reason) in states.items()
        if reason or len(text or '') > max_file_chars
    }


def fenced(text: str, lang: str = '') -> str:
    longest = max((len(run) for run in re.findall(r'`+', text)), default=0)
    fence = '`' * max(3, longest + 1)
    return f'{fence}{lang}\n{text}\n{fence}'


def files_section(states: dict[str, tuple[str | None, str | None]], max_file_chars: int) -> str:
    skipped = not_attached(states, max_file_chars)
    return '\n\n'.join(
        f'=== FILE: {path} === (не приложен: {skipped[path]})' if path in skipped else f'=== FILE: {path} ===\n{fenced(text or "")}'
        for path, (text, _) in states.items()
    )


def diff_section(repo: str, base: str, head: str, max_file_chars: int) -> str:
    parts = []

    for path in changed_files(repo, base, head):
        diff = git(repo, 'diff', '--no-color', '--no-renames', base, head, '--', path)
        parts.append(f'--- {path} (дифф не приложен: больше {max_file_chars} символов)\n' if len(diff) > max_file_chars else diff)

    return ''.join(parts)


def read_rules(repo: str, rev: str, rules: list[str]) -> dict[str, str]:
    present = tree_types(repo, rev)
    missing = [path for path in rules if path not in present]
    if missing:
        raise InputError(f'на ревизии {rev} нет файлов правил: {", ".join(missing)} (можно указать --rules-rev)')

    return {path: git(repo, 'show', f'{rev}:{path}') for path in rules}


def build_input(repo: str, base: str, head: str, rules: list[str], focus: str, prior_comments: list[dict] | None = None, max_file_chars: int = MAX_FILE_CHARS, rules_rev: str | None = None, max_input_chars: int = MAX_INPUT_CHARS, rule_texts: dict[str, str] | None = None) -> str:
    if focus not in FOCUSES:
        raise InputError(f'focus must be one of {FOCUSES}, got {focus!r}')

    texts = rule_texts if rule_texts is not None else read_rules(repo, rules_rev or head, rules)
    rules_text = '\n\n'.join(f'=== RULE FILE: {path} ===\n{fenced(text)}' for path, text in texts.items())
    diff = diff_section(repo, base, head, max_file_chars)
    files = files_section(file_states(repo, base, head), max_file_chars)
    sections = [f'## FOCUS\n{focus}', f'## RULES\n{rules_text}', f'## DIFF\n{fenced(diff, "diff")}', f'## FILES\n{files}']

    if prior_comments:
        sections.append('## PRIOR COMMENTS\n' + '\n'.join(f'- {c["path"]}:{c["line"]} — {c["body"]}' for c in prior_comments))

    text = '\n\n'.join(sections) + '\n'
    if len(text) > max_input_chars:
        raise InputError(f'вход {len(text)} символов больше лимита {max_input_chars}: ревью одним запросом не делается, нужно делить по файлам')

    return text


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', default='.')
    parser.add_argument('--base', required=True)
    parser.add_argument('--head', required=True)
    parser.add_argument('--rules', nargs='+', required=True)
    parser.add_argument('--focus', default='all')
    parser.add_argument('--rules-rev')
    parser.add_argument('--prior')
    args = parser.parse_args()

    prior = json.load(open(args.prior, encoding='utf-8')) if args.prior else None
    try:
        sys.stdout.write(build_input(args.repo, args.base, args.head, args.rules, args.focus, prior, rules_rev=args.rules_rev))
    except InputError as error:
        sys.stderr.write(f'review_lite_input: {error}\n')
        sys.exit(4)
    except subprocess.CalledProcessError as error:
        sys.stderr.write(f'review_lite_input: ревизия или путь не найдены: {" ".join(error.cmd[3:])}\n')
        sys.exit(2)


if __name__ == '__main__':
    main()
