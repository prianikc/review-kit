import argparse, json, sys

MARKER = '<!-- review-kit -->'
QUOTE_LIMIT = 200


def build(items: list[dict], replies: dict[str, str]) -> list[dict]:
    by_id = {item['id']: item for item in items}
    unknown = [i for i in replies if i not in by_id]
    if unknown:
        raise ValueError(f'нет пункта для ответа: {", ".join(unknown)}')

    return [
        {'id': i, 'kind': by_id[i]['kind'], 'reviewId': by_id[i]['reviewId'], 'path': by_id[i]['path'], 'position': by_id[i]['position'],
         'quote': (by_id[i].get('quote') or '').split('\n')[0][:QUOTE_LIMIT], 'body': f'{text.strip()}\n\n{MARKER}'}
        for i, text in replies.items() if text.strip()
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    command = sub.add_parser('build')
    command.add_argument('--items', required=True)
    command.add_argument('--replies', required=True)
    args = parser.parse_args()

    try:
        items = json.load(open(args.items, encoding='utf-8'))['items']
        payload = build(items, json.load(open(args.replies, encoding='utf-8'))['replies'])
    except (OSError, ValueError, KeyError) as error:
        sys.stderr.write(f'replies: {error}\n')
        sys.exit(2)

    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
