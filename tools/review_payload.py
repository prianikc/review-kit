import argparse, json, re, sys

from review_lite_input import git

HUNK = re.compile(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@')
EVENTS = {'Blocked': 'REQUEST_CHANGES', 'Changes requested': 'REQUEST_CHANGES', 'Approved with comments': 'COMMENT', 'Approved': 'COMMENT'}
APPROVABLE = ('Approved', 'Approved with comments')
DEFAULT_CHANGES_BODY = 'Нужны правки — см. комментарии.'
DEFAULT_EMPTY_BODY = 'Замечаний нет.'
UNRESOLVED = ('open', 'partial')
STATUS_WORDS = {'open': 'не закрыто', 'partial': 'частично', 'unknown': 'не проверено'}
RANK = {'minor': 0, 'important': 1, 'critical': 2}


def verdict(findings: list[dict], statuses: list[dict] = ()) -> str:
    levels = {item['severity'] for item in findings} | {s.get('severity', 'important') for s in statuses if s['class'] in UNRESOLVED}
    if 'critical' in levels:
        return 'Blocked'
    if 'important' in levels:
        return 'Changes requested'

    return 'Approved with comments' if levels else 'Approved'


def at_least(findings: list[dict], severity: str) -> list[dict]:
    return [item for item in findings if RANK[item['severity']] >= RANK[severity]]


def statuses_block(statuses: list[dict], prior: list[dict]) -> str:
    place = {p['id']: f"{p['path']}:{p['line']}" if p.get('path') else 'общее' for p in prior}
    count = {name: sum(1 for s in statuses if s['class'] == name) for name in ('closed', 'open', 'partial')}
    lines = [f"- {place.get(s['id'], s['id'])} — {STATUS_WORDS[s['class']]}: {s.get('reason', '')}" for s in statuses if s['class'] in STATUS_WORDS]
    head = f"Прошлые замечания: закрыто {count['closed']}, не закрыто {count['open']}, частично {count['partial']}."
    return '\n'.join([head, *lines])


def covered_lines(diff_u0: str) -> dict[str, set[int]]:
    covered: dict[str, set[int]] = {}
    current = None

    for line in diff_u0.splitlines():
        if line.startswith('+++ '):
            current = None if line == '+++ /dev/null' else line[len('+++ b/'):]
        hunk = HUNK.match(line)
        if hunk and current:
            start, length = int(hunk.group(1)), int(hunk.group(2) or 1)
            covered.setdefault(current, set()).update(range(start, start + length))

    return covered


def build_review(selected: list[dict], texts: dict, verdict_name: str, approve: bool, covered: dict[str, set[int]]) -> dict:
    if approve and verdict_name not in APPROVABLE:
        raise ValueError(f'одобрение при вердикте {verdict_name} невозможно')

    inline = [item for item in selected if item['line'] in covered.get(item['file'], set())]
    outside = [item for item in selected if item not in inline]
    event = 'APPROVED' if approve else EVENTS[verdict_name]
    parts = [texts.get('summary', '').strip()]
    if outside:
        parts.append('Вне diff:\n' + '\n'.join(f'- {item["file"]}:{item["line"]} — {texts["comments"][item["id"]]}' for item in outside))
    body = '\n\n'.join(part for part in parts if part)

    comments = [{'path': item['file'], 'new_position': item['line'], 'body': texts['comments'][item['id']]} for item in inline]
    if not body and event == 'REQUEST_CHANGES':
        body = DEFAULT_CHANGES_BODY
    elif not body and not comments and event != 'APPROVED':
        body = DEFAULT_EMPTY_BODY

    return {'body': body, 'event': event, 'comments': comments}


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    build = sub.add_parser('build')
    for name in ('--findings', '--texts', '--base', '--head', '--ids'):
        build.add_argument(name, required=True)
    build.add_argument('--repo', default='.')
    build.add_argument('--approve', action='store_true')
    build.add_argument('--statuses')
    build.add_argument('--prior')
    build.add_argument('--min-severity', choices=tuple(RANK))
    keep = sub.add_parser('keep')
    keep.add_argument('--findings', required=True)
    keep.add_argument('--min-severity', choices=tuple(RANK), required=True)
    args = parser.parse_args()

    if args.cmd == 'keep':
        doc = json.load(open(args.findings, encoding='utf-8'))
        kept = at_least(doc['findings'], args.min_severity)
        dropped = [{'id': item['id'], 'reason': f'below-{args.min_severity}'} for item in doc['findings'] if item not in kept]
        with open(args.findings, 'w', encoding='utf-8') as out:
            json.dump({**doc, 'findings': kept, 'dropped': [*doc.get('dropped', []), *dropped]}, out, ensure_ascii=False, indent=2)
        json.dump({'kept': len(kept), 'dropped': len(dropped)}, sys.stdout)
        return

    doc = json.load(open(args.findings, encoding='utf-8'))
    findings = [*doc['findings'], *doc.get('simplify', [])]
    texts = json.load(open(args.texts, encoding='utf-8'))
    by_id = {item['id']: item for item in findings}
    ids = list(by_id) if args.ids == 'all' else [part for part in args.ids.split(',') if part]
    unknown = [i for i in ids if i not in by_id or i not in texts.get('comments', {})]
    if unknown:
        sys.stderr.write(f'review_payload: нет находки или текста для: {", ".join(unknown)}\n')
        sys.exit(2)

    selected = [by_id[i] for i in ids]
    if args.min_severity:
        selected = at_least(selected, args.min_severity)
    statuses = json.load(open(args.statuses, encoding='utf-8'))['items'] if args.statuses else []
    if statuses:
        prior = json.load(open(args.prior, encoding='utf-8'))['prior'] if args.prior else []
        texts = {**texts, 'summary': '\n\n'.join(part for part in (texts.get('summary', '').strip(), statuses_block(statuses, prior)) if part)}
    covered = covered_lines(git(args.repo, 'diff', '-U0', '--no-color', '--no-renames', args.base, args.head))
    try:
        payload = build_review(selected, texts, verdict(selected, statuses), args.approve, covered)
    except ValueError as error:
        sys.stderr.write(f'review_payload: {error}\n')
        sys.exit(2)

    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
