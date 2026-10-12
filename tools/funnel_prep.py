import argparse, fnmatch, glob, json, os, sys

from forgejo import ForgejoError, kit_config
from review_lite_input import InputError, build_input, changed_files

PROMPT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'skills', 'review-lite', 'prompt.md'))
FLOOR = ('AGENTS.md',)
FINDERS = ('correctness', 'quality')
CONFIG_UNAVAILABLE = 'stack: конфиг review-kit недоступен'


def stack_config(repo: str) -> tuple[list[dict] | None, str | None]:
    try:
        return kit_config(repo).get('stack', []), None
    except (ForgejoError, ValueError, AttributeError):
        return None, CONFIG_UNAVAILABLE


def stack_skills(changed: list[str], stack: list[dict] | None) -> list[str]:
    return [s['skill'] for s in stack or [] if any(fnmatch.fnmatch(f, p) for f in changed for p in s.get('paths', []))]


def rule_texts(repo: str, skills: list[str]) -> dict[str, str]:
    paths = [p for p in (*FLOOR, *skills) if os.path.isfile(os.path.join(repo, p))]
    return {p: open(os.path.join(repo, p), encoding='utf-8').read() for p in paths}


def manifest(role: str, repo: str, skills: list[str], note: str | None) -> list[str]:
    wanted = [*FLOOR, *skills]
    present = [p for p in wanted if os.path.isfile(os.path.join(repo, p))]
    notes = [note] if note else [] if skills else ['stack: изменённые пути не подходят ни под один стек']
    notes += [f'нет файла {p}' for p in wanted if p not in present]
    paths = [os.path.join(repo, p) for p in present] + ([PROMPT] if role in FINDERS else [])
    return [*sorted(set(paths)), *(f'# {n}' for n in notes)]


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ('--base', '--head', '--model', '--out'):
        parser.add_argument(name, required=True)
    parser.add_argument('--pr', type=int, required=True)
    parser.add_argument('--repo', default='.')
    args = parser.parse_args()

    repo = os.path.abspath(args.repo)
    stack, note = stack_config(repo)
    skills = stack_skills(changed_files(repo, args.base, args.head), stack)
    texts = rule_texts(repo, skills)
    try:
        text = build_input(repo, args.base, args.head, list(texts), 'all', rule_texts=texts)
    except InputError as error:
        sys.stderr.write(f'funnel_prep: {error}\n')
        sys.exit(4)

    os.makedirs(args.out, exist_ok=True)
    open(os.path.join(args.out, 'input.md'), 'w', encoding='utf-8').write(text)
    for role in (*FINDERS, 'refuter'):
        open(os.path.join(args.out, f'manifest-{role}.txt'), 'w', encoding='utf-8').write('\n'.join(manifest(role, repo, skills, note)) + '\n')
    for stale in glob.glob(os.path.join(args.out, 'gate-*.jsonl')) + glob.glob(os.path.join(args.out, 'gate.log')):
        os.remove(stale)

    out = os.path.relpath(os.path.abspath(args.out), repo)
    json.dump({'pr': args.pr, 'input': f'{out}/input.md', 'manifestDir': out, 'roles': list(FINDERS), 'model': args.model}, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
