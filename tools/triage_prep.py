import argparse, glob, json, os, sys

from funnel_prep import manifest, rule_texts, stack_config, stack_skills
from review_lite_input import InputError, build_input, changed_files
from triage_finish import CLASSES, load_items


def items_section(items: list[dict]) -> str:
    blocks = []
    for item in items:
        place = f"{item['path']}:{item.get('position') or item.get('line') or ''}" if item.get('path') else 'общий'
        marks = [name for name in ('stale', 'disagree') if item.get(name)]
        suffix = f" ({', '.join(marks)})" if marks else ''
        title = f"### {item['id']} — {place} — {item.get('author', '')}{suffix}"
        blocks.append(f"{title}\n{item.get('quote') or item.get('body') or ''}")
    return '## ITEMS\n' + '\n\n'.join(blocks)


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ('--items', '--base', '--head', '--model', '--out'):
        parser.add_argument(name, required=True)
    parser.add_argument('--pr', type=int, required=True)
    parser.add_argument('--mode', choices=tuple(CLASSES), required=True)
    parser.add_argument('--repo', default='.')
    args = parser.parse_args()

    repo = os.path.abspath(args.repo)
    items = load_items(args.items)
    stack, note = stack_config(repo)
    skills = stack_skills(changed_files(repo, args.base, args.head), stack)
    texts = rule_texts(repo, skills)
    try:
        text = build_input(repo, args.base, args.head, list(texts), 'all', rule_texts=texts)
    except InputError as error:
        sys.stderr.write(f'triage_prep: {error}\n')
        sys.exit(4)

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'input.md'), 'w', encoding='utf-8') as out:
        out.write(f'{text}\n{items_section(items)}\n')
    with open(os.path.join(args.out, 'manifest-triage.txt'), 'w', encoding='utf-8') as out:
        out.write('\n'.join(manifest('triage', repo, skills, note)) + '\n')
    for stale in glob.glob(os.path.join(args.out, 'gate-*.jsonl')):
        os.remove(stale)

    out_dir = os.path.relpath(os.path.abspath(args.out), repo)
    json.dump({'pr': args.pr, 'mode': args.mode, 'input': f'{out_dir}/input.md', 'manifestDir': out_dir, 'model': args.model, 'ids': [i['id'] for i in items]}, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
