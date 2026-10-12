import argparse, json, os, sys

CLASSES = {'feedback': ('valid', 'invalid', 'question', 'out-of-scope'), 'recheck': ('closed', 'open', 'partial')}
FALLBACK = {'feedback': 'question', 'recheck': 'unknown'}
OUTPUT = {'feedback': 'triage.json', 'recheck': 'statuses.json'}


def answer_of(raw: dict) -> dict:
    return raw['result'] if isinstance(raw.get('result'), dict) else raw


def finish(raw: dict, items: list[dict], mode: str) -> list[dict]:
    answers = {a.get('id'): a for a in answer_of(raw).get('items', []) if isinstance(a, dict)}
    result = []
    for item in items:
        answer = answers.get(item['id'])
        if answer and answer.get('class') in CLASSES[mode]:
            fixed = {'fixed': True} if answer['class'] == 'valid' and answer.get('fixed') is True else {}
            result.append({'id': item['id'], 'class': answer['class'], 'reason': answer.get('reason', ''), **fixed, **({'evidence': answer['evidence']} if answer.get('evidence') else {})})
        else:
            result.append({'id': item['id'], 'class': FALLBACK[mode], 'reason': 'агент D не дал ответа по этому пункту'})
    return result


def load_items(path: str) -> list[dict]:
    data = json.load(open(path, encoding='utf-8'))
    return data.get('items') or data.get('prior') or []


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ('--raw', '--items', '--out'):
        parser.add_argument(name, required=True)
    parser.add_argument('--mode', choices=tuple(CLASSES), required=True)
    args = parser.parse_args()

    try:
        raw = json.load(open(args.raw, encoding='utf-8'))
        result = finish(raw, load_items(args.items), args.mode)
    except (OSError, ValueError, KeyError) as error:
        sys.stderr.write(f'triage_finish: {error}\n')
        sys.exit(6)

    path = os.path.join(args.out, OUTPUT[args.mode])
    with open(path, 'w', encoding='utf-8') as out:
        json.dump({'items': result}, out, ensure_ascii=False, indent=2)
    json.dump({'path': path, 'classes': {c: sum(1 for i in result if i['class'] == c) for c in {i['class'] for i in result}}}, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
