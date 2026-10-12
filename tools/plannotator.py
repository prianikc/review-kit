import argparse, difflib, json, os, re, sys

LEVEL = {'critical': 'Critical', 'important': 'Important', 'minor': 'Minor'}
HEADER = re.compile(r'^\[(?P<id>[^\s·\]]+) · (?:Critical|Important|Minor)(?: · \d{1,3}%)?(?: · [^\]]*)?\]$')
FILE_HEADING = re.compile(r'^## (?!#)(\S.*)$')
LINE_HEADING = re.compile(r'^### Line (\d+)(?:-\d+)? \((new|old)\)$')
START = '# Code Review Feedback'
TAILS = ('Treat the findings above', 'Do not revise or reopen the reviewed changes')
DIFF_LINE = re.compile(r'^\*\*Diff:\*\*')
FILE_COMMENT = re.compile(r'^### File Comment$')
FENCE = '```'
HUMAN = {'severity': 'minor', 'confidence': 100}
SOURCE = 'review-kit'
SIMILAR = 0.5


def header(item: dict) -> str:
    confidence = '' if item.get('confidence') is None else f" · {item['confidence']}%"
    mark = f" · {item['mark']}" if item.get('mark') else ''
    return f"[{item['id']} · {LEVEL[item['severity']]}{confidence}{mark}]"


def annotations(findings: list[dict], texts: dict) -> dict:
    comments = texts.get('comments', {})
    missing = [item['id'] for item in findings if item['id'] not in comments]
    if missing:
        raise ValueError(f'нет текста для: {", ".join(missing)}')

    return {'source': SOURCE, 'annotations': [
        {'source': SOURCE, 'filePath': item['file'], 'lineStart': item['line'], 'lineEnd': item['line'], 'text': f'{header(item)}\n{comments[item["id"]]}'}
        for item in findings
    ]}


def decision_of(stdout: str) -> dict:
    try:
        record, _ = json.JSONDecoder().raw_decode(stdout.lstrip())
    except json.JSONDecodeError as error:
        raise ValueError(f'stdout Plannotator не JSON: {error}') from error
    if not isinstance(record, dict) or record.get('decision') not in ('approved', 'annotated', 'dismissed'):
        raise ValueError(f'неизвестное решение: {record!r:.200}')

    return record


def set_body(message: str) -> str:
    start = message.find(START)
    if start < 0:
        return ''
    body = message[start + len(START):]
    cuts = [body.find(tail) for tail in TAILS if tail in body]

    return body[:min(cuts)] if cuts else body


def parse_message(message: str) -> tuple[list[dict], list[str]]:
    lines = set_body(message).splitlines()
    track_fences = sum(1 for line in lines if line.lstrip().startswith(FENCE)) % 2 == 0
    items: list[dict] = []
    general: list[str] = []
    file = None
    current = None
    fence = False

    for index, raw in enumerate(lines):
        if track_fences and current is not None and (fence or raw.lstrip().startswith(FENCE)):
            fence = fence != raw.lstrip().startswith(FENCE)
            current['lines'].append(raw)
            continue
        following = next((line for line in lines[index + 1:] if line.strip()), '')
        line_heading = LINE_HEADING.match(raw)
        file_heading = FILE_HEADING.match(raw) if LINE_HEADING.match(following) or FILE_COMMENT.match(following) else None
        if line_heading and file:
            current = {'file': file, 'line': int(line_heading.group(1)), 'side': line_heading.group(2), 'lines': []}
            items.append(current)
        elif FILE_COMMENT.match(raw) and file:
            current = {'file': file, 'line': None, 'side': 'file', 'lines': []}
            items.append(current)
        elif file_heading:
            file, current = file_heading.group(1).strip(), None
        elif current is not None:
            current['lines'].append(raw)
        elif raw.strip() and not DIFF_LINE.match(raw.strip()):
            general.append(f'{file}: {raw.strip()}' if file else raw.strip())

    return [{**item, 'text': '\n'.join(item.pop('lines')).strip()} for item in items], general


def similarity(left: str, right: str) -> float:
    return difflib.SequenceMatcher(None, left, right).ratio()


def by_line(item: dict, text: str, posted: list[dict], used: set[str], texts: dict) -> str | None:
    comments = texts.get('comments', {})
    candidates = [p for p in posted if p['file'] == item['file'] and p['line'] == item['line'] and p['id'] not in used]
    best = max(candidates, key=lambda p: similarity(text, comments.get(p['id'], '')), default=None)
    return best['id'] if best and similarity(text, comments.get(best['id'], '')) >= SIMILAR else None


def reconcile(decision: str, parsed: tuple[list[dict], list[str]], posted: list[dict], texts: dict) -> tuple[list[str], dict, dict]:
    items, general = parsed
    if decision == 'dismissed':
        return [], texts, {'findings': posted}

    by_id = {item['id']: item for item in posted}
    used: set[str] = set()
    comments: dict[str, str] = {}
    extra_findings: list[dict] = []
    human_body = [*general]

    for item in items:
        first, _, rest = item['text'].partition('\n')
        head = HEADER.match(first.strip())
        if item['side'] == 'file':
            human_body.append(f"- {item['file']} — {item['text']}")
            continue
        if item['side'] == 'old':
            human_body.append(f"- {item['file']}:{item['line']} (до изменения) — {item['text']}")
            continue
        text = rest.strip() if head else item['text']
        found = head['id'] if head and head['id'] in by_id and head['id'] not in used else by_line(item, text, posted, used, texts)
        if found:
            used.add(found)
            comments[found] = text
            continue
        human_id = f'h{len(extra_findings) + 1}'
        extra_findings.append({'id': human_id, 'file': item['file'], 'line': item['line'], **HUMAN, 'problem': text})
        comments[human_id] = text

    model_summary = texts.get('summary', '').strip() if comments else ''
    summary = '\n\n'.join(part for part in [model_summary, *human_body] if part)

    return list(comments), {'summary': summary, 'comments': comments}, {'findings': [*posted, *extra_findings]}


def fix_result(record: dict) -> tuple[dict, str]:
    items, general = parse_message(record.get('message', ''))
    lines = [*general, *(f"- {item['file']}:{item['line'] or ''} — {item['text']}" for item in items)]
    return {'decision': record['decision'], 'notes': len(lines)}, '\n'.join(lines)


def write_json(path: str, value) -> None:
    with open(path, 'w', encoding='utf-8') as out:
        json.dump(value, out, ensure_ascii=False, indent=2)


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    post = sub.add_parser('annotations')
    for name in ('--findings', '--texts', '--out'):
        post.add_argument(name, required=True)
    fix = sub.add_parser('fix-result')
    fix.add_argument('--decision-file', required=True)
    fix.add_argument('--out', required=True)
    result = sub.add_parser('result')
    for name in ('--decision-file', '--items', '--texts', '--out'):
        result.add_argument(name, required=True)
    args = parser.parse_args()

    if args.cmd == 'fix-result':
        try:
            summary, text = fix_result(decision_of(open(args.decision_file, encoding='utf-8').read()))
            os.makedirs(args.out, exist_ok=True)
            with open(os.path.join(args.out, 'feedback.md'), 'w', encoding='utf-8') as out:
                out.write(text + '\n')
        except (OSError, ValueError) as error:
            sys.stderr.write(f'plannotator: {error}\n')
            sys.exit(2)
        write_json(os.path.join(args.out, 'result.json'), summary)
        json.dump(summary, sys.stdout, ensure_ascii=False)
        return

    try:
        texts = json.load(open(args.texts, encoding='utf-8'))
        os.makedirs(args.out, exist_ok=True)
        if args.cmd == 'annotations':
            doc = json.load(open(args.findings, encoding='utf-8'))
            findings = doc['findings']
            body = annotations(findings, texts)
            write_json(os.path.join(args.out, 'items.json'), findings)
            json.dump(body, sys.stdout, ensure_ascii=False)
            return
        record = decision_of(open(args.decision_file, encoding='utf-8').read())
        posted = json.load(open(args.items, encoding='utf-8'))
        ids, new_texts, new_findings = reconcile(record['decision'], parse_message(record.get('message', '')), posted, texts)
    except (OSError, ValueError, KeyError) as error:
        sys.stderr.write(f'plannotator: {error}\n')
        sys.exit(2)

    write_json(os.path.join(args.out, 'texts.json'), new_texts)
    write_json(os.path.join(args.out, 'findings.json'), new_findings)
    summary = {'decision': record['decision'], 'ids': ids}
    write_json(os.path.join(args.out, 'result.json'), summary)
    json.dump(summary, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
