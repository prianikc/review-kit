import argparse, json, subprocess, sys

MARK = 'simplify · C не проверял'


def line_count(path: str) -> int | None:
    shown = subprocess.run(['git', 'show', f'HEAD:{path}'], capture_output=True, text=True)
    return len(shown.stdout.splitlines()) if shown.returncode == 0 else None


def add(items: list[dict], findings_path: str) -> int:
    def valid(item: dict) -> bool:
        try:
            line = int(item['line'])
        except (TypeError, ValueError, KeyError):
            return False
        count = line_count(str(item.get('file', '')))
        return str(item.get('id', '')).startswith('S-') and count is not None and 1 <= line <= count

    bad = [str(item.get('id')) for item in items if not valid(item)]
    if bad:
        sys.stderr.write(f'simplify: id не S-…, нет файла на голове PR или строка за концом файла: {", ".join(bad)}\n')
        sys.exit(2)

    doc = json.load(open(findings_path, encoding='utf-8'))
    doc['simplify'] = [{**item, 'severity': 'minor', 'confidence': None, 'mark': MARK, 'role': 'simplify'} for item in items]
    with open(findings_path, 'w', encoding='utf-8') as out:
        json.dump(doc, out, ensure_ascii=False, indent=2)
    return len(items)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    adding = sub.add_parser('add')
    adding.add_argument('--items', required=True)
    adding.add_argument('--findings', required=True)
    args = parser.parse_args()

    items = json.load(open(args.items, encoding='utf-8'))
    json.dump({'added': add(items, args.findings)}, sys.stdout)


if __name__ == '__main__':
    main()
